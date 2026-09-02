#!/usr/bin/env node
/**
 * lake-cli.js — PRD Lake fast index CLI
 *
 * Usage:
 *   node lake-cli.js list                   # Print task table (with epic tree)
 *   node lake-cli.js find <hash-prefix>     # Find task by hash prefix, print slug
 *   node lake-cli.js resume <hash-or-slug>  # Print all files for a task (spec+plan+context+journal+artifacts)
 *   node lake-cli.js upsert <json-string>   # Add or update index entry
 *   node lake-cli.js done <hash-or-slug>    # Move task to done, update index
 *   node lake-cli.js search <keyword>       # Search across all lake files
 *   node lake-cli.js rebuild                # Rebuild index.json from disk
 *   node lake-cli.js link <parent> <child>  # Link parent-child epic
 *   node lake-cli.js unlink <parent> <child># Unlink parent-child epic
 *   node lake-cli.js tree [hash-or-slug]    # Show epic tree
 *   node lake-cli.js relate <task1> <task2> # Bidirectional relates-to link
 *   node lake-cli.js unrelate <task1> <task2># Remove relates-to link
 *   node lake-cli.js block <blocked> <blocker># Mark task as blocked by another
 *   node lake-cli.js unblock <blocked> <blocker># Remove blocked-by link
 *   node lake-cli.js summary <hash-or-slug> # One-line task summary
 *   node lake-cli.js plan-check <hash-or-slug># plan.md ↔ journal/blockers 불일치 후보 추출
 *   node lake-cli.js version                # Print version + git hash
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const planlib = require('./lake-plan');
const recaplib = require('./lake-recap');
const ctxlib = require('./lake-context');

const LAKE_DIR = path.join(process.env.HOME, '.claude', 'prd-lake');
const INDEX_PATH = path.join(LAKE_DIR, 'index.json');
const INPROGRESS_DIR = path.join(LAKE_DIR, 'inprogress');
const DONE_DIR = path.join(LAKE_DIR, 'done');

// --- Helpers ---

function generateHash(slug) {
  return crypto.createHash('sha1').update(slug).digest('hex').substring(0, 6);
}

function readIndex() {
  if (!fs.existsSync(INDEX_PATH)) return [];
  return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
}

function writeIndex(index) {
  fs.mkdirSync(LAKE_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
}

const PROJECTS_PATH = path.join(LAKE_DIR, 'projects.json');
const ACTIVE_TASK_PATH = path.join(LAKE_DIR, '.active-task');

// Records which task the current session is working on. Consumed by the Stop hook
// (updates only this task's timestamp) and the spool compactor (auto-journal target).
// Parallel sessions each get their own marker under .spool/markers/{session_id}.json
// so concurrent sessions on different tasks never contaminate each other.
// Without a session id (manual terminal use) falls back to the legacy global marker.
function touchActiveMarker(task) {
  try {
    const payload = JSON.stringify({
      id: task.id,
      slug: task.slug,
      at: new Date().toISOString(),
    }) + '\n';
    const sid = process.env.CLAUDE_CODE_SESSION_ID;
    if (sid && process.env.LAKE_COMPACTOR !== '1') {
      const markersDir = path.join(LAKE_DIR, '.spool', 'markers');
      fs.mkdirSync(markersDir, { recursive: true });
      fs.writeFileSync(path.join(markersDir, sid + '.json'), payload);
      // spool 타임라인에도 태스크 전환 이벤트를 남긴다.
      // 한 세션에서 여러 태스크를 오가면 compactor가 이 이벤트로 구간을 나눠
      // 각 구간을 맞는 태스크 journal로 보낸다 (마지막 마커가 전부 가져가는 것 방지).
      fs.appendFileSync(
        path.join(LAKE_DIR, '.spool', sid + '.jsonl'),
        JSON.stringify({ t: new Date().toISOString(), e: 'task', id: task.id, slug: task.slug }) + '\n'
      );
    } else if (!sid) {
      fs.mkdirSync(LAKE_DIR, { recursive: true });
      fs.writeFileSync(ACTIVE_TASK_PATH, payload);
    }
  } catch {
    // best-effort — never fail the command over the marker
  }
}

// Project registry (optional, per-install). Users define canonical project names + aliases
// in ~/.claude/prd-lake/projects.json so `list --project` groups cleanly and `upsert`
// normalizes free-text project values to a fixed set. Missing/invalid file → no enforcement
// (fully backward compatible). Format:
//   { "projects": ["nestads","heypoll",...], "aliases": { "nestads-deliverer": "nestads" } }
function loadProjectConfig() {
  if (!fs.existsSync(PROJECTS_PATH)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8'));
    return { projects: cfg.projects || [], aliases: cfg.aliases || {} };
  } catch {
    return null;
  }
}

// Map a raw/free-text project value to its canonical name via the registry.
// Unknown values return unchanged (never destroys data). No registry → unchanged.
function normalizeProject(raw, cfg) {
  if (!raw || !cfg) return raw;
  const val = String(raw).trim();
  if (cfg.aliases[val]) return cfg.aliases[val];
  if (cfg.projects.includes(val)) return val;
  // soft: strip parenthetical suffix, e.g. "nestads (tbls-pilot)" → "nestads"
  const base = val.split('(')[0].trim();
  if (base && base !== val) {
    if (cfg.aliases[base]) return cfg.aliases[base];
    if (cfg.projects.includes(base)) return base;
  }
  return raw;
}

function findTask(index, query) {
  // Numeric query → position in the same order as cmdList (inprogress by updated desc, top-level only)
  if (/^\d+$/.test(query)) {
    const n = parseInt(query, 10);
    const inprog = index.filter(t => t.status === 'inprogress')
      .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    const topLevel = inprog.filter(t => !t.parent);
    if (n >= 1 && n <= topLevel.length) return topLevel[n - 1];
    console.error(`번호 ${query} 범위 밖 (1-${topLevel.length})`);
    process.exit(1);
  }
  // Try hash prefix first
  let matches = index.filter(t => t.id.startsWith(query));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`Multiple hash matches for "${query}":`);
    matches.forEach(m => console.error(`  ${m.id} ${m.slug}`));
    process.exit(1);
  }
  // Try slug substring
  matches = index.filter(t => t.slug.includes(query));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`Multiple slug matches for "${query}":`);
    matches.forEach(m => console.error(`  ${m.id} ${m.slug}`));
    process.exit(1);
  }
  console.error(`No task found for "${query}"`);
  process.exit(1);
}

function taskDir(task) {
  const base = task.status === 'done' ? DONE_DIR : INPROGRESS_DIR;
  return path.join(base, task.slug);
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function daysSince(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (
      (c >= 0x1100 && c <= 0x115F) ||
      (c >= 0x2E80 && c <= 0x303E) ||
      (c >= 0x3041 && c <= 0x33FF) ||
      (c >= 0x3400 && c <= 0x4DBF) ||
      (c >= 0x4E00 && c <= 0x9FFF) ||
      (c >= 0xA000 && c <= 0xA4CF) ||
      (c >= 0xAC00 && c <= 0xD7A3) ||
      (c >= 0xF900 && c <= 0xFAFF) ||
      (c >= 0xFE30 && c <= 0xFE4F) ||
      (c >= 0xFF00 && c <= 0xFF60) ||
      (c >= 0xFFE0 && c <= 0xFFE6)
    ) w += 2;
    else w += 1;
  }
  return w;
}

function padDisplay(s, width) {
  const d = displayWidth(s);
  return s + ' '.repeat(Math.max(0, width - d));
}

function relDate(ymd) {
  const d = daysSince(ymd);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// --- Version & Flag Contract ---

const LAKE_CLI_VERSION = '1.16.2';

const VIEW_DEFAULTS = {
  // slim: 헤더 + recap 산문 + `다음:` 한 줄. brief의 기계 추출 섹션(Goal/상태/✅/▶/Blockers)은
  // plan.md·context.md가 썩는 순간 거짓말이 되는데, recap(away_summary)만은 매 세션
  // LLM이 새로 쓴 글이라 항상 맞았다 — 그래서 기본 화면을 recap 하나로 줄인다.
  // recap이 없는 태스크는 보여줄 대체재가 없으므로 기존 brief로 폴백한다.
  resume: 'slim',
  list:   'default',
  search: 'default',
};

const FLAG_SPEC = {
  resume: {
    view: ['slim', 'brief', 'summary', 'full', 'minimal', 'recap', 'files'],
    aliases: { '--slim': 'slim', '--brief': 'brief', '--full': 'full', '--minimal': 'minimal', '--recap': 'recap', '--files': 'files', '--summary': 'summary' },
  },
  list: {
    view: ['default', 'compressed', 'tree', 'all'],
    aliases: { '--tree': 'tree', '--all': 'all', '--compressed': 'compressed' },
  },
  search: {
    view: ['default', 'compressed', 'full'],
    aliases: { '--full': 'full', '--compressed': 'compressed' },
  },
};

const RESUME_SECTION_BUDGETS = {
  header:          [1,   200],
  relations:       [12, 1200],
  spec:            [22, 1800],
  plan_unresolved: [30, 2400],
  plan_resolved:   [10,  800],
  context:         [40, 2000],
  journal_head:    [20, 1200],
  artifacts:       [12,  800],
};
const HARD_CHAR_CAP = 12000;
const PROTECTED_SECTIONS = ['blockers', 'unresolved-plan-top-5', 'latest-decision', 'latest-journal-headline'];
const DROP_PRIORITY = ['journal_tail', 'artifacts', 'context_non_blocker', 'spec_body', 'plan_resolved'];

const SEARCH_MAX_RESULTS = 20;
const LIST_MAX_INPROGRESS = 15;
const LIST_MAX_DONE = 3;

const USAGE = `Usage: lake-cli.js <command> [args]
Commands: list, resume, save, done, search, summary, plan-check, version,
          link, unlink, tree, relate, unrelate, tag, untag, block, unblock, rebuild, find, upsert
Views: resume --view=slim|brief|summary|full|minimal|recap|files  (default: slim — recap 없으면 brief 폴백)
       list   --view=default|compressed|tree|all  (v1 default: default)
       search --view=default|compressed|full      (v1 default: default; v2 also default)
Flags: --limit N   --no-color   -h/--help   -v/--version
`;

function printHelp(_cmd) {
  process.stdout.write(USAGE);
}

function parseFlags(cmd, args) {
  const spec = FLAG_SPEC[cmd];
  if (!spec) return { view: null, limit: null, noColor: false, positional: args };
  const allowedView = spec.view;
  const aliases = spec.aliases || {};
  let view = null;
  let limit = null;
  let noColor = false;
  let project = null;
  const positional = [];
  const seen = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      printHelp(cmd);
      process.exit(0);
    }
    if (a === '-v' || a === '--version') {
      cmdVersion();
      process.exit(0);
    }
    if (a === '--no-color') { noColor = true; continue; }
    if (a.startsWith('--view=')) {
      const v = a.slice(7);
      if (!allowedView.includes(v)) {
        process.stderr.write(`Unknown view value: ${v}. Allowed: ${allowedView.join(', ')}.\n`);
        process.exit(2);
      }
      seen.push('--view=' + v);
      view = v;
      continue;
    }
    if (a === '--view') {
      const v = args[++i];
      if (!allowedView.includes(v)) {
        process.stderr.write(`Unknown view value: ${v}. Allowed: ${allowedView.join(', ')}.\n`);
        process.exit(2);
      }
      seen.push('--view=' + v);
      view = v;
      continue;
    }
    if (a.startsWith('--limit=')) { limit = parseInt(a.slice(8), 10); continue; }
    if (a === '--limit') { limit = parseInt(args[++i], 10); continue; }
    if (a.startsWith('--project=')) { project = a.slice(10); continue; }
    if (a === '--project') { project = args[++i]; continue; }
    if (aliases[a]) {
      seen.push('--view=' + aliases[a]);
      view = aliases[a];
      continue;
    }
    if (a.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${a}. See 'lake-cli.js help'.\n`);
      process.exit(2);
    }
    positional.push(a);
  }
  // Conflict detection: multiple distinct --view resolutions
  if (seen.length > 1) {
    const distinct = [...new Set(seen)];
    if (distinct.length > 1) {
      const allowedAliases = Object.keys(aliases).join(' ');
      const allowedList = allowedView.map(v => '--view=' + v).join(', ');
      process.stderr.write(`Conflicting flags: ${seen.join(' ')}. Pick one of: ${allowedList}${allowedAliases ? ' (aliases: ' + allowedAliases + ')' : ''}.\n`);
      process.exit(2);
    }
  }
  return { view: view || VIEW_DEFAULTS[cmd], limit, noColor, project, positional };
}

// --- Commands ---

function cmdList(rawArgs) {
  const { view, project, positional } = parseFlags('list', rawArgs);
  let index = readIndex();
  // Project filter: `list --project nestads` or positional `list nestads`.
  const want = project || positional[0];
  if (want) {
    const cfg = loadProjectConfig();
    const target = normalizeProject(want, cfg);
    index = index.filter(t => normalizeProject(t.project, cfg) === target);
  }
  switch (view) {
    case 'default':    process.stdout.write(renderListV0ByteIdentical(index)); return;
    case 'compressed': process.stdout.write(renderListCompressed(index, { noTruncate: !!want })); return;
    case 'tree':       process.stdout.write(renderListTree(index)); return;
    case 'all':        process.stdout.write(renderListAll(index)); return;
  }
}

// v1.3.2 table-format — buffer-accumulating version of cmdList from commit 47de147.
function renderListV0ByteIdentical(index) {
  let out = '';
  const inprog = index.filter(t => t.status === 'inprogress')
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  const done = index.filter(t => t.status === 'done')
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))
    .slice(0, 3);

  const topLevel = inprog.filter(t => !t.parent);
  const childMap = {};
  inprog.filter(t => t.parent).forEach(t => {
    if (!childMap[t.parent]) childMap[t.parent] = [];
    childMap[t.parent].push(t);
  });
  const parentIds = new Set(topLevel.map(t => t.id));
  const orphans = inprog.filter(t => t.parent && !parentIds.has(t.parent));

  // Build flat rows with all columns: [num, hash, title, project, date]
  let pos = 0;
  const rows = [];
  topLevel.forEach(t => {
    pos++;
    const tagStr = t.tags && t.tags.length ? '  ' + t.tags.map(x => '#' + x).join(' ') : '';
    rows.push([String(pos), t.id, t.title + tagStr, t.project, t.updated]);
    const children = (childMap[t.id] || []).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    children.forEach(c => {
      const ctagStr = c.tags && c.tags.length ? '  ' + c.tags.map(x => '#' + x).join(' ') : '';
      rows.push(['', c.id, '  └ ' + c.title + ctagStr, c.project, c.updated]);
    });
  });
  orphans.forEach(t => {
    pos++;
    const tagStr = t.tags && t.tags.length ? '  ' + t.tags.map(x => '#' + x).join(' ') : '';
    rows.push([String(pos), t.id, t.title + tagStr + ' ⚠', t.project, t.updated]);
  });

  const doneRows = done.map(t => ['✓', t.id, t.title, t.project, t.updated]);

  const header = ['#', 'hash', '제목', '프로젝트', '날짜'];

  // Terminal-width-aware ASCII table. Title column flexes to fit; other columns size to data.
  const TERM_W = parseInt(
    process.env.LAKE_LIST_WIDTH || process.env.COLUMNS ||
    (process.stderr.isTTY ? process.stderr.columns : null) ||
    (process.stdout.isTTY ? process.stdout.columns : null) || '100', 10
  );
  const truncDisplay = (s, w) => {
    s = String(s == null ? '' : s);
    if (displayWidth(s) <= w) return s;
    let acc = '', aw = 0;
    for (const ch of s) {
      const cw = displayWidth(ch);
      if (aw + cw + 1 > w) { acc += '…'; break; }
      acc += ch;
      aw += cw;
    }
    return acc;
  };
  const renderTable = (ttl, tbl) => {
    if (tbl.length === 0) return;
    const all = [header, ...tbl];
    // natural column widths (data-driven)
    const wNum = Math.max(...all.map(r => displayWidth(r[0])));
    const wHash = Math.max(...all.map(r => displayWidth(r[1])));
    const wProj = Math.max(...all.map(r => displayWidth(r[3])));
    const wDate = Math.max(...all.map(r => displayWidth(r[4])));
    const wTitleNatural = Math.max(...all.map(r => displayWidth(r[2])));
    const SEP = '  '; // 2 spaces between columns
    const fixed = wNum + wHash + wProj + wDate + SEP.length * 4;
    const wTitle = Math.max(20, Math.min(wTitleNatural, TERM_W - fixed));

    out += `[ ${ttl} (${tbl.length}) ]\n`;
    const renderRow = (r) => [
      padDisplay(r[0], wNum),
      padDisplay(r[1], wHash),
      padDisplay(truncDisplay(r[2], wTitle), wTitle),
      padDisplay(truncDisplay(r[3], wProj), wProj),
      padDisplay(r[4], wDate),
    ].join(SEP);
    out += renderRow(header) + '\n';
    out += [
      '─'.repeat(wNum), '─'.repeat(wHash), '─'.repeat(wTitle),
      '─'.repeat(wProj), '─'.repeat(wDate)
    ].join(SEP) + '\n';
    tbl.forEach(r => { out += renderRow(r) + '\n'; });
  };

  out += '\n';
  renderTable('진행중', rows);
  if (doneRows.length) { out += '\n'; renderTable('끝냄', doneRows); }
  out += '\n';
  out += `  진행중 ${inprog.length} · 완료 ${index.filter(x => x.status === 'done').length}  ·  lake resume <번호|hash|제목>\n`;
  out += '\n';
  return out;
}

function renderListCompressed(index, opts = {}) {
  let out = '';
  const inprogAll = index.filter(t => t.status === 'inprogress')
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  const topLevel = inprogAll.filter(t => !t.parent);
  const childCountByParent = {};
  let hiddenChildren = 0;
  inprogAll.filter(t => t.parent).forEach(t => {
    childCountByParent[t.parent] = (childCountByParent[t.parent] || 0) + 1;
    hiddenChildren++;
  });
  const staleCount = inprogAll.filter(t => daysSince(t.updated) >= 7).length;

  // When narrowed (e.g. --project filter), show ALL matching — truncation defeats the filter's purpose.
  const cap = opts.noTruncate ? topLevel.length : LIST_MAX_INPROGRESS;
  const topShown = topLevel.slice(0, cap);
  const hiddenStale = topLevel.slice(cap)
    .filter(t => daysSince(t.updated) >= 7).length;

  out += `In Progress (${inprogAll.length}):\n`;
  let num = 1;
  topShown.forEach(t => {
    const stale = daysSince(t.updated) >= 7 ? ' (stale)' : '';
    const tags = t.tags ? ` ${t.tags.map(x => '#' + x).join(' ')}` : '';
    const kids = childCountByParent[t.id] ? ` (+${childCountByParent[t.id]} children)` : '';
    out += `  ${num}. [${t.id}] ${t.title} (${t.project}) — Updated ${t.updated}${stale}${tags}${kids}\n`;
    num++;
  });

  const done = index.filter(t => t.status === 'done')
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))
    .slice(0, LIST_MAX_DONE);
  if (done.length > 0) {
    out += `\nDone (recent ${done.length}):\n`;
    done.forEach((t, i) => {
      out += `  ${num + i}. [${t.id}] ${t.title} (${t.project}) — Completed ${t.updated}\n`;
    });
  }

  if (topShown.length < topLevel.length || hiddenChildren > 0) {
    out += `\nShowing ${topShown.length}/${topLevel.length} inprogress (hidden: stale ${hiddenStale}, children ${hiddenChildren}). Use --view=all to disable truncation.\n`;
  }
  // Unused but could be useful later — keep staleCount available as part of trailer context.
  void staleCount;
  return out;
}

function renderListTree(index) {
  let out = '';
  const parents = index.filter(t => t.children && t.children.length > 0);
  if (parents.length === 0) {
    out += 'No epic trees found.\n';
    return out;
  }
  parents.forEach(p => {
    out += renderTreeNode(index, p, 0);
  });
  return out;
}

function renderTreeNode(index, task, depth) {
  let out = '';
  const indent = '  '.repeat(depth);
  const prefix = depth === 0 ? '📋' : '  └─';
  const stale = daysSince(task.updated) >= 7 ? ' (stale)' : '';
  const status = task.status === 'done' ? ' ✅' : '';
  out += `${indent}${prefix} [${task.id}] ${task.title} (${task.project})${status}${stale}\n`;
  if (task.children) {
    task.children.forEach(childId => {
      const child = index.find(t => t.id === childId);
      if (child) out += renderTreeNode(index, child, depth + 1);
    });
  }
  return out;
}

function renderListAll(index) {
  let out = '';
  const inprog = index.filter(t => t.status === 'inprogress')
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  const done = index.filter(t => t.status === 'done')
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  out += `In Progress (${inprog.length}):\n`;
  inprog.forEach((t, i) => {
    const stale = daysSince(t.updated) >= 7 ? ' (stale)' : '';
    const tags = t.tags ? ` ${t.tags.map(x => '#' + x).join(' ')}` : '';
    const parent = t.parent ? ` (parent: ${t.parent})` : '';
    out += `  ${i + 1}. [${t.id}] ${t.title} (${t.project}) — Updated ${t.updated}${stale}${tags}${parent}\n`;
  });
  if (done.length > 0) {
    out += `\nDone (${done.length}):\n`;
    done.forEach((t, i) => {
      out += `  ${i + 1}. [${t.id}] ${t.title} (${t.project}) — Completed ${t.updated}\n`;
    });
  } else {
    out += '\nDone: (none)\n';
  }
  return out;
}

function cmdFind(query) {
  const index = readIndex();
  const task = findTask(index, query);
  // Output JSON for easy parsing
  console.log(JSON.stringify(task));
}

function cmdResume(rawArgs) {
  const { view, positional } = parseFlags('resume', rawArgs);
  const query = positional[0];
  const index = readIndex();
  const task = findTask(index, query);
  const dir = taskDir(task);
  touchActiveMarker(task);

  const isLegacy = process.env.LAKE_LEGACY === '1';
  if (isLegacy) {
    process.stderr.write('[lake] LAKE_LEGACY=1 no-op in v1, reserved for v2+\n');
    // v1: stdout unchanged. No [mode=legacy] tag.
  }

  switch (view) {
    case 'full':    process.stdout.write(renderResumeFull(task, index, dir)); return;
    case 'slim':    process.stdout.write(renderResumeSlim(task, index, dir)); return;
    case 'brief':   process.stdout.write(renderResumeBrief(task, index, dir)); return;
    case 'summary': process.stdout.write(renderResumeSummary(task, index, dir)); return;
    case 'minimal':
    case 'recap':   process.stdout.write(renderResumeMinimal(task, index, dir)); return;
    case 'files':   process.stdout.write(renderResumeFiles(task, index, dir)); return;
  }
}

// v0 byte-identical — preserves the original cmdResume console.log behavior exactly.
function renderResumeFull(task, index, dir) {
  let out = '';
  out += `=== Loading previous work: ${task.title} [${task.id}] ===\n\n`;

  // Show epic links
  if (task.parent) {
    const parent = index.find(t => t.id === task.parent);
    if (parent) out += `📋 Parent: [${parent.id}] ${parent.title}\n\n`;
  }
  if (task.children && task.children.length > 0) {
    out += '📋 Children:\n';
    task.children.forEach(cid => {
      const child = index.find(t => t.id === cid);
      if (child) {
        const status = child.status === 'done' ? ' ✅' : '';
        out += `  └─ [${child.id}] ${child.title}${status}\n`;
      }
    });
    out += '\n';
  }
  if (task.relates && task.relates.length > 0) {
    out += '🔗 Relates to:\n';
    task.relates.forEach(rid => {
      const rel = index.find(t => t.id === rid);
      if (rel) out += `  ↔ [${rel.id}] ${rel.title}\n`;
    });
    out += '\n';
  }
  if (task.blocked_by && task.blocked_by.length > 0) {
    out += '🚫 Blocked by:\n';
    task.blocked_by.forEach(bid => {
      const b = index.find(t => t.id === bid);
      if (b) {
        const done = b.status === 'done' ? ' ✅' : '';
        out += `  ← [${b.id}] ${b.title}${done}\n`;
      }
    });
    out += '\n';
  }
  if (task.blocks && task.blocks.length > 0) {
    out += '⏳ Blocks:\n';
    task.blocks.forEach(bid => {
      const b = index.find(t => t.id === bid);
      if (b) out += `  → [${b.id}] ${b.title}\n`;
    });
    out += '\n';
  }
  if (task.tags && task.tags.length > 0) {
    out += `🏷️  Tags: ${task.tags.map(t => `#${t}`).join(' ')}\n\n`;
  }

  const spec = readFileSafe(path.join(dir, 'spec.md'));
  if (spec) { out += '--- Spec ---\n'; out += spec + '\n'; }

  const plan = readFileSafe(path.join(dir, 'plan.md'));
  if (plan) { out += '--- Plan ---\n'; out += plan + '\n'; }

  const context = readFileSafe(path.join(dir, 'context.md'));
  if (context) { out += '--- Context ---\n'; out += context + '\n'; }

  // Latest journal
  const journalDir = path.join(dir, 'journal');
  if (fs.existsSync(journalDir)) {
    const journals = fs.readdirSync(journalDir).filter(f => f.endsWith('.md')).sort().reverse();
    if (journals.length > 0) {
      const latest = readFileSafe(path.join(journalDir, journals[0]));
      if (latest) {
        out += `--- Journal (${journals[0].replace('.md', '')}) ---\n`;
        out += latest + '\n';
      }
    }
  }

  // Artifacts
  const artifacts = readFileSafe(path.join(dir, 'artifacts', 'INDEX.md'));
  if (artifacts) { out += '--- Artifacts ---\n'; out += artifacts + '\n'; }

  return out;
}

// 사람용 요약(📍) — spec.md 맨 위 섹션. Claude Code의 away_summary를 compactor가
// 수확해 넣거나 사람이 직접 쓴다. 파싱 규칙은 lake-recap.js 하나만 쓴다 —
// 같은 규칙을 여러 곳에 복사하면 형식이 어긋날 때 한쪽만 고쳐진다.
function extractSpecHumanRecap(specText) {
  return recaplib.extractFromSpec(specText);
}

// Extract spec Goal section, or fall back to frontmatter + next 20 lines
function extractSpecGoal(specText) {
  if (!specText) return '';
  // 한글 문서가 많아 `## 목표`도 같은 것으로 취급한다. 못 찾으면 앞부분을 통째로
  // 붙이는 폴백이 도는데, 그게 20줄 넘게 쏟아져 "정보 과다" 불만의 직접 원인이었다.
  const goalMatch = specText.match(/(^|\n)## (?:Goal|목표)\s*\n([\s\S]*?)(?=\n## |\n# |$)/);
  if (goalMatch) {
    return '## Goal\n' + goalMatch[2].trim() + '\n';
  }
  // Fallback: 앞부분을 사람이 읽을 분량으로만 자른다.
  // 📍 요약은 브리프 맨 위에서 이미 보여준다. 원문을 그대로 자르면 그 섹션과
  // `<!-- lake:auto-recap -->` 마커까지 딸려 들어와 같은 문장이 두 번 나온다.
  const lines = recaplib.stripRecapFromSpec(specText).split('\n');
  // 제목(`# ...`)과 메타 불릿(Project/Status/…)은 브리프 헤더 줄(=== 제목 [id] · status ===)과
  // 중복이다 — 걷어내지 않으면 같은 정보가 두 벌 쏟아져 화면이 안 읽힌다.
  let skip = 0;
  while (skip < lines.length && (
    lines[skip].trim() === '' ||
    /^#\s/.test(lines[skip]) ||
    /^-\s*\*{0,2}(Project|Status|Created|Updated|Tags)\*{0,2}\s*:/i.test(lines[skip])
  )) skip++;
  const head = lines.slice(skip, skip + 10);
  // 10줄에서 기계적으로 끊으므로 끝에 내용 없는 헤딩만 남거나(`## 배경`),
  // 섹션을 걷어낸 자리에 빈 줄이 겹쳐 남는다. 화면에 나가기 전에 정리한다.
  while (head.length && (head[head.length - 1].trim() === '' || /^#{1,6}\s/.test(head[head.length - 1]))) {
    head.pop();
  }
  return head.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

function extractBlockersSection(contextText) {
  if (!contextText) return '';
  const m = contextText.match(/(^|\n)## Blockers\s*\n([\s\S]*?)(?=\n## |\n# |$)/);
  if (!m) return '';
  // compactor의 `<!-- lake:auto-context:start -->` 마커가 Blockers와 그 다음 헤딩 사이에
  // 있으면 여기까지 같이 빨려 들어와 사용자 화면에 주석이 새어나온다.
  const body = m[2].split('\n').filter(line => !/^\s*<!--/.test(line)).join('\n');
  return '## Blockers\n' + body.trimEnd() + '\n';
}

function extractLatestDecision(contextText) {
  if (!contextText) return '';
  const m = contextText.match(/(^|\n)## Decisions\s*\n([\s\S]*?)(?=\n## |\n# |$)/);
  if (!m) return '';
  const body = m[2].trim();
  const firstBullet = body.split(/\n(?=- )/)[0];
  return firstBullet ? firstBullet.trim() + '\n' : '';
}

function extractLatestJournalHeadline(journalText) {
  if (!journalText) return '';
  const lines = journalText.split('\n');
  // Take first non-empty heading + up to 3 following lines
  const result = [];
  let started = false;
  let taken = 0;
  for (const line of lines) {
    if (!started && line.trim() === '') continue;
    if (!started) { result.push(line); started = true; continue; }
    if (taken >= 3) break;
    result.push(line);
    taken++;
  }
  return result.join('\n') + '\n';
}

// 착수 가능(`- [ ]`) 항목을 모은다.
//
// 왜 파일 순서만으로는 부족한가: brief는 여기서 위 3개만 집는다. 그런데 plan.md는
// 시간순으로 덧붙여 쓰는 문서라 "이번 주 최우선"이 6번째 줄에 깔리는 일이 생긴다.
// 실제로 그렇게 잘려서 사람이 곁가지 3건을 '지금 할 일'로 읽는 사고가 났다.
// 그래서 항목 맨 앞의 `★N` 마커를 우선순위로 인정한다 — `- [ ] ★1 ...` 이 1순위.
// 마커가 없으면 종전대로 파일 순서. 기존 plan.md는 아무것도 안 바뀐다(하위호환).
// 본문 중간의 ★("★이번주 최우선" 같은 수사)는 마커로 치지 않는다 — 맨 앞만 본다.
function planUnresolvedLines(planText) {
  if (!planText) return [];
  const out = [];
  for (const line of planText.split('\n')) {
    if (/^\s*- \[ \]/.test(line)) out.push(line);
  }
  return out;
}

function planPriorityRank(line) {
  const m = line.match(/^\s*- \[ \]\s*★(\d*)/);
  if (!m) return Number.POSITIVE_INFINITY;   // 마커 없음 → 파일 순서에 맡긴다
  return m[1] ? parseInt(m[1], 10) : 0;      // 숫자 없는 ★ 는 최상위
}

function countPlanUnresolved(planText) {
  return planUnresolvedLines(planText).length;
}

function extractPlanUnresolvedTop(planText, n) {
  const all = planUnresolvedLines(planText);
  // 같은 순위끼리는 파일 순서를 지켜야 하므로 index를 tiebreak으로 쓴다
  // (Array.prototype.sort 의 안정성에 기대지 않는다).
  return all
    .map((line, i) => ({ line, i, rank: planPriorityRank(line) }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .slice(0, n)
    .map(x => x.line);
}

function truncateLines(text, maxLines, maxChars, sectionLabel) {
  if (!text) return { text: '', truncatedLines: 0 };
  const lines = text.split('\n');
  let out = [];
  let chars = 0;
  let truncated = 0;
  for (let i = 0; i < lines.length; i++) {
    if (out.length >= maxLines || chars + lines[i].length + 1 > maxChars) {
      truncated = lines.length - i;
      break;
    }
    out.push(lines[i]);
    chars += lines[i].length + 1;
  }
  let result = out.join('\n');
  if (truncated > 0) {
    result += `\n… [truncated: ${truncated} more lines — rerun with --view=full]`;
  }
  return { text: result, truncatedLines: truncated };
}

function renderResumeSummary(task, index, dir) {
  const header = `=== Loading previous work: ${task.title} [${task.id}] ===\n(view=summary — use --view=full for complete dump)\n`;

  const specRaw = readFileSafe(path.join(dir, 'spec.md')) || '';
  const planRaw = readFileSafe(path.join(dir, 'plan.md')) || '';
  const contextRaw = readFileSafe(path.join(dir, 'context.md')) || '';

  // Latest journal
  let latestJournalText = '';
  let latestJournalName = '';
  const journalDir = path.join(dir, 'journal');
  if (fs.existsSync(journalDir)) {
    const journals = fs.readdirSync(journalDir).filter(f => f.endsWith('.md')).sort().reverse();
    if (journals.length > 0) {
      latestJournalText = readFileSafe(path.join(journalDir, journals[0])) || '';
      latestJournalName = journals[0].replace('.md', '');
    }
  }
  const artifactsRaw = readFileSafe(path.join(dir, 'artifacts', 'INDEX.md')) || '';

  // Build PROTECTED content first
  const blockersSection = extractBlockersSection(contextRaw);
  const unresolvedTop = extractPlanUnresolvedTop(planRaw, 5);
  const latestDecision = extractLatestDecision(contextRaw);
  const latestJournalHeadline = extractLatestJournalHeadline(latestJournalText);

  const protectedBlock = [];
  if (blockersSection) {
    protectedBlock.push('--- Protected: Blockers ---');
    protectedBlock.push(blockersSection);
  }
  if (unresolvedTop.length > 0) {
    protectedBlock.push('--- Protected: Unresolved Plan (top 5) ---');
    protectedBlock.push(unresolvedTop.join('\n'));
    protectedBlock.push('');
  }
  if (latestDecision) {
    protectedBlock.push('--- Protected: Latest Decision ---');
    protectedBlock.push(latestDecision);
  }
  if (latestJournalHeadline) {
    protectedBlock.push(`--- Protected: Latest Journal Headline${latestJournalName ? ' (' + latestJournalName + ')' : ''} ---`);
    protectedBlock.push(latestJournalHeadline);
  }
  const protectedText = protectedBlock.join('\n');
  const protectedChars = protectedText.length;

  // Cap overflow invariant: protected content alone exceeds cap
  if (protectedChars > HARD_CHAR_CAP) {
    process.stderr.write(`[lake] cap exceeded by protected content: ${protectedChars} chars\n`);
    return header + protectedText + (protectedText.endsWith('\n') ? '' : '\n');
  }

  // Non-protected sections, built within budgets
  let remaining = HARD_CHAR_CAP - header.length - protectedChars;
  const sections = [];

  // Spec (Goal or fallback)
  const specGoal = extractSpecGoal(specRaw);
  if (specGoal) {
    const [maxL, maxC] = RESUME_SECTION_BUDGETS.spec;
    const budgetC = Math.min(maxC, Math.max(0, remaining));
    const { text } = truncateLines(specGoal.trimEnd(), maxL, budgetC, 'spec');
    if (text) {
      const block = `--- Spec (Goal) ---\n${text}\n`;
      if (block.length <= remaining) {
        sections.push(block);
        remaining -= block.length;
      }
    }
  }

  // Plan resolved (top 10)
  const resolvedLines = [];
  for (const line of planRaw.split('\n')) {
    if (/^- \[x\]/.test(line.trim()) || /^\s*- \[x\]/.test(line)) {
      resolvedLines.push(line);
      if (resolvedLines.length >= 10) break;
    }
  }
  if (resolvedLines.length > 0) {
    const [maxL, maxC] = RESUME_SECTION_BUDGETS.plan_resolved;
    const budgetC = Math.min(maxC, Math.max(0, remaining));
    const { text } = truncateLines(resolvedLines.join('\n'), maxL, budgetC, 'plan_resolved');
    if (text) {
      const block = `--- Plan (recent resolved) ---\n${text}\n`;
      if (block.length <= remaining) {
        sections.push(block);
        remaining -= block.length;
      }
    }
  }

  // Context non-blocker (Decisions + other sections)
  // compactor 마커(`<!-- lake:auto-context:* -->`)는 기계용 구분자다. 내용은 남기고
  // 마커 줄만 지운다 — 안 지우면 사용자 화면에 주석이 그대로 노출된다.
  const contextNonBlocker = contextRaw
    .replace(/(^|\n)## Blockers\s*\n[\s\S]*?(?=\n## |\n# |$)/, '')
    .split('\n').filter(line => !/^\s*<!--/.test(line)).join('\n')
    .trim();
  if (contextNonBlocker) {
    const [maxL, maxC] = RESUME_SECTION_BUDGETS.context;
    const budgetC = Math.min(maxC, Math.max(0, remaining));
    const { text } = truncateLines(contextNonBlocker, maxL, budgetC, 'context_non_blocker');
    if (text) {
      const block = `--- Context (non-blocker) ---\n${text}\n`;
      if (block.length <= remaining) {
        sections.push(block);
        remaining -= block.length;
      }
    }
  }

  // Journal tail (after headline)
  if (latestJournalText && latestJournalText.length > latestJournalHeadline.length) {
    const tail = latestJournalText.slice(latestJournalHeadline.length).trim();
    if (tail) {
      const [maxL, maxC] = RESUME_SECTION_BUDGETS.journal_head;
      const budgetC = Math.min(maxC, Math.max(0, remaining));
      const { text } = truncateLines(tail, maxL, budgetC, 'journal_tail');
      if (text) {
        const block = `--- Journal tail (${latestJournalName}) ---\n${text}\n`;
        if (block.length <= remaining) {
          sections.push(block);
          remaining -= block.length;
        }
      }
    }
  }

  // Artifacts
  if (artifactsRaw) {
    const [maxL, maxC] = RESUME_SECTION_BUDGETS.artifacts;
    const budgetC = Math.min(maxC, Math.max(0, remaining));
    const { text } = truncateLines(artifactsRaw.trim(), maxL, budgetC, 'artifacts');
    if (text) {
      const block = `--- Artifacts ---\n${text}\n`;
      if (block.length <= remaining) {
        sections.push(block);
        remaining -= block.length;
      }
    }
  }

  return header + protectedText + (protectedText && !protectedText.endsWith('\n') ? '\n' : '') + sections.join('');
}

function renderResumeMinimal(task, index, dir) {
  // Recap-style digest: title line + meta line + Last + Next. Designed to fit in
  // ~7 lines so the user (or LLM) can grasp the whole task state at a glance
  // without paying for summary/full's full-section dump. Use --view=summary or
  // --view=full when this isn't enough.
  const truncate = (s, n) => {
    s = String(s || '').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  let out = '';

  out += `=== ${task.title} [${task.id}] ===\n`;

  const days = Math.max(0, daysSince(task.updated));
  const ago = days === 0 ? 'today' : days === 1 ? '1d ago' : `${days}d ago`;
  const tags = task.tags && task.tags.length ? ' · ' + task.tags.map(x => '#' + x).join(' ') : '';
  const project = task.project ? ` · ${task.project}` : '';
  out += `Status: ${task.status} · Updated: ${task.updated} (${ago})${project}${tags}\n`;

  // 사람용 요약이 있으면 Status 바로 다음. 저널 첫 줄을 잘라오는 "Last"는 문장 중간에서
  // 끊기기 일쑤라, 요약이 있으면 그게 이 view의 본문이 된다.
  const humanRecap = extractSpecHumanRecap(readFileSafe(path.join(dir, 'spec.md')) || '');
  if (humanRecap) out += `📍 ${humanRecap}\n`;

  // Pull the first non-heading bullet/sentence from the most recent journal —
  // skip date headers (# 2026-04-15) and section headers (## Work Done) so the
  // line we surface is the actual recent action, not boilerplate scaffolding.
  const journalDir = path.join(dir, 'journal');
  let lastDate = null, lastLine = null;
  if (fs.existsSync(journalDir)) {
    const files = fs.readdirSync(journalDir).filter(f => f.endsWith('.md')).sort();
    if (files.length > 0) {
      lastDate = files[files.length - 1].replace(/\.md$/, '');
      const latestText = readFileSafe(path.join(journalDir, files[files.length - 1])) || '';
      for (const raw of latestText.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (/^#+\s/.test(line)) continue;
        lastLine = line.replace(/^[-*]\s*/, '');
        break;
      }
    }
  }
  if (lastLine) out += `Last (${lastDate}): ${truncate(lastLine, 110)}\n`;

  const planRaw = readFileSafe(path.join(dir, 'plan.md')) || '';
  const unresolved = extractPlanUnresolvedTop(planRaw, 3);
  if (unresolved.length > 0) {
    // brief와 같은 이유로, 감춘 건수를 밝힌다 (조용한 절단 = "이게 전부"로 오독됨).
    const restCount = countPlanUnresolved(planRaw) - unresolved.length;
    out += 'Next:\n' + unresolved.map(line => '  ' + truncate(line, 100)).join('\n') + '\n';
    if (restCount > 0) out += `  … 외 ${restCount}건\n`;
  }

  out += '(recap · --view=summary or --view=full for more detail)\n';
  return out;
}

