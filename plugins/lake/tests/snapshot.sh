#!/usr/bin/env bash
# Usage: bash tests/snapshot.sh
# Runs all 17 AC checks with frozen TZ=UTC and LAKE_NOW.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GOLDEN="$SCRIPT_DIR/golden"

source "$SCRIPT_DIR/setup-fixtures.sh"
trap 'rm -rf "$FAKE_HOME"' EXIT
export HOME="$FAKE_HOME" TZ=UTC

CLI="node $PLUGIN_DIR/scripts/lake-cli.js"
PASS=0
FAIL=0
FAILS=()

pass() { PASS=$((PASS+1)); printf "  [PASS] %s\n" "$1"; }
fail() { FAIL=$((FAIL+1)); FAILS+=("$1"); printf "  [FAIL] %s\n" "$1"; }

diff_check() {
  local label="$1" actual="$2" expected="$3"
  if diff -q "$actual" "$expected" > /dev/null 2>&1; then
    pass "$label"
  else
    fail "$label - diff:"; diff "$actual" "$expected" | head -20
  fi
}

mkdir -p /tmp/lake-ac
TMP=/tmp/lake-ac

echo "=== AC-V1-Full-Byte-Identity (resume --view=full, 3 fixtures) ==="
$CLI resume small-task-fixture --view=full > $TMP/rf-s.out
$CLI resume medium-task-fixture --view=full > $TMP/rf-m.out
$CLI resume large-task-fixture --view=full > $TMP/rf-l.out
diff_check "AC-V1-Full-Byte-Identity small" $TMP/rf-s.out $GOLDEN/resume-full-small.txt
diff_check "AC-V1-Full-Byte-Identity medium" $TMP/rf-m.out $GOLDEN/resume-full-medium.txt
diff_check "AC-V1-Full-Byte-Identity large" $TMP/rf-l.out $GOLDEN/resume-full-large.txt

echo "=== AC-V1-List-Byte-Identity ==="
$CLI list > $TMP/list.out
diff_check "AC-V1-List-Byte-Identity" $TMP/list.out $GOLDEN/list-v0.txt

echo "=== AC-V1-Search-Byte-Identity (3 terms) ==="
$CLI search goal > $TMP/sg.out
$CLI search checklist > $TMP/sc.out
$CLI search blocker > $TMP/sb.out
diff_check "AC-V1-Search-Byte-Identity goal" $TMP/sg.out $GOLDEN/search-v0-goal.txt
diff_check "AC-V1-Search-Byte-Identity checklist" $TMP/sc.out $GOLDEN/search-v0-checklist.txt
diff_check "AC-V1-Search-Byte-Identity blocker" $TMP/sb.out $GOLDEN/search-v0-blocker.txt

echo "=== AC-V1-Summary-Opt-In (3 fixtures, budget + protected) ==="
for fix in small medium large; do
  $CLI resume ${fix}-task-fixture --view=summary > $TMP/rs-$fix.out
  chars=$(wc -c < $TMP/rs-$fix.out | tr -d ' ')
  lines=$(wc -l < $TMP/rs-$fix.out | tr -d ' ')
  blockers=$(grep -c "## Blockers" $TMP/rs-$fix.out || true)
  unchecked=$(grep -cE "^- \[ \]" $TMP/rs-$fix.out || true)
  blockers=${blockers:-0}
  unchecked=${unchecked:-0}
  # HARD_CHAR_CAP=12000, budget 120 lines (allow up to 130)
  if [ "$chars" -le 12000 ] && [ "$lines" -le 130 ] && [ "$blockers" -ge 1 ] && [ "$unchecked" -ge 1 ]; then
    pass "AC-V1-Summary-Opt-In $fix (chars=$chars lines=$lines blockers=$blockers unchecked=$unchecked)"
  else
    fail "AC-V1-Summary-Opt-In $fix (chars=$chars lines=$lines blockers=$blockers unchecked=$unchecked)"
  fi
done

