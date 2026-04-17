#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GOLDEN_DIR="$SCRIPT_DIR/golden"
mkdir -p "$GOLDEN_DIR"
source "$SCRIPT_DIR/setup-fixtures.sh"
trap 'rm -rf "$FAKE_HOME"' EXIT

export HOME="$FAKE_HOME"
export TZ=UTC

node "$PLUGIN_DIR/scripts/lake-cli.js" resume small-task-fixture > "$GOLDEN_DIR/resume-full-small.txt"
node "$PLUGIN_DIR/scripts/lake-cli.js" resume medium-task-fixture > "$GOLDEN_DIR/resume-full-medium.txt"
node "$PLUGIN_DIR/scripts/lake-cli.js" resume large-task-fixture > "$GOLDEN_DIR/resume-full-large.txt"
node "$PLUGIN_DIR/scripts/lake-cli.js" list > "$GOLDEN_DIR/list-v0.txt"
node "$PLUGIN_DIR/scripts/lake-cli.js" search goal > "$GOLDEN_DIR/search-v0-goal.txt"
node "$PLUGIN_DIR/scripts/lake-cli.js" search checklist > "$GOLDEN_DIR/search-v0-checklist.txt"
node "$PLUGIN_DIR/scripts/lake-cli.js" search blocker > "$GOLDEN_DIR/search-v0-blocker.txt"

echo "Captured golden files:"
ls -la "$GOLDEN_DIR"
