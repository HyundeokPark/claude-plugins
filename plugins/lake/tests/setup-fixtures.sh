#!/usr/bin/env bash
# Usage: source tests/setup-fixtures.sh  (sets FAKE_HOME=tmpdir and populates prd-lake)
#        bash tests/setup-fixtures.sh    (prints FAKE_HOME= line to eval)
#        FIXTURE_DIR=/abs/path bash tests/setup-fixtures.sh  (explicit fixture dir)
set -euo pipefail

# Resolve FIXTURE_DIR: support both `source` and direct `bash` invocation
if [[ -z "${FIXTURE_DIR:-}" ]]; then
  # When called via `bash /abs/path/setup-fixtures.sh`, $0 is the script path
  # When sourced, BASH_SOURCE[0] may be empty in some shells — fall back to $0
  _SELF="${BASH_SOURCE[0]:-$0}"
  FIXTURE_DIR="$(cd "$(dirname "$_SELF")/fixtures" && pwd)"
fi

TMPDIR="${TMPDIR:-/tmp}"
export FAKE_HOME="$(mktemp -d "$TMPDIR/lake-test-XXXXXX")"
mkdir -p "$FAKE_HOME/.claude/prd-lake/inprogress" "$FAKE_HOME/.claude/prd-lake/done"
cp "$FIXTURE_DIR/index.json" "$FAKE_HOME/.claude/prd-lake/index.json"
for dir in small-task-fixture medium-task-fixture large-task-fixture oversized-blockers-fixture; do
  cp -r "$FIXTURE_DIR/$dir" "$FAKE_HOME/.claude/prd-lake/inprogress/$dir"
done
# additional inprogress + done folders from index.json (stub dirs with minimal spec.md)
node -e "
const fs=require('fs'), path=require('path');
const idx=JSON.parse(fs.readFileSync('$FAKE_HOME/.claude/prd-lake/index.json','utf8'));
for (const e of idx) {
  const base = e.status === 'done' ? 'done' : 'inprogress';
  const d = path.join('$FAKE_HOME/.claude/prd-lake', base, e.slug);
  if (fs.existsSync(d)) continue;
  fs.mkdirSync(d, {recursive:true});
  fs.writeFileSync(path.join(d,'spec.md'),'# '+e.title+'\n- **Project**: '+e.project+'\n- **Created**: '+e.created+'\n- **Updated**: '+e.updated+'\n\n## Goal\nStub for fixture.\n');
}"
echo "FAKE_HOME=$FAKE_HOME"
