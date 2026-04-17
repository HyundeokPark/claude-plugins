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
LAKE_LEGACY=1 $CLI resume small-task-fixture > $TMP/leg.out 2> $TMP/leg.err
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
# Run the hook as a real process and inspect the emitted JSON message field.
ss_raw=$(HOME="$FAKE_HOME" TZ=UTC node "$PLUGIN_DIR/scripts/lake-session-start.js" 2>/dev/null || true)
ss_lines=$(printf '%s' "$ss_raw" | node -e "
let raw='';process.stdin.on('data',d=>raw+=d);
process.stdin.on('end',()=>{
  try {
    const j=JSON.parse(raw);
    const msg=j.message||'';
    if (!msg) { console.log(0); return; }
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