echo "=== AC-V1-List-Compressed-Opt-In ==="
$CLI list --view=compressed > $TMP/lc.out
lines=$(wc -l < $TMP/lc.out | tr -d ' ')
trailer=$(grep -c "Showing.*inprogress" $TMP/lc.out || true)
trailer=${trailer:-0}
if [ "$lines" -le 40 ] && [ "$trailer" -ge 1 ]; then
  pass "AC-V1-List-Compressed-Opt-In (lines=$lines trailer=$trailer)"
else
  fail "AC-V1-List-Compressed-Opt-In (lines=$lines trailer=$trailer)"
fi

echo "=== AC-V1-Search-Compressed-Opt-In ==="
$CLI search goal --view=compressed > $TMP/sc-c.out
lines=$(wc -l < $TMP/sc-c.out | tr -d ' ')
overlimit=$(awk 'length > 80' $TMP/sc-c.out | wc -l | tr -d ' ')
if [ "$lines" -le 50 ] && [ "$overlimit" -eq 0 ]; then
  pass "AC-V1-Search-Compressed-Opt-In (lines=$lines overlimit=$overlimit)"
else
  fail "AC-V1-Search-Compressed-Opt-In (lines=$lines overlimit=$overlimit)"
fi

echo "=== AC-V1-Legacy-Noop ==="
# Compare against the full-view golden explicitly: the resume default view changed
# full→brief in v1.6.0, but this AC asserts LAKE_LEGACY=1 is a no-op vs the full golden.
LAKE_LEGACY=1 $CLI resume small-task-fixture --view=full > $TMP/leg.out 2> $TMP/leg.err
noop=$(grep -c "LAKE_LEGACY=1 no-op in v1" $TMP/leg.err || true)
legacy_tag=$(grep -c "\[mode=legacy\]" $TMP/leg.out || true)
noop=${noop:-0}
legacy_tag=${legacy_tag:-0}
if [ "$noop" -eq 1 ] && diff -q $TMP/leg.out $GOLDEN/resume-full-small.txt > /dev/null && [ "$legacy_tag" -eq 0 ]; then
  pass "AC-V1-Legacy-Noop"
else
  fail "AC-V1-Legacy-Noop (noop=$noop legacy_tag=$legacy_tag)"
fi

echo "=== AC-Shared-Flag-Contract-Unknown ==="
$CLI resume small-task-fixture --bogus 2> $TMP/fu.err > /dev/null || true
if grep -q "Unknown flag: --bogus" $TMP/fu.err; then
  pass "AC-Shared-Flag-Contract-Unknown"
else
  fail "AC-Shared-Flag-Contract-Unknown"
fi

echo "=== AC-Shared-Flag-Contract-Conflict ==="
$CLI resume small-task-fixture --view=summary --view=full 2> $TMP/fc.err > /dev/null || true
if grep -q "Conflicting flags" $TMP/fc.err; then
  pass "AC-Shared-Flag-Contract-Conflict"
else
  fail "AC-Shared-Flag-Contract-Conflict"
fi

echo "=== AC-Shared-Version-Stamp ==="
$CLI version > $TMP/ver.out
version_in_cli=$(grep -oE "LAKE_CLI_VERSION[[:space:]]*=[[:space:]]*['\"][^'\"]+['\"]" "$PLUGIN_DIR/scripts/lake-cli.js" | grep -oE "['\"][^'\"]+['\"]$" | tr -d "'\"")
if grep -q "lake-cli v$version_in_cli" $TMP/ver.out; then
  pass "AC-Shared-Version-Stamp (version=$version_in_cli)"
else
  fail "AC-Shared-Version-Stamp (got: $(cat $TMP/ver.out))"
fi

