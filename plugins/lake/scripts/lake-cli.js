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
 *   node lake-cli.js version                # Print version + git hash
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

function findTask(index, query) {
  // Numeric query → position in the same order as cmdList (inprogress by updated desc, top-level only)
  if (/^\d+$/.test(query)) {
    const n = parseInt(query, 10);
    const inprog = index.filter(t => t.status === 'inprogress')
      .sort((a, b) => b.updated.localeCompare(a.updated));
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

const LAKE_CLI_VERSION = '1.0.0';

const VIEW_DEFAULTS = {
  resume: 'full',     // v1: v0 byte-identical
  list:   'default',  // v1: v0 byte-identical
  search: 'default',  // v1: v0 byte-identical
};

const FLAG_SPEC = {
  resume: {
    view: ['summary', 'full', 'minimal', 'files'],
    aliases: { '--full': 'full', '--minimal': 'minimal', '--files': 'files', '--summary': 'summary' },
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
Commands: list, resume, save, done, search, summary, version,
          link, unlink, tree, relate, unrelate, tag, untag, block, unblock, rebuild, find, upsert
Views: resume --view=summary|full|minimal|files   (v1 default: full)
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
  return { view: view || VIEW_DEFAULTS[cmd], limit, noColor, positional };
}

// --- Commands ---

function cmdList(rawArgs) {
  const { view } = parseFlags('list', rawArgs);
  const index = readIndex();
  switch (view) {
    case 'default':    process.stdout.write(renderListV0ByteIdentical(index)); return;
    case 'compressed': process.stdout.write(renderListCompressed(index)); return;
    case 'tree':       process.stdout.write(renderListTree(index)); return;
    case 'all':        process.stdout.write(renderListAll(index)); return;
  }
}

// v1.3.2 table-format — buffer-accumulating version of cmdList from commit 47de147.
function renderListV0ByteIdentical(index) {
  let out = '';
  const inprog = index.filter(t => t.status === 'inprogress')
    .sort((a, b) => b.updated.localeCompare(a.updated));
  const done = index.filter(t => t.status === 'done')
    .sort((a, b) => b.updated.localeCompare(a.updated))
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
    const children = (childMap[t.id] || []).sort((a, b) => b.updated.localeCompare(a.updated));
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

  const renderTable = (ttl, tbl) => {
    if (tbl.length === 0) return;
    const all = [header, ...tbl];
    const cols = header.length;
    const colW = [];
    for (let c = 0; c < cols; c++) {
      colW.push(Math.max(...all.map(r => displayWidth(r[c]))));
    }
    const total = colW.reduce((s, w) => s + w + 3, 0) + 1; // each col: ' ' + content + ' ' + '│' ; plus opening '│'

    const hLine = (l, m, r) => l + colW.map(w => '─'.repeat(w + 2)).join(m) + r;
    const top = '┌' + '─'.repeat(total - 2) + '┐';
    const headBot = hLine('├', '┬', '┤');
    const rowSep = hLine('├', '┼', '┤');
    const bot = hLine('└', '┴', '┘');

    const titleLine = '│ ' + padDisplay(`${ttl}  (${tbl.length})`, total - 4) + ' │';
    const headRow = '│' + header.map((h, i) => ' ' + padDisplay(h, colW[i]) + ' ').join('│') + '│';
    const dataRow = (r) => '│' + r.map((v, i) => ' ' + padDisplay(v, colW[i]) + ' ').join('│') + '│';

    out += top + '\n';
    out += titleLine + '\n';
    out += headBot + '\n';
    out += headRow + '\n';
    out += rowSep + '\n';
    tbl.forEach((r, i) => {
      out += dataRow(r) + '\n';
      if (i < tbl.length - 1) out += rowSep + '\n';
    });
    out += bot + '\n';
  };

  out += '\n';
  renderTable('진행중', rows);
  if (doneRows.length) { out += '\n'; renderTable('끝냄', doneRows); }
  out += '\n';
  out += `  진행중 ${inprog.length} · 완료 ${index.filter(x => x.status === 'done').length}  ·  lake resume <번호|hash|제목>\n`;
  out += '\n';
  return out;
}

function renderListCompressed(index) {
  let out = '';
  const inprogAll = index.filter(t => t.status === 'inprogress')
    .sort((a, b) => b.updated.localeCompare(a.updated));
  const topLevel = inprogAll.filter(t => !t.parent);
  const childCountByParent = {};
  let hiddenChildren = 0;
  inprogAll.filter(t => t.parent).forEach(t => {
    childCountByParent[t.parent] = (childCountByParent[t.parent] || 0) + 1;
    hiddenChildren++;
  });
  const staleCount = inprogAll.filter(t => daysSince(t.updated) >= 7).length;

  const topShown = topLevel.slice(0, LIST_MAX_INPROGRESS);
  const hiddenStale = topLevel.slice(LIST_MAX_INPROGRESS)
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
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, LIST_MAX_DONE);
  if (done.length > 0) {
    out += `\nDone (recent ${done.length}):\n`;
    done.forEach((t, i) => {
      out += `  ${num + i}. [${t.id}] ${t.title} (${t.project}) — Completed ${t.updated}\n`;
    });
  }

  out += `\nShowing ${topShown.length}/${topLevel.length} inprogress (hidden: stale ${hiddenStale}, children ${hiddenChildren}). Use --view=all to disable truncation.\n`;
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
    .sort((a, b) => b.updated.localeCompare(a.updated));
  const done = index.filter(t => t.status === 'done')
    .sort((a, b) => b.updated.localeCompare(a.updated));
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

  const isLegacy = process.env.LAKE_LEGACY === '1';
  if (isLegacy) {
    process.stderr.write('[lake] LAKE_LEGACY=1 no-op in v1, reserved for v2+\n');
    // v1: stdout unchanged. No [mode=legacy] tag.
  }

  switch (view) {
    case 'full':    process.stdout.write(renderResumeFull(task, index, dir)); return;
    case 'summary': process.stdout.write(renderResumeSummary(task, index, dir)); return;
    case 'minimal': process.stdout.write(renderResumeMinimal(task, index, dir)); return;
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

// Extract spec Goal section, or fall back to frontmatter + next 20 lines
function extractSpecGoal(specText) {
  if (!specText) return '';
  const goalMatch = specText.match(/(^|\n)## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/);
  if (goalMatch) {
    return '## Goal\n' + goalMatch[2].trim() + '\n';
  }
  // Fallback: frontmatter/title + next 20 lines
  const lines = specText.split('\n');
  return lines.slice(0, 22).join('\n') + '\n';
}

function extractBlockersSection(contextText) {
  if (!contextText) return '';
  const m = contextText.match(/(^|\n)## Blockers\s*\n([\s\S]*?)(?=\n## |\n# |$)/);
  if (!m) return '';
  return '## Blockers\n' + m[2].trimEnd() + '\n';
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

function extractPlanUnresolvedTop(planText, n) {
  if (!planText) return [];
  const unresolved = [];
  for (const line of planText.split('\n')) {
    if (/^- \[ \]/.test(line.trim()) || /^\s*- \[ \]/.test(line)) {
      unresolved.push(line);
      if (unresolved.length >= n) break;
    }
  }
  return unresolved;
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
  const contextNonBlocker = contextRaw.replace(/(^|\n)## Blockers\s*\n[\s\S]*?(?=\n## |\n# |$)/, '').trim();
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
  let out = '';
  out += `=== Loading previous work: ${task.title} [${task.id}] ===\n(view=minimal)\n`;
  const specRaw = readFileSafe(path.join(dir, 'spec.md')) || '';
  const specLines = specRaw.split('\n').slice(0, 3).join('\n');
  if (specLines.trim()) {
    out += '--- Spec (first 3 lines) ---\n' + specLines + '\n';
  }
  const planRaw = readFileSafe(path.join(dir, 'plan.md')) || '';
  const unresolved = extractPlanUnresolvedTop(planRaw, 5);
  if (unresolved.length > 0) {
    out += '--- Unresolved Plan (top 5) ---\n' + unresolved.join('\n') + '\n';
  }
  return out;
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

  // Generate id if not provided
  if (!entry.id) {
    entry.id = generateHash(entry.slug);
  }
  // Ensure no hash collision
  const existing = index.findIndex(t => t.slug === entry.slug);
  if (existing >= 0) {
    // Update
    index[existing] = { ...index[existing], ...entry };
  } else {
    // Check hash collision
    while (index.some(t => t.id === entry.id)) {
      entry.id = crypto.createHash('sha1')
        .update(entry.slug + Date.now())
        .digest('hex').substring(0, 6);
    }
    index.push(entry);
  }
  writeIndex(index);
  console.log(JSON.stringify(entry));
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
  case 'version': cmdVersion(); break;
  case 'help':
  case '-h':
  case '--help':
    process.stdout.write(USAGE); break;
  default:
    process.stderr.write(USAGE);
    process.exit(1);
}