function renderResumeSlim(task, index, dir) {
  // 기본 뷰. 화면에 "요약 하나 + (있으면) 블로커 + 다음 하나"만 남긴다.
  //
  // 예전엔 spec.md의 📍 recap을 무조건 본문으로 썼다. 그 결과
  // (1) 낡은 recap이 더 최신인 auto-context(현재/다음)를 가렸고,
  // (2) SessionStart 브리핑은 "더 최신 것"을 고르므로 브리핑과 resume이 같은
  //     태스크에 서로 다른 요약을 내놨다 — "비슷한듯 핀트가 다른 요약들"의 정체.
  // 브리핑의 선택 규칙(lake-session-start pickState: 수동 `지금 상태` > 더 최신 것,
  // 동률이면 context)을 그대로 따라 두 화면이 항상 같은 요약을 말하게 한다.
  const specRaw = readFileSafe(path.join(dir, 'spec.md')) || '';
  const contextRaw = readFileSafe(path.join(dir, 'context.md')) || '';

  const recapBody = extractSpecHumanRecap(specRaw);
  const recapDate = recapBody ? (recapBody.match(/^\((\d{4}-\d{2}-\d{2})\)/) || [])[1] || null : null;
  const rec = recapBody ? { text: recapBody, date: recapDate, kind: 'recap' } : null;

  const st = ctxlib.currentState(contextRaw);
  const ctx = st ? { text: st.text, date: st.date || null, kind: st.source === 'manual' ? 'manual' : 'auto' } : null;

  let picked = null;
  if (ctx && ctx.kind === 'manual') {
    picked = ctx; // 사람이 손으로 쓴 상태가 정본
  } else {
    // 동률(같은 날)이면 recap — 대화 전체 기반이 도구 로그 요약보다 낫다 (pickState와 동일).
    const candidates = [rec, ctx].filter(Boolean);
    candidates.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    picked = candidates[0] || null;
  }
  if (!picked) return renderResumeBrief(task, index, dir); // 요약이 아예 없으면 옛 화면이 최선

  const days = Math.max(0, daysSince(task.updated));
  const ago = days === 0 ? 'today' : days === 1 ? '1d ago' : `${days}d ago`;
  let out = `=== ${task.title} [${task.id}] · ${task.status} · ${ago} ===\n\n`;

  // 출처·기준일 라벨. 라벨이 없으면 자동 요약이 사람이 확정한 사실처럼 읽힌다.
  const label = picked.kind === 'recap'
    ? `📍 지난 세션 요약 (대화 기준${picked.date ? ' · ' + picked.date : ''})`
    : picked.kind === 'manual'
      ? `🧭 지금 상태 (context.md${picked.date ? ' · ' + picked.date : ''})`
      : `🧭 지금 상태 (자동 요약${picked.date ? ' · ' + picked.date : ''})`;
  // recap 본문은 `(YYYY-MM-DD) `로 시작한다 — 날짜를 라벨로 옮겼으니 본문에선 뗀다.
  const body = picked.kind === 'recap'
    ? picked.text.replace(/^\(\d{4}-\d{2}-\d{2}\)\s*/, '')
    : picked.text;
  out += `${label}\n${body}\n`;

  // 요약이 실제 활동보다 이틀 이상 낡았으면 화면이 그 사실을 말한다.
  // 침묵하면 낡은 요약이 '지금 상태'로 읽힌다. (resume 자체가 updated를 오늘로
  // 밀어올리므로 하루 차이는 정상 오차 — 경고하지 않는다.)
  if (picked.date) {
    const lagDays = Math.round((new Date(task.updated) - new Date(picked.date)) / 86400000);
    if (lagDays >= 2) {
      out += `⚠ 요약 기준일 ${picked.date} — 이후 활동 ${lagDays}일치는 미반영 (저널: --view=full)\n`;
    }
  }

  // 막힌 것은 요약과 별도 한 줄. 숨기면 새 세션이 막힌 항목을 착수 가능으로 읽는다.
  const blocked = ctxlib.blockers(contextRaw);
  if (blocked) out += `🚧 ${blocked.text}\n`;

  // '다음'은 화면에 하나만. 고른 요약이 이미 방향을 말하고 있으면("다음/남은/해야" 류)
  // plan.md 항목을 덧붙이지 않는다 — 핀트가 다른 '다음' 두 개가 이 뷰를 다시 망친다.
  // (과거엔 /다음|next/만 검사해서 recap이 "남은 일은…"이라고 쓰면 못 잡았다.)
  // plan.md가 저널보다 낡았으면 그 항목 자체가 의심스러우니 아예 내지 않는다.
  const hasDirection = /다음|남은|이제 |해야|할 일|next/i.test(picked.text);
  if (!hasDirection && !planlib.planStaleInfo(dir)) {
    const planRaw = readFileSafe(path.join(dir, 'plan.md')) || '';
    const top = extractPlanUnresolvedTop(planRaw, 1);
    if (top.length > 0) {
      const planNext = top[0].replace(/^\s*- \[ \]\s*/, '').replace(/^★\d*\s*/, '').trim();
      if (planNext) out += `\n다음 (plan.md): ${planNext}\n`;
    }
  }

  out += `\n(slim · 자세히: --view=brief · 전체: --view=full)\n`;
  return out;
}