echo "=== AC-Shared-Cap-Overflow ==="
$CLI resume oversized-blockers-fixture --view=summary > $TMP/co.out 2> $TMP/co.err || true
cap_warning=$(grep -c "cap exceeded by protected content" $TMP/co.err || true)
blockers_in_out=$(grep -c "## Blockers" $TMP/co.out || true)
artifacts_in_out=$(grep -c "^--- Artifacts ---$" $TMP/co.out || true)
cap_warning=${cap_warning:-0}
blockers_in_out=${blockers_in_out:-0}
artifacts_in_out=${artifacts_in_out:-0}
if [ "$cap_warning" -eq 1 ] && [ "$blockers_in_out" -ge 1 ] && [ "$artifacts_in_out" -eq 0 ]; then
  pass "AC-Shared-Cap-Overflow (warn=$cap_warning blockers=$blockers_in_out artifacts=$artifacts_in_out)"
else
  fail "AC-Shared-Cap-Overflow (warn=$cap_warning blockers=$blockers_in_out artifacts=$artifacts_in_out)"
fi

echo "=== AC-Shared-SKILL-Size ==="
skill_lines=$(wc -l < "$PLUGIN_DIR/skills/lake/SKILL.md" | tr -d ' ')
if [ "$skill_lines" -le 180 ]; then
  pass "AC-Shared-SKILL-Size ($skill_lines lines)"
else
  fail "AC-Shared-SKILL-Size ($skill_lines lines)"
fi

echo "=== AC-Shared-References-Lazy (autoload: false declared) ==="
autoload_count=$(grep -l "autoload: false" "$PLUGIN_DIR/skills/lake/references/"*.md 2>/dev/null | wc -l | tr -d ' ')
if [ "$autoload_count" -eq 3 ]; then
  pass "AC-Shared-References-Lazy (3 files declare autoload: false)"
else
  fail "AC-Shared-References-Lazy ($autoload_count / 3)"
fi

