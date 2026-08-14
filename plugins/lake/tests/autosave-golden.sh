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

make_task() { # $1=slug
  mkdir -p "$LAKE/inprogress/$1/journal"
  printf -- '# %s\n- **Updated**: 2026-07-01 10:00\n' "$1" > "$LAKE/inprogress/$1/spec.md"
  printf -- '# Context\n- **Branch**: main\n' > "$LAKE/inprogress/$1/context.md"
  # 픽스처는 "과거에 저장된 태스크"를 흉내낸다. context.md mtime이 spool 이벤트보다
  # 최신이면 compactor가 수동 최신 보호로 auto-context를 스킵하므로 과거로 되돌린다.
  touch -t 202607011000 "$LAKE/inprogress/$1/context.md"
}

set_marker() { # $1=session_id $2=slug — 세션별 마커
  mkdir -p "$SPOOL/markers"
  printf -- '{"id":"abc123","slug":"%s","at":"%s"}\n' "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SPOOL/markers/$1.json"
}

setup_task() {
  make_task auto-task
  set_marker "$SID" auto-task
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
touch -t 202608040900 "$c"  # 직전 compactor 기록(mtime=now)을 과거로 — 덮어쓰기 경로를 검증
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/$SID.jsonl"
starts=$(grep -c 'lake:auto-context:start' "$c")
if [ "$starts" = 1 ]; then pass "AC-Compactor-Context-Idempotent"; else fail "AC-Compactor-Context-Idempotent ($starts sections)"; fi

echo "=== AC-Compactor-Unfiled (이 세션의 마커 없음 → unfiled 보존, 전역 마커도 무시) ==="
# 레거시 전역 마커가 있어도 세션별 마커가 없으면 절대 귀속시키지 않는다 (병렬 세션 오염 방지)
printf -- '{"id":"abc123","slug":"auto-task","at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LAKE/.active-task"
for i in 1 2 3; do printf '{"t":"2026-08-04T10:0%s:00Z","e":"tool","name":"Bash","in":"command=x"}\n' "$i"; done > "$SPOOL/nomark.jsonl"
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/nomark.jsonl"
if [ -f "$SPOOL/unfiled/nomark.jsonl" ]; then pass "AC-Compactor-Unfiled"; else fail "AC-Compactor-Unfiled"; fi
rm -f "$LAKE/.active-task"

echo "=== AC-Marker-Session-Isolation (병렬 세션이 각자 태스크로 귀속) ==="
make_task task-x; make_task task-y
set_marker sess-a task-x
set_marker sess-b task-y
for i in 1 2 3; do printf '{"t":"2026-08-04T14:0%s:00Z","e":"tool","name":"Bash","in":"command=a"}\n' "$i"; done > "$SPOOL/sess-a.jsonl"
for i in 1 2 3; do printf '{"t":"2026-08-04T14:0%s:00Z","e":"tool","name":"Bash","in":"command=b"}\n' "$i"; done > "$SPOOL/sess-b.jsonl"
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/sess-a.jsonl"
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/sess-b.jsonl"
today2=$(date -u +%Y-%m-%d)
ok=1
grep -q '스텁 시도' "$LAKE/inprogress/task-x/journal/$today2.md" 2>/dev/null || ok=0
grep -q '스텁 시도' "$LAKE/inprogress/task-y/journal/$today2.md" 2>/dev/null || ok=0
[ ! -f "$SPOOL/markers/sess-a.json" ] || ok=0   # 처리 후 마커 정리됨
if [ "$ok" = 1 ]; then pass "AC-Marker-Session-Isolation"; else fail "AC-Marker-Session-Isolation"; fi

echo "=== AC-Compactor-Task-Segmentation (세션 중 태스크 전환 → 구간별 귀속) ==="
make_task seg-x; make_task seg-y
{
  printf '{"t":"2026-08-05T09:00:00Z","e":"prompt","text":"탐색 시작"}\n'          # 첫 resume 이전 활동 → seg-x로 합류
  printf '{"t":"2026-08-05T09:01:00Z","e":"task","id":"x1","slug":"seg-x"}\n'
  for i in 2 3 4; do printf '{"t":"2026-08-05T09:0%s:00Z","e":"tool","name":"Bash","in":"command=x-work"}\n' "$i"; done
  printf '{"t":"2026-08-05T10:00:00Z","e":"task","id":"y1","slug":"seg-y"}\n'
  for i in 1 2 3; do printf '{"t":"2026-08-05T10:0%s:00Z","e":"tool","name":"Edit","in":"file_path=/y-work"}\n' "$i"; done
} > "$SPOOL/seg-sess.jsonl"
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/seg-sess.jsonl"
today3=$(date -u +%Y-%m-%d)
ok=1
grep -q '스텁 시도' "$LAKE/inprogress/seg-x/journal/$today3.md" 2>/dev/null || ok=0
grep -q '스텁 시도' "$LAKE/inprogress/seg-y/journal/$today3.md" 2>/dev/null || ok=0
grep -q '4 events' "$LAKE/inprogress/seg-x/journal/$today3.md" 2>/dev/null || ok=0  # pre 1 + tool 3
grep -q '3 events' "$LAKE/inprogress/seg-y/journal/$today3.md" 2>/dev/null || ok=0
[ ! -f "$SPOOL/seg-sess.jsonl" ] || ok=0
if [ "$ok" = 1 ]; then pass "AC-Compactor-Task-Segmentation"; else fail "AC-Compactor-Task-Segmentation"; fi

echo "=== AC-SessionStart-Briefing (신규 세션에 최근 태스크 상태 자동 주입) ==="
printf '[{"id":"abc123","slug":"auto-task","title":"Auto Task","project":"t","status":"inprogress","created":"2026-07-01","updated":"2026-08-05"}]\n' > "$LAKE/index.json"
brief_out=$(printf '{"session_id":"brief-sess","cwd":"/tmp"}' | HOME="$FAKE_HOME" node "$S/lake-session-start.js" 2>/dev/null)
ok=1
echo "$brief_out" | grep -q '자동 브리핑' || ok=0
echo "$brief_out" | grep -q 'Auto Task' || ok=0
echo "$brief_out" | grep -q 'resume' || ok=0        # AI에게 resume 지시 포함
echo "$brief_out" | grep -q '스텁 상태' || ok=0     # compactor가 쓴 자동 상태 섹션 내용
if [ "$ok" = 1 ]; then pass "AC-SessionStart-Briefing"; else fail "AC-SessionStart-Briefing"; fi

echo "=== AC-Cli-Marker-Per-Session (resume이 세션별 마커 기록) ==="
printf '[{"id":"abc123","slug":"auto-task","title":"Auto Task","project":"t","status":"inprogress","created":"2026-07-01","updated":"2026-07-01"}]\n' > "$LAKE/index.json"
HOME="$FAKE_HOME" CLAUDE_CODE_SESSION_ID="cli-sess-1" node "$S/lake-cli.js" resume auto-task > /dev/null 2>&1
if grep -q '"slug":"auto-task"' "$SPOOL/markers/cli-sess-1.json" 2>/dev/null; then pass "AC-Cli-Marker-Per-Session"; else fail "AC-Cli-Marker-Per-Session"; fi

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

echo "=== AC-SessionStart-Fresh-Spool-Untouched (30분 이내 spool은 살아있는 세션으로 보고 건드리지 않음) ==="
for i in 1 2 3; do printf '{"t":"2026-08-04T13:0%s:00Z","e":"tool","name":"Bash","in":"command=live"}\n' "$i"; done > "$SPOOL/live.jsonl"
printf '{"session_id":"new-session"}' | HOME="$FAKE_HOME" node "$S/lake-session-start.js" > /dev/null 2>&1
sleep 1
if [ -f "$SPOOL/live.jsonl" ]; then pass "AC-SessionStart-Fresh-Spool-Untouched"; else fail "AC-SessionStart-Fresh-Spool-Untouched"; fi

echo "=== AC-Compactor-Manual-Context-Fresher (수동 context.md가 spool보다 최신 → auto 스킵, journal은 기록) ==="
make_task fresh-ctx
set_marker fresh-sess fresh-ctx
for i in 1 2 3; do printf '{"t":"2026-08-04T15:0%s:00Z","e":"tool","name":"Bash","in":"command=old"}\n' "$i"; done > "$SPOOL/fresh-sess.jsonl"
touch "$LAKE/inprogress/fresh-ctx/context.md"   # 수동 save 흉내: spool(2026-08-04)보다 최신
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/fresh-sess.jsonl"
today4=$(date -u +%Y-%m-%d)
ok=1
grep -q 'lake:auto-context:start' "$LAKE/inprogress/fresh-ctx/context.md" 2>/dev/null && ok=0  # 덮지 않음
grep -q '스텁 시도' "$LAKE/inprogress/fresh-ctx/journal/$today4.md" 2>/dev/null || ok=0        # journal은 기록
[ ! -f "$SPOOL/fresh-sess.jsonl" ] || ok=0                                                     # spool 정리됨
if [ "$ok" = 1 ]; then pass "AC-Compactor-Manual-Context-Fresher"; else fail "AC-Compactor-Manual-Context-Fresher"; fi

echo "=== AC-SessionStart-Stale-Processing-Recovery (방치된 .processing lock → 복원) ==="
for i in 1 2 3; do printf '{"t":"2026-08-04T16:0%s:00Z","e":"tool","name":"Bash","in":"command=stuck"}\n' "$i"; done > "$SPOOL/stuck.jsonl.processing"
touch -t 202601010000 "$SPOOL/stuck.jsonl.processing"
printf '{"session_id":"new-session"}' | HOME="$FAKE_HOME" node "$S/lake-session-start.js" > /dev/null 2>&1
sleep 2
# 복원된 .jsonl은 곧바로 고아 복구가 compact할 수 있으므로 .processing 부재만 확인
if [ ! -f "$SPOOL/stuck.jsonl.processing" ]; then pass "AC-SessionStart-Stale-Processing-Recovery"; else fail "AC-SessionStart-Stale-Processing-Recovery"; fi

echo "=== AC-Plan-Stale-Briefing (SessionStart 브리핑에 plan stale 경고 주입) ==="
# 자동 기록(journal/context)은 훅이 갱신하는데 plan.md만 방치되면 다음 세션이
# 죽은 할 일을 보고한다 — 브리핑 단계에서 미리 알려야 한다.
make_task stale-plan
printf -- '# Plan\n\n## Checklist\n- [ ] 실은 폐기된 일\n' > "$LAKE/inprogress/stale-plan/plan.md"
printf -- '# 2026-08-13\n- 그 일은 하지 않기로 함.\n' > "$LAKE/inprogress/stale-plan/journal/2026-08-13.md"
touch -t 202608110900 "$LAKE/inprogress/stale-plan/plan.md"
printf '[{"id":"stale1","slug":"stale-plan","title":"Stale Plan","project":"t","status":"inprogress","created":"2026-08-01","updated":"2026-08-13"}]\n' > "$LAKE/index.json"
sp_out=$(printf '{"session_id":"stale-brief","cwd":"/tmp"}' | HOME="$FAKE_HOME" node "$S/lake-session-start.js" 2>/dev/null)
ok=1
echo "$sp_out" | grep -q 'plan.md가 저널보다 낡음' || ok=0
echo "$sp_out" | grep -q 'plan-check' || ok=0
if [ "$ok" = 1 ]; then pass "AC-Plan-Stale-Briefing"; else fail "AC-Plan-Stale-Briefing"; fi

echo "=== AC-Plan-Stale-Stop-Warning (Stop 훅이 stale 경고 1회만 낸다) ==="
set_marker stop-sess stale-plan
w1=$(printf '{"session_id":"stop-sess"}' | HOME="$FAKE_HOME" node "$S/lake-stop-save.js" 2>/dev/null)
w2=$(printf '{"session_id":"stop-sess"}' | HOME="$FAKE_HOME" node "$S/lake-stop-save.js" 2>/dev/null)
ok=1
echo "$w1" | grep -q 'plan.md가 저널보다 낡음' || ok=0
echo "$w2" | grep -q 'plan.md가 저널보다 낡음' && ok=0   # 매 턴 반복되면 아무도 안 읽는다
echo "$w2" | grep -q '"continue":true' || ok=0           # 경고 억제와 무관하게 stop은 통과
if [ "$ok" = 1 ]; then pass "AC-Plan-Stale-Stop-Warning"; else fail "AC-Plan-Stale-Stop-Warning"; fi

echo "=== AC-Plan-Dep-Deployed (lake-cli 의존 모듈이 prd-lake로 함께 배포된다) ==="
# lake-cli.js는 ~/.claude/prd-lake/로 단독 배포된다. require 대상이 같이 안 가면 lake가 죽는다.
ok=1
[ -f "$LAKE/lake-plan.js" ] || ok=0
[ -f "$LAKE/lake-recap.js" ] || ok=0
HOME="$FAKE_HOME" node "$LAKE/lake-cli.js" plan-check stale-plan > /dev/null 2>&1 || ok=0
HOME="$FAKE_HOME" node "$LAKE/lake-cli.js" resume stale-plan > /dev/null 2>&1 || ok=0
if [ "$ok" = 1 ]; then pass "AC-Plan-Dep-Deployed"; else fail "AC-Plan-Dep-Deployed"; fi

# --- 사람용 요약(📍) 수확 (v1.10.0) ---
# Claude Code가 트랜스크립트에 남긴 away_summary를 주워 spec.md에 넣는다.
# 만들지 않고 수확하는 이유: away_summary는 대화 전체를 보고 쓴 것이고,
# spool에는 도구 호출·프롬프트만 있어 같은 품질이 안 나온다.

write_transcript() { # $1=session_id  $2=cwd  $3=ts  $4=content
  local dir="$FAKE_HOME/.claude/projects/$(printf '%s' "$2" | tr '/' '-')"
  mkdir -p "$dir"
  printf '{"type":"system","subtype":"away_summary","content":"%s","timestamp":"%s","sessionId":"%s"}\n' \
    "$4" "$3" "$1" > "$dir/$1.jsonl"
}

spool_events() { # $1=session_id — 2026-08-04T10:0X 창의 이벤트 3개
  for i in 1 2 3; do
    printf '{"t":"2026-08-04T10:0%s:00Z","e":"tool","name":"Bash","in":"command=x","cwd":"/w/proj"}\n' "$i"
  done > "$SPOOL/$1.jsonl"
}

echo "=== AC-Recap-Harvest (away_summary를 spec.md 📍 섹션으로 수확) ==="
make_task recap-h; set_marker recap-sess recap-h
spool_events recap-sess
write_transcript recap-sess /w/proj 2026-08-04T10:02:30Z "작업 진행 중입니다. 검증 끝났고 다음은 배포입니다."
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/recap-sess.jsonl"
spec="$LAKE/inprogress/recap-h/spec.md"
ok=1
grep -q '## 📍 사람용 요약' "$spec" 2>/dev/null || ok=0
grep -q '작업 진행 중입니다. 검증 끝났고 다음은 배포입니다.' "$spec" 2>/dev/null || ok=0
grep -q 'lake:auto-recap' "$spec" 2>/dev/null || ok=0          # 자동 생성 표시
grep -q 'recap-written\|recap-created' "$SPOOL/compactor.log" 2>/dev/null || ok=0
# 제목 바로 아래 = 2~4행 안에 와야 한다 (메타데이터 불릿보다 위)
[ "$(grep -n '## 📍' "$spec" | cut -d: -f1)" -le 4 ] || ok=0
if [ "$ok" = 1 ]; then pass "AC-Recap-Harvest"; else fail "AC-Recap-Harvest"; fi

echo "=== AC-Recap-Window (다른 태스크 시간대의 요약은 가져오지 않는다) ==="
# 한 세션이 여러 태스크를 오갈 수 있다. 창을 안 보면 남의 상태를 적게 된다.
make_task recap-w; set_marker recapw-sess recap-w
spool_events recapw-sess
write_transcript recapw-sess /w/proj 2020-01-01T00:00:00Z "창 밖의 낡은 요약이다."
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/recapw-sess.jsonl"
ok=1
grep -q '창 밖의 낡은 요약' "$LAKE/inprogress/recap-w/spec.md" 2>/dev/null && ok=0
if [ "$ok" = 1 ]; then pass "AC-Recap-Window"; else fail "AC-Recap-Window"; fi

echo "=== AC-Recap-Fallback (away_summary 없으면 haiku RECAP 블록으로 대체) ==="
STUB2="$TMP/stub2.js"
cat > "$STUB2" <<'EOF'
process.stdin.resume();
process.stdin.on('end', () => {
  console.log('===JOURNAL===\n- 스텁 시도 → 성공\n===CONTEXT===\n현재: 스텁\n다음: 스텁\n블로커: 없음\n===RECAP===\n폴백 요약입니다. 여기까지 됐고 다음은 저것입니다.');
});
process.stdin.on('data', () => {});
EOF
make_task recap-f; set_marker recapf-sess recap-f
spool_events recapf-sess   # 트랜스크립트를 만들지 않는다 → 수확 실패
ok=1
LAKE_SUMMARIZER_CMD="node $STUB2" HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/recapf-sess.jsonl"
grep -q '폴백 요약입니다' "$LAKE/inprogress/recap-f/spec.md" 2>/dev/null || ok=0
grep -q 'recap-.*(haiku)' "$SPOOL/compactor.log" 2>/dev/null || ok=0
if [ "$ok" = 1 ]; then pass "AC-Recap-Fallback"; else fail "AC-Recap-Fallback"; fi

echo "=== AC-Recap-Manual-Kept (사람이 쓴 요약은 덮지 않는다) ==="
make_task recap-m; set_marker recapm-sess recap-m
# 마커 없는 요약 = 사람이 쓴 것
printf -- '# recap-m\n\n## 📍 사람용 요약\n사람이 직접 쓴 요약이다.\n\n- **Updated**: 2026-07-01 10:00\n' \
  > "$LAKE/inprogress/recap-m/spec.md"
spool_events recapm-sess
write_transcript recapm-sess /w/proj 2026-08-04T10:02:30Z "자동이 덮으려 한 요약."
HOME="$FAKE_HOME" node "$S/lake-compactor.js" "$SPOOL/recapm-sess.jsonl"
ok=1
grep -q '사람이 직접 쓴 요약이다' "$LAKE/inprogress/recap-m/spec.md" 2>/dev/null || ok=0
grep -q '자동이 덮으려 한 요약' "$LAKE/inprogress/recap-m/spec.md" 2>/dev/null && ok=0
grep -q 'recap-manual-kept' "$SPOOL/compactor.log" 2>/dev/null || ok=0
if [ "$ok" = 1 ]; then pass "AC-Recap-Manual-Kept"; else fail "AC-Recap-Manual-Kept"; fi

echo "=== AC-Recap-Briefing (SessionStart 브리핑이 📍를 우선 사용) ==="
printf '[{"id":"rh0001","slug":"recap-h","title":"Recap H","project":"t","status":"inprogress","created":"2026-08-01","updated":"2026-08-14"}]\n' > "$LAKE/index.json"
rb_out=$(printf '{"session_id":"rb-sess","cwd":"/tmp"}' | HOME="$FAKE_HOME" node "$S/lake-session-start.js" 2>/dev/null)
ok=1
echo "$rb_out" | grep -q '검증 끝났고 다음은 배포입니다' || ok=0
echo "$rb_out" | grep -q 'lake:auto-recap' && ok=0     # 기계용 마커는 주입하지 않는다
if [ "$ok" = 1 ]; then pass "AC-Recap-Briefing"; else fail "AC-Recap-Briefing"; fi

echo
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"
[ "$FAIL" = 0 ]
