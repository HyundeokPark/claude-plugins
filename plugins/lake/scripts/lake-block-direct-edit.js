#!/usr/bin/env node
// PreToolUse hook: block direct Edit/Write/MultiEdit on lake index.json.
// AI must use `lake-cli.js upsert` (via Bash) instead.

const path = require('path');
const os = require('os');

const PROTECTED = path.join(os.homedir(), '.claude/prd-lake/index.json');

let raw = '';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const tool = payload.tool_name || payload.toolName;
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) process.exit(0);

  const input = payload.tool_input || payload.toolInput || {};
  const target = input.file_path || input.path || '';
  if (!target) process.exit(0);

  const resolved = path.resolve(target.replace(/^~/, os.homedir()));
  if (resolved !== PROTECTED) process.exit(0);

  process.stderr.write(
    'BLOCKED: ~/.claude/prd-lake/index.json must not be edited directly.\n' +
    'Use `node ~/.claude/prd-lake/lake-cli.js upsert \'<json>\'` (or done/tag/link/etc) instead.\n' +
    'For schema repair, use `lake-cli.js repair --fix`.\n'
  );
  process.exit(2);
});
