#!/usr/bin/env bash
# autosave-golden.sh — spool 자동 기록 + compactor 골든 테스트
# 실 LLM 호출 없음: LAKE_SUMMARIZER_CMD 스텁으로 compactor를 검증한다.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
S="$PLUGIN_DIR/scripts"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAKE_HOME="$TMP/home"
LAKE="$FAKE_HOME/.claude/prd-lake"
SPOOL="$LAKE/.spool"
SID="test-session-0001"

PASS=0; FAIL=0
pass() { echo "  [PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

setup_task() {
  mkdir -p "$LAKE/inprogress/auto-task/journal"
  printf -- '# auto-task\n- **Updated**: 2026-07-01 10:00\n' > "$LAKE/inprogress/auto-task/spec.md"
  printf -- '# Context\n- **Branch**: main\n' > "$LAKE/inprogress/auto-task/context.md"
  printf -- '{"id":"abc123","slug":"auto-task","at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LAKE/.active-task"
}

# 스텁 요약기: 프롬프트를 무시하고 고정 블록 출력
STUB="$TMP/stub.js"
cat > "$STUB" <<'EOF'
process.stdin.resume();
process.stdin.on('end', () => {
  console.log('===JOURNAL===\n- 스텁 시도 → 성공\n===CONTEXT===\n현재: 스텁 상태\n다음: 스텁 다음\n블로커: 없음');
});
process.stdin.on('data', () => {});
EOF
export LAKE_SUMMARIZER_CMD="node $STUB"

echo "=== AC-Spool-Tool-Event (PostToolUse → spool 기록) ==="
mkdir -p "$SPOOL"
printf '{"session_id":"%s","tool_name":"Bash","tool_input":{"command":"ls -la","description":"목록"},"tool_response":{"stdout":"ok"},"cwd":"/tmp"}' "$SID" \
  | HOME="$FAKE_HOME" node "$S/lake-reminder.js" > /dev/null
if grep -q '"name":"Bash"' "$SPOOL/$SID.jsonl" 2>/dev/null; then pass "AC-Spool-Tool-Event"; else fail "AC-Spool-Tool-Event"; fi

echo "=== AC-Spool-Prompt-Event (UserPromptSubmit → spool 기록) ==="
printf '{"session_id":"%s","prompt":"버그 고쳐줘","cwd":"/tmp"}' "$SID" \
  | HOME="$FAKE_HOME" node "$S/lake-intercept.js" > /dev/null
if grep -q '"e":"prompt"' "$SPOOL/$SID.jsonl" 2>/dev/null; then pass "AC-Spool-Prompt-Event"; else fail "AC-Spool-Prompt-Event"; fi

echo "=== AC-Spool-Intercept-Excluded (lake list 명령은 spool 제외) ==="
before=$(wc -l < "$SPOOL/$SID.jsonl")
printf '{"session_id":"%s","prompt":"lake list"}' "$SID" \
  | HOME="$FAKE_HOME" LAKE_CLI_PATH="$S/lake-cli.js" node "$S/lake-intercept.js" > /dev/null
after=$(wc -l < "$SPOOL/$SID.jsonl")
if [ "$before" = "$after" ]; then pass "AC-Spool-Intercept-Excluded"; else fail "AC-Spool-Intercept-Excluded"; fi

echo "=== AC-Spool-Recursion-Guard (LAKE_COMPACTOR=1 → 기록 안 함) ==="
printf '{"session_id":"guard-session","tool_name":"Read","tool_input":{"file_path":"/x"}}' \
  | HOME="$FAKE_HOME" LAKE_COMPACTOR=1 node "$S/lake-reminder.js" > /dev/null
if [ ! -f "$SPOOL/guard-session.jsonl" ]; then pass "AC-Spool-Recursion-Guard"; else fail "AC-Spool-Recursion-Guard"; fi

echo "=== AC-Compactor-Journal-Context (마커 태스크에 반영 + spool 삭제) ==="
# MIN_EVENTS(3) 충족을 위해 이벤트 하나 더 기록
printf '{"session_id":"%s","tool_name":"Edit","tool_input":{"file_path":"/tmp/a.js"}}' "$SID" \
  | HOME="$FAKE_HOME" node "$S/lake-reminder.js" > /dev/null
setup_task
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/$SID.jsonl"
today=$(date -u +%Y-%m-%d)
j="$LAKE/inprogress/auto-task/journal/$today.md"
c="$LAKE/inprogress/auto-task/context.md"
ok=1
grep -q '스텁 시도 → 성공' "$j" 2>/dev/null || ok=0
grep -q 'lake:auto-context:start' "$c" 2>/dev/null || ok=0
grep -q '현재: 스텁 상태' "$c" 2>/dev/null || ok=0
grep -q 'Branch' "$c" 2>/dev/null || ok=0   # 수동 작성분 보존
[ ! -f "$SPOOL/$SID.jsonl" ] || ok=0        # spool 삭제됨
if [ "$ok" = 1 ]; then pass "AC-Compactor-Journal-Context"; else fail "AC-Compactor-Journal-Context"; fi

echo "=== AC-Compactor-Context-Idempotent (재실행 시 auto 섹션 중복 없음) ==="
for i in 1 2 3; do printf '{"t":"2026-08-04T10:0%s:00Z","e":"tool","name":"Bash","in":"command=x"}\n' "$i"; done > "$SPOOL/$SID.jsonl"
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/$SID.jsonl"
starts=$(grep -c 'lake:auto-context:start' "$c")
if [ "$starts" = 1 ]; then pass "AC-Compactor-Context-Idempotent"; else fail "AC-Compactor-Context-Idempotent ($starts sections)"; fi

echo "=== AC-Compactor-Unfiled (마커 없음 → unfiled 보존) ==="
rm -f "$LAKE/.active-task"
for i in 1 2 3; do printf '{"t":"2026-08-04T10:0%s:00Z","e":"tool","name":"Bash","in":"command=x"}\n' "$i"; done > "$SPOOL/nomark.jsonl"
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/nomark.jsonl"
if [ -f "$SPOOL/unfiled/nomark.jsonl" ]; then pass "AC-Compactor-Unfiled"; else fail "AC-Compactor-Unfiled"; fi

echo "=== AC-Compactor-Tiny-Spool (이벤트 3개 미만 → 폐기) ==="
printf '{"t":"2026-08-04T10:00:00Z","e":"prompt","text":"hi"}\n' > "$SPOOL/tiny.jsonl"
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/tiny.jsonl"
if [ ! -f "$SPOOL/tiny.jsonl" ] && [ ! -f "$SPOOL/unfiled/tiny.jsonl" ]; then pass "AC-Compactor-Tiny-Spool"; else fail "AC-Compactor-Tiny-Spool"; fi

echo "=== AC-SessionEnd-Spawns-Compactor ==="
setup_task
for i in 1 2 3; do printf '{"t":"2026-08-04T11:0%s:00Z","e":"tool","name":"Edit","in":"file_path=/y"}\n' "$i"; done > "$SPOOL/$SID.jsonl"
printf '{"session_id":"%s"}' "$SID" | HOME="$FAKE_HOME" node "$S/lake-session-end.js" > /dev/null
sleep 2
if [ ! -f "$SPOOL/$SID.jsonl" ]; then pass "AC-SessionEnd-Spawns-Compactor"; else fail "AC-SessionEnd-Spawns-Compactor"; fi

echo "=== AC-SessionStart-Crash-Recovery (오래된 고아 spool 복구) ==="
for i in 1 2 3; do printf '{"t":"2026-08-04T12:0%s:00Z","e":"tool","name":"Write","in":"file_path=/z"}\n' "$i"; done > "$SPOOL/crashed.jsonl"
touch -t 202601010000 "$SPOOL/crashed.jsonl"
printf '{"session_id":"new-session"}' | HOME="$FAKE_HOME" node "$S/lake-session-start.js" > /dev/null 2>&1
sleep 2
if [ ! -f "$SPOOL/crashed.jsonl" ]; then pass "AC-SessionStart-Crash-Recovery"; else fail "AC-SessionStart-Crash-Recovery"; fi

echo "=== AC-SessionStart-Fresh-Spool-Untouched (2분 이내 spool은 건드리지 않음) ==="
for i in 1 2 3; do printf '{"t":"2026-08-04T13:0%s:00Z","e":"tool","name":"Bash","in":"command=live"}\n' "$i"; done > "$SPOOL/live.jsonl"
printf '{"session_id":"new-session"}' | HOME="$FAKE_HOME" node "$S/lake-session-start.js" > /dev/null 2>&1
sleep 1
if [ -f "$SPOOL/live.jsonl" ]; then pass "AC-SessionStart-Fresh-Spool-Untouched"; else fail "AC-SessionStart-Fresh-Spool-Untouched"; fi

echo
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"
[ "$FAIL" = 0 ]