echo "=== AC-Shared-SessionStart-Size ==="
# Run the hook as a real process and inspect the emitted JSON.
# Contract: user-visible text in systemMessage, AI context in hookSpecificOutput.additionalContext
# (the legacy `message` field is not part of the Claude Code hook schema and gets dropped).
ss_raw=$(HOME="$FAKE_HOME" TZ=UTC node "$PLUGIN_DIR/scripts/lake-session-start.js" 2>/dev/null || true)
ss_lines=$(printf '%s' "$ss_raw" | node -e "
let raw='';process.stdin.on('data',d=>raw+=d);
process.stdin.on('end',()=>{
  try {
    const j=JSON.parse(raw);
    const msg=j.systemMessage||'';
    const ctx=(j.hookSpecificOutput||{}).additionalContext||'';
    // additionalContext는 목록(msg) + 자동 브리핑이 붙을 수 있다 — msg로 시작하면 계약 충족
    if (!msg || !ctx.startsWith(msg)) { console.log(0); return; }
    console.log(msg.split('\n').length);
  } catch(e){ console.log('ERR:'+e.message); }
});
")
if [[ "$ss_lines" =~ ^[0-9]+$ ]] && [ "$ss_lines" -le 3 ] && [ "$ss_lines" -ge 1 ]; then
  pass "AC-Shared-SessionStart-Size ($ss_lines lines)"
else
  fail "AC-Shared-SessionStart-Size ($ss_lines)"
fi

echo "=== AC-Shared-Reminder-Interval ==="
if grep -q "60 \* 60 \* 1000" "$PLUGIN_DIR/scripts/lake-reminder.js" && grep -q "\.reminder-off" "$PLUGIN_DIR/scripts/lake-reminder.js"; then
  pass "AC-Shared-Reminder-Interval"
else
  fail "AC-Shared-Reminder-Interval"
fi

echo "=== AC-Shared-TZ-Determinism (re-run produces identical output) ==="
$CLI list > $TMP/tz1.out
$CLI list > $TMP/tz2.out
if diff -q $TMP/tz1.out $TMP/tz2.out > /dev/null; then
  pass "AC-Shared-TZ-Determinism"
else
  fail "AC-Shared-TZ-Determinism"
fi

# --- plan.md 상태 어휘 + stale 감지 (v1.9.0) ---
# 이 블록은 기존 골든 AC 뒤에 온다 — 픽스처를 추가하면 list/search 골든이 깨진다.

PLAN_LAKE="$FAKE_HOME/.claude/prd-lake"
make_plan_task() { # $1=slug  $2=plan.md 본문
  mkdir -p "$PLAN_LAKE/inprogress/$1/journal"
  printf -- '# %s\n- **Project**: t\n- **Created**: 2026-08-01\n- **Updated**: 2026-08-01\n\n## Goal\n판정 어휘 검증용.\n' "$1" \
    > "$PLAN_LAKE/inprogress/$1/spec.md"
  printf -- '# Context\n- **Branch**: main\n' > "$PLAN_LAKE/inprogress/$1/context.md"
  printf -- '%s' "$2" > "$PLAN_LAKE/inprogress/$1/plan.md"
  node -e "
const fs=require('fs');const p='$PLAN_LAKE/index.json';
const idx=JSON.parse(fs.readFileSync(p,'utf8'));
idx.push({id:'$1'.slice(0,6),slug:'$1',title:'$1',project:'t',status:'inprogress',created:'2026-08-01',updated:'2026-08-01'});
fs.writeFileSync(p,JSON.stringify(idx,null,2));"
}

echo "=== AC-Plan-Dropped-Not-Next (폐기 [-] 가 '이제 할 차례'에 안 나온다) ==="
make_plan_task plan-dropped '# Plan

## Checklist
- [x] 끝난 일
- [ ] 살아있는 할 일
- [-] (폐기 2026-08-13) 죽은 할 일 — 존재하지 않는 도구
'
$CLI resume plan-dropped > $TMP/pd.out
next_block=$(sed -n '/## ▶ 이제 할 차례/,/^$/p' $TMP/pd.out)
ok=1
printf '%s' "$next_block" | grep -q '살아있는 할 일' || ok=0
printf '%s' "$next_block" | grep -q '죽은 할 일' && ok=0
grep -q '폐기 1건 숨김' $TMP/pd.out || ok=0
# 폐기 항목은 삭제가 아니라 숨김 — full view에는 그대로 있어야 한다
$CLI resume plan-dropped --view=full | grep -q '죽은 할 일' || ok=0
if [ "$ok" = 1 ]; then pass "AC-Plan-Dropped-Not-Next"; else fail "AC-Plan-Dropped-Not-Next"; fi

echo "=== AC-Plan-Waiting-Section (대기 [~] 는 별도 섹션 + 기한 경과 경고) ==="
make_plan_task plan-waiting '# Plan

## Checklist
- [ ] 착수 가능한 일
- [~] (until: 2026-08-18) 미래 이벤트 대기
- [~] (until: 2001-01-01) 이미 지난 이벤트 대기
'
$CLI resume plan-waiting > $TMP/pw.out
next_block=$(sed -n '/## ▶ 이제 할 차례/,/^$/p' $TMP/pw.out)
ok=1
grep -q '## ⏳ 대기중' $TMP/pw.out || ok=0
printf '%s' "$next_block" | grep -q '대기' && ok=0                      # 할 일 섹션에 섞이면 안 됨
grep -q '이미 지난 이벤트 대기.*⚠ 기한 지남' $TMP/pw.out || ok=0
grep -q '미래 이벤트 대기 *$' $TMP/pw.out || ok=0                      # 미래분엔 경고 없음
if [ "$ok" = 1 ]; then pass "AC-Plan-Waiting-Section"; else fail "AC-Plan-Waiting-Section"; fi

echo "=== AC-Plan-Stale-Warning (plan.md가 journal보다 낡으면 brief 최상단 경고) ==="
make_plan_task plan-stale '# Plan

## Checklist
- [ ] 실은 폐기된 할 일
'
printf -- '# 2026-08-13\n- 실은 폐기된 할 일은 이번엔 하지 않기로 함.\n' \
  > "$PLAN_LAKE/inprogress/plan-stale/journal/2026-08-13.md"
touch -t 202608110900 "$PLAN_LAKE/inprogress/plan-stale/plan.md"
$CLI resume plan-stale > $TMP/ps.out
ok=1
head -1 $TMP/ps.out | grep -q '⚠ plan.md가 저널보다 낡음' || ok=0
head -1 $TMP/ps.out | grep -q 'plan 2026-08-11 < journal 2026-08-13' || ok=0
# 최신이면 경고가 없어야 한다 (false positive 금지)
touch "$PLAN_LAKE/inprogress/plan-stale/plan.md"
$CLI resume plan-stale | grep -q '저널보다 낡음' && ok=0
if [ "$ok" = 1 ]; then pass "AC-Plan-Stale-Warning"; else fail "AC-Plan-Stale-Warning"; fi

echo "=== AC-Plan-Check-Candidates (journal의 폐기 신호를 후보로 잡는다) ==="
make_plan_task plan-check-t '# Plan

## Checklist
- [ ] 로컬 E2E 설문 문항 설계 + 폼 작성
- [ ] 아무 근거 없는 할 일
- [x] 겹침 재확인 완료
'
printf -- '# 2026-08-13\n- E2E는 이번 설문에 합치지 않음 (존재하지 않는 도구라 가상 선호만 나옴).\n' \
  > "$PLAN_LAKE/inprogress/plan-check-t/journal/2026-08-13.md"
printf -- '# Context\n- **Branch**: main\n\n## Blockers\n- 겹침 재확인 미완\n' \
  > "$PLAN_LAKE/inprogress/plan-check-t/context.md"
$CLI plan-check plan-check-t > $TMP/pc.out
ok=1
grep -q '로컬 E2E 설문 문항 설계' $TMP/pc.out || ok=0
grep -q '폐기로 보임' $TMP/pc.out || ok=0
grep -q '아무 근거 없는 할 일' $TMP/pc.out && ok=0        # 근거 없는 항목은 후보 아님
grep -q '겹침 재확인 미완' $TMP/pc.out || ok=0            # Blockers 모순 후보
if [ "$ok" = 1 ]; then pass "AC-Plan-Check-Candidates"; else fail "AC-Plan-Check-Candidates"; fi

echo "=== AC-Plan-Legacy-Unchanged ([ ]/[x] 만 쓰는 태스크는 출력이 이전과 동일) ==="
# 하위호환 핵심. 새 마커가 없고 stale도 아니면, 신규 코드가 출력에 손대지 않아야 한다.
make_plan_task plan-legacy '# Plan

## Checklist
- [x] 옛 완료
- [ ] 옛 할 일
'
touch "$PLAN_LAKE/inprogress/plan-legacy/plan.md"
$CLI resume plan-legacy > $TMP/pl.out
ok=1
grep -q '저널보다 낡음' $TMP/pl.out && ok=0
grep -q '⏳ 대기중' $TMP/pl.out && ok=0
grep -q '폐기.*숨김' $TMP/pl.out && ok=0
grep -q '옛 할 일' $TMP/pl.out || ok=0
# 기존 골든 픽스처(신규 마커 없음)의 brief도 바이트 단위로 안 바뀌었는지 확인
$CLI resume small-task-fixture > $TMP/pl-s1.out
$CLI resume small-task-fixture --view=full > $TMP/pl-s2.out
diff -q $TMP/pl-s2.out $GOLDEN/resume-full-small.txt > /dev/null || ok=0
grep -qE '저널보다 낡음|⏳ 대기중' $TMP/pl-s1.out && ok=0
if [ "$ok" = 1 ]; then pass "AC-Plan-Legacy-Unchanged"; else fail "AC-Plan-Legacy-Unchanged"; fi

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"
if [ "$FAIL" -gt 0 ]; then
  printf "Failed ACs:\n"
  for f in "${FAILS[@]}"; do printf "  - %s\n" "$f"; done
  exit 1
fi
rm -rf $TMP
exit 0