function renderResumeBrief(task, index, dir) {
  // "오늘의 브리핑" view: AI가 컨텍스트 잡고 바로 작업할 수 있는 최소 충분 정보.
  // Goal/Done/Next/Blockers/Context를 한 화면에 압축. 저널 history는 의도적으로 제외
  // — 작업 진행에 필요한 건 결정/계획/제약이지 일별 로그가 아니다. journal/요약 통째가
  // 필요하면 --view=full / --view=summary로 escalate.
  const truncate = (s, n) => {
    s = String(s || '').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  const specRaw = readFileSafe(path.join(dir, 'spec.md')) || '';
  const planRaw = readFileSafe(path.join(dir, 'plan.md')) || '';
  const contextRaw = readFileSafe(path.join(dir, 'context.md')) || '';

  let out = '';

  // plan.md가 저널보다 낡았으면 제일 먼저 경고한다. journal/context/index는 훅이
  // 자동 갱신하는데 plan.md만 사람·AI 재량이라 plan.md만 썩고, brief의 "이제 할 차례"는
  // plan.md에서만 나온다. 사람이 이 사고를 즉시 알아챌 수 있는 유일한 지점이다.
  const stale = planlib.planStaleInfo(dir);
  if (stale) {
    out += `⚠ plan.md가 저널보다 낡음 (plan ${stale.planDate} < journal ${stale.journalDate}) — 할 일 목록을 신뢰하지 마세요\n`;
    out += `  → \`lake-cli.js plan-check ${task.id}\` 로 불일치 후보를 확인할 것.\n\n`;
  }

  const days = Math.max(0, daysSince(task.updated));
  const ago = days === 0 ? 'today' : days === 1 ? '1d ago' : `${days}d ago`;
  out += `=== ${task.title} [${task.id}] · ${task.status} · ${ago} ===\n\n`;

  // 사람용 요약이 있으면 Goal보다 위에 온다 — 사람이 제일 먼저 읽는 자리다.
  //
  // 단 이건 Claude Code의 away_summary를 주워온 것이라 "자리 비울 때 대화가 어디까지
  // 갔나"를 말한다. 태스크의 다음 할 일이 아니다. 세션 끝이 잡담이나 도구 수리였으면
  // 그 얘기가 그대로 올라온다. 라벨을 안 달았더니 AI가 이걸 '지금 할 일'로 읽고
  // 엉뚱하게 보고하는 사고가 났다 — 정본이 아래 ▶ 임을 그 자리에서 못박는다.
  const humanRecap = extractSpecHumanRecap(specRaw);
  if (humanRecap) {
    out += `## 📍 지난 세션 요약 (대화 기준 — 할 일 정본은 아래 ▶)\n${humanRecap}\n\n`;
  }

  const goal = extractSpecGoal(specRaw);
  const goalClean = goal ? goal.replace(/^##?\s*Goal\s*\n?/i, '').trim() : '';
  if (goalClean) {
    out += `## 📌 이 lake는\n${goalClean}\n\n`;
  }

  // "지금 상태" — context.md의 정본 상태. 이게 없어서 브리프가 계속 틀렸다.
  // 예전엔 compactor 자동 구간만 봤고, 사람이 손으로 갱신한 `## 지금 상태` 는
  // 헤딩이 한국어라는 이유로 통째 무시됐다. 그 결과 정성껏 정리한 태스크일수록
  // 브리프가 비고, AI는 plan.md의 ★1 을 '막힘 없는 다음 할 일'로 읽었다.
  // Goal 바로 아래, ▶ 보다 위에 둔다 — 무엇을 할지 정하기 전에 읽어야 하는 정보다.
  const state = ctxlib.currentState(contextRaw);
  if (state) {
    const label = state.source === 'manual'
      ? `## 🧭 지금 상태 (context.md${state.date ? ` · ${state.date}` : ''})`
      : '## 🧭 지금 상태 (자동 요약 — 도구 로그 기준)';
    const { text: stateText } = truncateLines(state.text, 12, 900, '지금 상태');
    out += `${label}\n${stateText}\n\n`;
  }

  // "최근 완료" — plan.md에서 [x] 항목을 모두 모아 마지막 3개를 보여준다.
  // 사용자는 plan.md를 시간순(위→아래)으로 쓰는 경우가 많아, 위에서 잘라온 3개는
  // 사실 가장 오래된 항목이다. 마지막 3개여야 진짜 최근.
  const allResolved = [];
  for (const line of planRaw.split('\n')) {
    const trimmed = line.trim();
    if (/^- \[x\]/i.test(trimmed)) {
      allResolved.push('- ' + trimmed.replace(/^- \[x\]\s*/i, ''));
    }
  }
  const resolvedRecent = allResolved.slice(-3);
  if (resolvedRecent.length > 0) {
    out += `## ✅ 여기까지 (최근 완료)\n${resolvedRecent.join('\n')}\n\n`;
  }

  // "이제 할 차례"에는 `- [ ]`(착수 가능)만. `- [~]`(대기)·`- [-]`(폐기)는 여기 오면 안 된다.
  const unresolved = extractPlanUnresolvedTop(planRaw, 3);
  if (unresolved.length > 0) {
    // 잘린 걸 말하지 않으면 "이게 전부"로 읽힌다. 몇 건을 감췄는지 반드시 밝힌다.
    const restCount = countPlanUnresolved(planRaw) - unresolved.length;
    const more = restCount > 0
      ? `\n… 외 ${restCount}건 — 전체는 \`lake-cli.js resume ${task.id} --view=full\``
      : '';
    out += `## ▶ 이제 할 차례\n${unresolved.join('\n')}${more}\n\n`;
  }

  // 대기 항목은 지금 착수할 수 없으므로 할 일과 섞지 않는다. 다만 숨기면 잊히므로
  // 해제조건과 함께 별도 섹션으로 보여주고, until이 지났으면 착수 가능해졌다고 알린다.
  const waiting = planlib.planItemsByState(planRaw, 'waiting');
  if (waiting.length > 0) {
    const todayStr = planlib.localDate(Date.now());
    const lines = waiting.slice(0, 5).map(it => {
      const overdue = it.until && it.until < todayStr;
      return `- ${it.body}${overdue ? `  ⚠ 기한 지남 (until ${it.until})` : ''}`;
    });
    out += `## ⏳ 대기중 (외부 이벤트)\n${lines.join('\n')}\n\n`;
  }

  // 영어 `## Blockers` 는 종전 경로 그대로(골든 바이트 동일). 그게 없을 때만
  // 한국어 헤딩(`## 막힌 것`)과 자동 구간의 `블로커:` 줄로 넓힌다.
  // 막힌 걸 못 보여주면 브리프는 막힌 항목을 '이제 할 차례'로 내놓는다.
  const blockers = extractBlockersSection(contextRaw);
  let blockerBody = blockers ? blockers.replace(/^##?\s*Blockers\s*\n?/i, '').trim() : '';
  if (!blockerBody) {
    const found = ctxlib.blockers(contextRaw);
    if (found) blockerBody = found.text;
  }
  if (blockerBody) {
    const { text: blockerText } = truncateLines(blockerBody, 10, 800, 'Blockers');
    out += `## 🚧 Blockers\n${blockerText}\n\n`;
  }

  const ctxLines = [];
  const branchMatch = contextRaw.match(/^\s*[-*]?\s*\*\*?Branch\*\*?\s*:\s*(.+)$/m);
  if (branchMatch) ctxLines.push(`Branch: ${branchMatch[1].trim()}`);
  const decision = extractLatestDecision(contextRaw);
  if (decision) {
    const decClean = decision.replace(/^##?\s*[^\n]*\n?/, '').replace(/^- /, '').trim();
    if (decClean) ctxLines.push(`Latest decision: ${truncate(decClean, 120)}`);
  }
  if (task.parent) ctxLines.push(`Parent: ${task.parent}`);
  if (task.children && task.children.length) ctxLines.push(`Children: ${task.children.join(', ')}`);
  if (task.relates && task.relates.length) ctxLines.push(`Relates: ${task.relates.join(', ')}`);
  if (task.tags && task.tags.length) ctxLines.push(`Tags: ${task.tags.map(t => '#' + t).join(' ')}`);

  if (ctxLines.length > 0) {
    out += `## 🔗 Context\n${ctxLines.map(l => '- ' + l).join('\n')}\n\n`;
  }

  // 폐기 항목은 brief에서 숨기되, 존재 자체는 알린다 (조용히 감추면 같은 논의가 재발한다).
  const dropped = planlib.planItemsByState(planRaw, 'dropped');
  if (dropped.length > 0) {
    out += `(폐기 ${dropped.length}건 숨김 — --view=full 에서 확인)\n`;
  }

  out += '(brief · --view=full for journal/history, --view=recap for one-line check)\n';
  return out;
}

// plan.md ↔ journal/Blockers 불일치 후보를 코드가 뽑아준다.
// v1.8.1은 SKILL.md에 "reconcile 필수"라는 산문 지시만 넣었고 또 안 지켜졌다.
// 사람이 성실히 기억하는 대신, save 절차가 이 커맨드를 실행하고 후보마다
// 체크/대기/폐기/유지 중 하나를 판정하게 만든다.
function cmdPlanCheck(query) {
  const index = readIndex();
  const task = findTask(index, query);
  const dir = taskDir(task);
  const planRaw = readFileSafe(path.join(dir, 'plan.md')) || '';
  const contextRaw = readFileSafe(path.join(dir, 'context.md')) || '';

  let out = `=== plan-check: ${task.title} [${task.id}] ===\n\n`;

  const stale = planlib.planStaleInfo(dir);
  out += '## 1) stale 검사\n';
  out += stale
    ? `⚠ plan.md가 저널보다 낡음 (plan ${stale.planDate} < journal ${stale.journalDate})\n`
    : 'OK — plan.md가 최신 저널보다 오래되지 않았다.\n';
  out += '\n';

  const candidates = planlib.findReconcileCandidates(dir, planRaw);
  const CANDIDATE_LIMIT = 12;
  const shown = candidates.slice(0, CANDIDATE_LIMIT);
  out += `## 2) 미체크 항목 ↔ 최신 저널 불일치 후보 (${candidates.length}건)\n`;
  if (candidates.length === 0) {
    out += '없음.\n';
  } else {
    const label = { done: '완료로 보임 → [x]', waiting: '대기로 보임 → [~]', dropped: '폐기로 보임 → [-]' };
    for (const c of shown) {
      out += `- [ ] ${c.item.body}\n`;
      out += `  ↳ journal ${c.evidence.file}: ${c.evidence.text}\n`;
      out += `  ↳ 신호 "${c.signal}" → ${label[c.verdict] || c.verdict} (판정 필요: 체크/대기/폐기/유지)\n`;
    }
    if (candidates.length > shown.length) {
      out += `… ${candidates.length - shown.length}건 더 있음 (상위 ${CANDIDATE_LIMIT}건만 표시)\n`;
    }
  }
  out += '\n';

  const contradictions = planlib.findBlockerContradictions(planRaw, contextRaw);
  out += `## 3) Blockers ↔ plan 모순 후보 (${contradictions.length}건)\n`;
  if (contradictions.length === 0) {
    out += '없음.\n';
  } else {
    for (const c of contradictions) {
      out += `- Blocker "${c.blocker}"\n  ↳ plan에선 이미 닫힘: - [x] ${c.item.body}\n`;
    }
  }
  out += '\n';

  const counts = { open: 0, done: 0, waiting: 0, dropped: 0 };
  for (const it of planlib.parsePlanItems(planRaw)) counts[it.state]++;
  out += `## 4) 현재 상태 (착수가능 ${counts.open} / 완료 ${counts.done} / 대기 ${counts.waiting} / 폐기 ${counts.dropped})\n`;
  out += '판정 어휘: `- [ ]` 착수 가능 / `- [x]` 완료 / `- [~] (until: YYYY-MM-DD)` 대기 / `- [-] (폐기 YYYY-MM-DD) 사유`\n';
  out += '폐기 항목은 삭제하지 말 것 — 같은 논의가 재발한다.\n';

  process.stdout.write(out);
}

function renderResumeFiles(task, index, dir) {
  let out = '';
  out += `=== Loading previous work: ${task.title} [${task.id}] ===\n(view=files)\n`;
  const files = [];
  for (const f of ['spec.md', 'plan.md', 'context.md']) {
    const c = readFileSafe(path.join(dir, f));
    if (c) files.push(`${f} (${c.split('\n').length} lines)`);
  }
  const journalDir = path.join(dir, 'journal');
  if (fs.existsSync(journalDir)) {
    const journals = fs.readdirSync(journalDir).filter(f => f.endsWith('.md')).sort();
    for (const j of journals) {
      const c = readFileSafe(path.join(journalDir, j));
      if (c) files.push(`journal/${j} (${c.split('\n').length} lines)`);
    }
  }
  const artifacts = readFileSafe(path.join(dir, 'artifacts', 'INDEX.md'));
  if (artifacts) files.push(`artifacts/INDEX.md (${artifacts.split('\n').length} lines)`);
  out += files.map(f => '- ' + f).join('\n') + '\n';
  return out;
}

function cmdUpsert(jsonStr) {
  const entry = JSON.parse(jsonStr);
  const index = readIndex();

  // Normalize project to the canonical registry value (if projects.json exists).
  if (entry.project) {
    entry.project = normalizeProject(entry.project, loadProjectConfig());
  }

  // Generate id if not provided
  if (!entry.id) {
    entry.id = generateHash(entry.slug);
  }
  // Ensure no hash collision
  const existing = index.findIndex(t => t.slug === entry.slug);
  let stored;
  if (existing >= 0) {
    // Update — preserve created, always bump updated (an upsert is a modification)
    stored = {
      ...index[existing],
      ...entry,
      created: index[existing].created || entry.created || today(),
      updated: today(),
    };
    index[existing] = stored;
  } else {
    // New entry — always stamp both timestamps so it can never land unsorted
    entry.created = entry.created || today();
    entry.updated = entry.updated || today();
    // Check hash collision
    while (index.some(t => t.id === entry.id)) {
      entry.id = crypto.createHash('sha1')
        .update(entry.slug + Date.now())
        .digest('hex').substring(0, 6);
    }
    index.push(entry);
    stored = entry;
  }
  writeIndex(index);
  touchActiveMarker(stored);
  console.log(JSON.stringify(stored));
}

function cmdDone(query) {
  const index = readIndex();
  const task = findTask(index, query);
  const oldDir = path.join(INPROGRESS_DIR, task.slug);
  const newDir = path.join(DONE_DIR, task.slug);

  // Move directory
  fs.mkdirSync(DONE_DIR, { recursive: true });
  if (fs.existsSync(oldDir)) {
    fs.renameSync(oldDir, newDir);
  }

  // Update index
  const idx = index.findIndex(t => t.slug === task.slug);
  index[idx].status = 'done';
  index[idx].updated = today();
  writeIndex(index);

  console.log(`Done: ${task.title} [${task.id}]`);
}

function cmdSearch(rawArgs) {
  const { view, limit, positional } = parseFlags('search', rawArgs);
  const keyword = positional.join(' ');
  const index = readIndex();
  switch (view) {
    case 'default':    process.stdout.write(renderSearchV0ByteIdentical(keyword, index)); return;
    case 'compressed': process.stdout.write(renderSearchCompressed(keyword, index, limit)); return;
    case 'full':       process.stdout.write(renderSearchFull(keyword, index)); return;
  }
}

// v0 byte-identical — preserves original cmdSearch console.log behavior.
function renderSearchV0ByteIdentical(keyword, index) {
  let out = '';
  const results = [];

  // Search by tag first
  const tagQuery = keyword.replace(/^#/, '');
  const tagMatches = index.filter(t => t.tags && t.tags.some(tag => tag.toLowerCase().includes(tagQuery.toLowerCase())));
  if (tagMatches.length > 0) {
    out += `Tag matches for "#${tagQuery}":\n\n`;
    tagMatches.forEach(t => {
      out += `  [${t.status}] [${t.id}] ${t.title} (${t.project}) — ${t.tags.map(x => '#' + x).join(' ')}\n\n`;
    });
  }

  // Search file contents
  const searchDir = (base, status) => {
    if (!fs.existsSync(base)) return;
    for (const slug of fs.readdirSync(base).sort()) {
      const dir = path.join(base, slug);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of ['spec.md', 'plan.md', 'context.md']) {
        const content = readFileSafe(path.join(dir, file));
        if (!content) continue;
        content.split('\n').forEach((line, i) => {
          if (line.toLowerCase().includes(keyword.toLowerCase())) {
            results.push({ status, slug, file, line: i + 1, text: line.trim() });
          }
        });
      }
    }
  };
  searchDir(INPROGRESS_DIR, 'inprogress');
  searchDir(DONE_DIR, 'done');

  if (results.length > 0) {
    out += `"${keyword}" file matches:\n\n`;
    results.forEach(r => {
      out += `  [${r.status}] ${r.slug}/${r.file}:${r.line}\n`;
      out += `    "${r.text}"\n\n`;
    });
  }

  if (tagMatches.length === 0 && results.length === 0) {
    out += `No results for "${keyword}"\n`;
  }
  return out;
}

function renderSearchCompressed(keyword, index, limit) {
  let out = '';
  const cap = limit || SEARCH_MAX_RESULTS;
  const tagQuery = keyword.replace(/^#/, '');
  const tagMatches = index.filter(t => t.tags && t.tags.some(tag => tag.toLowerCase().includes(tagQuery.toLowerCase())));
  if (tagMatches.length > 0) {
    out += `Tag matches for "#${tagQuery}":\n`;
    tagMatches.forEach(t => {
      out += `  [${t.status}] [${t.id}] ${t.title} (${t.project})\n`;
    });
    out += '\n';
  }

  const results = [];
  const searchDir = (base, status) => {
    if (!fs.existsSync(base)) return;
    for (const slug of fs.readdirSync(base).sort()) {
      const dir = path.join(base, slug);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of ['spec.md', 'plan.md', 'context.md']) {
        const content = readFileSafe(path.join(dir, file));
        if (!content) continue;
        content.split('\n').forEach((line, i) => {
          if (line.toLowerCase().includes(keyword.toLowerCase())) {
            results.push({ status, slug, file, line: i + 1, text: line.trim() });
          }
        });
      }
    }
  };
  searchDir(INPROGRESS_DIR, 'inprogress');
  searchDir(DONE_DIR, 'done');

  if (results.length > 0) {
    out += `"${keyword}" file matches:\n`;
    const shown = results.slice(0, cap);
    shown.forEach(r => {
      const text = r.text.length > 80 ? r.text.slice(0, 77) + '...' : r.text;
      out += `  [${r.status}] ${r.slug}/${r.file}:${r.line} "${text}"\n`;
    });
    if (results.length > cap) {
      out += `… +${results.length - cap} more — narrow query or use --view=full\n`;
    }
  }

  if (tagMatches.length === 0 && results.length === 0) {
    out += `No results for "${keyword}"\n`;
  }
  return out;
}

function renderSearchFull(keyword, index) {
  // Same as v0 byte-identical; explicit alias with no cap.
  return renderSearchV0ByteIdentical(keyword, index);
}

function cmdLink(parentQuery, childQuery) {
  const index = readIndex();
  const parent = findTask(index, parentQuery);
  const child = findTask(index, childQuery);

  if (parent.id === child.id) {
    console.error('Cannot link a task to itself');
    process.exit(1);
  }

  // Set child's parent
  const childIdx = index.findIndex(t => t.slug === child.slug);
  index[childIdx].parent = parent.id;

  // Add to parent's children
  const parentIdx = index.findIndex(t => t.slug === parent.slug);
  if (!index[parentIdx].children) index[parentIdx].children = [];
  if (!index[parentIdx].children.includes(child.id)) {
    index[parentIdx].children.push(child.id);
  }

  writeIndex(index);
  console.log(`Linked: [${parent.id}] ${parent.title} ← [${child.id}] ${child.title}`);
}

function cmdUnlink(parentQuery, childQuery) {
  const index = readIndex();
  const parent = findTask(index, parentQuery);
  const child = findTask(index, childQuery);

  // Remove child's parent
  const childIdx = index.findIndex(t => t.slug === child.slug);
  delete index[childIdx].parent;

  // Remove from parent's children
  const parentIdx = index.findIndex(t => t.slug === parent.slug);
  if (index[parentIdx].children) {
    index[parentIdx].children = index[parentIdx].children.filter(id => id !== child.id);
    if (index[parentIdx].children.length === 0) delete index[parentIdx].children;
  }

  writeIndex(index);
  console.log(`Unlinked: [${parent.id}] ${parent.title} ✕ [${child.id}] ${child.title}`);
}

function cmdTree(query) {
  const index = readIndex();

  if (!query) {
    // Show all trees (top-level parents with children)
    const parents = index.filter(t => t.children && t.children.length > 0);
    if (parents.length === 0) {
      console.log('No epic trees found.');
      return;
    }
    parents.forEach(p => printTree(index, p, 0));
    return;
  }

  const task = findTask(index, query);
  // Walk up to root
  let root = task;
  while (root.parent) {
    root = index.find(t => t.id === root.parent) || root;
    if (!root.parent || root.id === task.id) break;
  }
  printTree(index, root, 0);
}

function printTree(index, task, depth) {
  const indent = '  '.repeat(depth);
  const prefix = depth === 0 ? '📋' : '  └─';
  const stale = daysSince(task.updated) >= 7 ? ' (stale)' : '';
  const status = task.status === 'done' ? ' ✅' : '';
  console.log(`${indent}${prefix} [${task.id}] ${task.title} (${task.project})${status}${stale}`);

  if (task.children) {
    task.children.forEach(childId => {
      const child = index.find(t => t.id === childId);
      if (child) printTree(index, child, depth + 1);
    });
  }
}

function cmdRelate(query1, query2) {
  const index = readIndex();
  const task1 = findTask(index, query1);
  const task2 = findTask(index, query2);

  if (task1.id === task2.id) {
    console.error('Cannot relate a task to itself');
    process.exit(1);
  }

  const idx1 = index.findIndex(t => t.slug === task1.slug);
  const idx2 = index.findIndex(t => t.slug === task2.slug);

  if (!index[idx1].relates) index[idx1].relates = [];
  if (!index[idx2].relates) index[idx2].relates = [];

  if (!index[idx1].relates.includes(task2.id)) index[idx1].relates.push(task2.id);
  if (!index[idx2].relates.includes(task1.id)) index[idx2].relates.push(task1.id);

  writeIndex(index);
  console.log(`Related: [${task1.id}] ${task1.title} ↔ [${task2.id}] ${task2.title}`);
}

function cmdUnrelate(query1, query2) {
  const index = readIndex();
  const task1 = findTask(index, query1);
  const task2 = findTask(index, query2);

  const idx1 = index.findIndex(t => t.slug === task1.slug);
  const idx2 = index.findIndex(t => t.slug === task2.slug);

  if (index[idx1].relates) {
    index[idx1].relates = index[idx1].relates.filter(id => id !== task2.id);
    if (index[idx1].relates.length === 0) delete index[idx1].relates;
  }
  if (index[idx2].relates) {
    index[idx2].relates = index[idx2].relates.filter(id => id !== task1.id);
    if (index[idx2].relates.length === 0) delete index[idx2].relates;
  }

  writeIndex(index);
  console.log(`Unrelated: [${task1.id}] ${task1.title} ✕ [${task2.id}] ${task2.title}`);
}

function cmdBlock(blockedQuery, blockerQuery) {
  const index = readIndex();
  const blocked = findTask(index, blockedQuery);
  const blocker = findTask(index, blockerQuery);

  if (blocked.id === blocker.id) {
    console.error('Cannot block a task by itself');
    process.exit(1);
  }

  const blockedIdx = index.findIndex(t => t.slug === blocked.slug);
  const blockerIdx = index.findIndex(t => t.slug === blocker.slug);

  if (!index[blockedIdx].blocked_by) index[blockedIdx].blocked_by = [];
  if (!index[blockerIdx].blocks) index[blockerIdx].blocks = [];

  if (!index[blockedIdx].blocked_by.includes(blocker.id)) index[blockedIdx].blocked_by.push(blocker.id);
  if (!index[blockerIdx].blocks.includes(blocked.id)) index[blockerIdx].blocks.push(blocked.id);

  writeIndex(index);
  console.log(`Blocked: [${blocked.id}] ${blocked.title} ──blocked by──→ [${blocker.id}] ${blocker.title}`);
}

function cmdUnblock(blockedQuery, blockerQuery) {
  const index = readIndex();
  const blocked = findTask(index, blockedQuery);
  const blocker = findTask(index, blockerQuery);

  const blockedIdx = index.findIndex(t => t.slug === blocked.slug);
  const blockerIdx = index.findIndex(t => t.slug === blocker.slug);

  if (index[blockedIdx].blocked_by) {
    index[blockedIdx].blocked_by = index[blockedIdx].blocked_by.filter(id => id !== blocker.id);
    if (index[blockedIdx].blocked_by.length === 0) delete index[blockedIdx].blocked_by;
  }
  if (index[blockerIdx].blocks) {
    index[blockerIdx].blocks = index[blockerIdx].blocks.filter(id => id !== blocked.id);
    if (index[blockerIdx].blocks.length === 0) delete index[blockerIdx].blocks;
  }

  writeIndex(index);
  console.log(`Unblocked: [${blocked.id}] ${blocked.title} ✕ [${blocker.id}] ${blocker.title}`);
}

function cmdTag(query, ...tags) {
  const index = readIndex();
  const task = findTask(index, query);
  const idx = index.findIndex(t => t.slug === task.slug);

  if (!index[idx].tags) index[idx].tags = [];
  tags.forEach(tag => {
    const clean = tag.replace(/^#/, '');
    if (!index[idx].tags.includes(clean)) index[idx].tags.push(clean);
  });

  writeIndex(index);
  console.log(`Tagged: [${task.id}] ${task.title} → ${index[idx].tags.map(t => '#' + t).join(' ')}`);
}

function cmdUntag(query, ...tags) {
  const index = readIndex();
  const task = findTask(index, query);
  const idx = index.findIndex(t => t.slug === task.slug);

  if (index[idx].tags) {
    const remove = tags.map(t => t.replace(/^#/, ''));
    index[idx].tags = index[idx].tags.filter(t => !remove.includes(t));
    if (index[idx].tags.length === 0) delete index[idx].tags;
  }

  writeIndex(index);
  const remaining = index[idx].tags ? index[idx].tags.map(t => '#' + t).join(' ') : '(none)';
  console.log(`Untagged: [${task.id}] ${task.title} → ${remaining}`);
}

function cmdRebuild() {
  const index = [];
  const scanDir = (base, status) => {
    if (!fs.existsSync(base)) return;
    for (const slug of fs.readdirSync(base).sort()) {
      const dir = path.join(base, slug);
      if (!fs.statSync(dir).isDirectory()) continue;
      const spec = readFileSafe(path.join(dir, 'spec.md'));
      let title = slug, project = 'unknown', created = today(), updated = today();
      if (spec) {
        const titleMatch = spec.match(/^#\s+(.+)/m);
        if (titleMatch) title = titleMatch[1];
        const projMatch = spec.match(/\*\*Project\*\*:\s*(.+)/);
        if (projMatch) project = projMatch[1].trim();
        const createdMatch = spec.match(/\*\*Created\*\*:\s*(\d{4}-\d{2}-\d{2})/);
        if (createdMatch) created = createdMatch[1];
        const updatedMatch = spec.match(/\*\*Updated\*\*:\s*(\d{4}-\d{2}-\d{2})/);
        if (updatedMatch) updated = updatedMatch[1];
      }
      index.push({
        id: generateHash(slug),
        slug,
        title,
        project,
        status,
        created,
        updated
      });
    }
  };
  scanDir(INPROGRESS_DIR, 'inprogress');
  scanDir(DONE_DIR, 'done');
  writeIndex(index);
  console.log(`Rebuilt index: ${index.length} tasks`);
  index.forEach(t => console.log(`  [${t.id}] ${t.slug} (${t.status})`));
}

function cmdSummary(query) {
  const index = readIndex();
  const task = findTask(index, query);
  const dir = taskDir(task);
  const plan = readFileSafe(path.join(dir, 'plan.md')) || '';
  const done = (plan.match(/^- \[x\]/gm) || []).length;
  const total = (plan.match(/^- \[[ x]\]/gm) || []).length;
  const tags = task.tags ? task.tags.map(t => '#' + t).join(' ') : '';
  process.stdout.write(`[${task.id}] ${task.title} (${task.project}) — updated: ${task.updated} — plan: ${done}/${total}${tags ? ' — tags: ' + tags : ''}\n`);
}

function cmdVersion() {
  let gitHash = 'unknown';
  try {
    const { execSync } = require('child_process');
    gitHash = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown';
  } catch { /* git 실패해도 OK */ }
  process.stdout.write(`lake-cli v${LAKE_CLI_VERSION} (${gitHash})\n`);
}

// --- Main ---

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'list':    cmdList(args); break;
  case 'find':    cmdFind(args[0]); break;
  case 'resume':  cmdResume(args); break;
  case 'upsert':  cmdUpsert(args[0]); break;
  case 'done':    cmdDone(args[0]); break;
  case 'search':  cmdSearch(args); break;
  case 'rebuild': cmdRebuild(); break;
  case 'link':    cmdLink(args[0], args[1]); break;
  case 'unlink':  cmdUnlink(args[0], args[1]); break;
  case 'tree':    cmdTree(args[0]); break;
  case 'relate':  cmdRelate(args[0], args[1]); break;
  case 'unrelate': cmdUnrelate(args[0], args[1]); break;
  case 'tag':     cmdTag(args[0], ...args.slice(1)); break;
  case 'untag':   cmdUntag(args[0], ...args.slice(1)); break;
  case 'block':   cmdBlock(args[0], args[1]); break;
  case 'unblock': cmdUnblock(args[0], args[1]); break;
  case 'summary': cmdSummary(args[0]); break;
  case 'plan-check': cmdPlanCheck(args[0]); break;
  case 'version': cmdVersion(); break;
  case 'help':
  case '-h':
  case '--help':
    process.stdout.write(USAGE); break;
  default:
    process.stderr.write(USAGE);
    process.exit(1);
}
