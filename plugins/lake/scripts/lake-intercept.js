#!/usr/bin/env node

/**
 * Lake Intercept Hook
 *
 * Intercepts read-only lake commands ("lake list" etc.) at UserPromptSubmit
 * and runs lake-cli directly, bypassing the LLM round-trip. Returns the result
 * via the JSON `decision: "block"` channel so the user sees clean output and
 * the LLM is never invoked for these queries.
 *
 * Latency target: <1s end-to-end (vs. ~24s when the LLM renders the same table).
 */

const { execFileSync, execSync } = require('child_process');
const { homedir } = require('os');
const path = require('path');

const LAKE_CLI = process.env.LAKE_CLI_PATH ||
  path.join(homedir(), '.claude', 'prd-lake', 'lake-cli.js');

// Build args for a filtered `lake list <filter...>` invocation. Any explicit
// --view/-v flag typed by the user wins; otherwise default view is appended.
function filterArgs(m) {
  const toks = String(m[1] || '').trim().split(/\s+/).filter(Boolean);
  const hasView = toks.some((t) => t === '-v' || t.startsWith('--view'));
  return ['list', ...toks, ...(hasView ? [] : ['--view=default'])];
}

const PATTERNS = [
  // Filtered list: "lake list nestads", "lake ls heypoll --view=all", etc.
  { regex: /^\s*\/?lake\s+(?:list|ls|l)\s+(.+?)\s*$/i, args: filterArgs },
  // Bare list.
  { regex: /^\s*\/?lake\s+(list|ls|l)\s*$/i, args: ['list', '--view=default'] },
  { regex: /^\s*\/?lake\s*$/i, args: ['list', '--view=default'] },
];

function readStdinSync(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf-8')); } };
    setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function detectCols() {
  try {
    const cols = execSync('tput cols < /dev/tty', { encoding: 'utf-8', timeout: 500 }).trim();
    if (/^\d+$/.test(cols)) return cols;
  } catch {}
  return '120';
}

async function main() {
  const raw = await readStdinSync();
  if (!raw) return;

  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  const prompt = String(payload.prompt || '').trim();
  if (!prompt) return;

  let matched = null;
  for (const p of PATTERNS) {
    const m = p.regex.exec(prompt);
    if (m) { matched = { p, m }; break; }
  }
  if (!matched) return;

  const args = typeof matched.p.args === 'function'
    ? matched.p.args(matched.m)
    : matched.p.args;

  let out;
  try {
    out = execFileSync('node', [LAKE_CLI, ...args], {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, LAKE_LIST_WIDTH: detectCols() },
    });
  } catch (e) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `[lake-intercept] lake-cli failed: ${e.message}`,
    }));
    return;
  }

  process.stdout.write(JSON.stringify({ decision: 'block', reason: out }));
}

main().catch(() => { /* fall through; empty stdout = no interception */ });
