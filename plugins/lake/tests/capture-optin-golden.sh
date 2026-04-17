#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GOLDEN_DIR="$SCRIPT_DIR/golden"
mkdir -p "$GOLDEN_DIR/flag-errors" "$GOLDEN_DIR/cap-overflow"

source "$SCRIPT_DIR/setup-fixtures.sh"
trap 'rm -rf "$FAKE_HOME"' EXIT
export HOME="$FAKE_HOME" TZ=UTC

# resume --view=summary x 3
node "$PLUGIN_DIR/scripts/lake-cli.js" resume small-task-fixture --view=summary > "$GOLDEN_DIR/resume-summary-small.txt"
node "$PLUGIN_DIR/scripts/lake-cli.js" resume medium-task-fixture --view=summary > "$GOLDEN_DIR/resume-summary-medium.txt"
node "$PLUGIN_DIR/scripts/lake-cli.js" resume large-task-fixture --view=summary > "$GOLDEN_DIR/resume-summary-large.txt"

# list compressed/tree/all
node "$PLUGIN_DIR/scripts/lake-cli.js" list --view=compressed > "$GOLDEN_DIR/list-compressed.txt"
node "$PLUGIN_DIR/scripts/lake-cli.js" list --view=tree > "$GOLDEN_DIR/list-tree.txt"
node "$PLUGIN_DIR/scripts/lake-cli.js" list --view=all > "$GOLDEN_DIR/list-all.txt"

# search compressed
node "$PLUGIN_DIR/scripts/lake-cli.js" search goal --view=compressed > "$GOLDEN_DIR/search-compressed-goal.txt"

# version
node "$PLUGIN_DIR/scripts/lake-cli.js" version > "$GOLDEN_DIR/version.txt"

# flag errors
node "$PLUGIN_DIR/scripts/lake-cli.js" resume small-task-fixture --bogus 2> "$GOLDEN_DIR/flag-errors/unknown.txt" || true
node "$PLUGIN_DIR/scripts/lake-cli.js" resume small-task-fixture --view=summary --view=full 2> "$GOLDEN_DIR/flag-errors/conflict.txt" || true

# cap-overflow (oversized-blockers fixture)
node "$PLUGIN_DIR/scripts/lake-cli.js" resume oversized-blockers-fixture --view=summary > "$GOLDEN_DIR/cap-overflow/stdout.txt" 2> "$GOLDEN_DIR/cap-overflow/stderr.txt"

echo "Captured:"
find "$GOLDEN_DIR" -type f | sort
