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

// --- Commands ---

function cmdList() {
  const index = readIndex();
  const inprog = index.filter(t => t.status === 'inprogress')
    .sort((a, b) => b.updated.localeCompare(a.updated));
  const done = index.filter(t => t.status === 'done')
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, 5);

  // Separate top-level (no parent) and children
  const topLevel = inprog.filter(t => !t.parent);
  const childMap = {};
  inprog.filter(t => t.parent).forEach(t => {
    if (!childMap[t.parent]) childMap[t.parent] = [];
    childMap[t.parent].push(t);
  });

  console.log(`In Progress (${inprog.length}):`);
  let num = 1;
  topLevel.forEach(t => {
    const stale = daysSince(t.updated) >= 7 ? ' (stale)' : '';
    const tags = t.tags ? ` ${t.tags.map(x => '#' + x).join(' ')}` : '';
    console.log(`  ${num}. [${t.id}] ${t.title} (${t.project}) — Updated ${t.updated}${stale}${tags}`);
    num++;
    const children = (childMap[t.id] || []).sort((a, b) => b.updated.localeCompare(a.updated));
    children.forEach((c, ci) => {
      const cstale = daysSince(c.updated) >= 7 ? ' (stale)' : '';
      const ctags = c.tags ? ` ${c.tags.map(x => '#' + x).join(' ')}` : '';
      const prefix = ci === children.length - 1 ? '└─' : '├─';
      console.log(`     ${prefix} [${c.id}] ${c.title} (${c.project}) — Updated ${c.updated}${cstale}${ctags}`);
    });
  });

  // Show orphaned children (parent not found) as top-level
  const allParentIds = new Set(topLevel.map(t => t.id));
  inprog.filter(t => t.parent && !allParentIds.has(t.parent)).forEach(t => {
    const stale = daysSince(t.updated) >= 7 ? ' (stale)' : '';
    console.log(`  ${num}. [${t.id}] ${t.title} (${t.project}) — Updated ${t.updated}${stale} (parent: ${t.parent})`);
    num++;
  });

  if (done.length > 0) {
    console.log(`\nDone (recent ${done.length}):`);
    done.forEach((t, i) => {
      console.log(`  ${num + i}. [${t.id}] ${t.title} (${t.project}) — Completed ${t.updated}`);
    });
  } else {
    console.log('\nDone: (none)');
  }
}

function cmdFind(query) {
  const index = readIndex();
  const task = findTask(index, query);
  // Output JSON for easy parsing
  console.log(JSON.stringify(task));
}

function cmdResume(query) {
  const index = readIndex();
  const task = findTask(index, query);
  const dir = taskDir(task);

  console.log(`=== Loading previous work: ${task.title} [${task.id}] ===\n`);

  // Show epic links
  if (task.parent) {
    const parent = index.find(t => t.id === task.parent);
    if (parent) console.log(`📋 Parent: [${parent.id}] ${parent.title}\n`);
  }
  if (task.children && task.children.length > 0) {
    console.log('📋 Children:');
    task.children.forEach(cid => {
      const child = index.find(t => t.id === cid);
      if (child) {
        const status = child.status === 'done' ? ' ✅' : '';
        console.log(`  └─ [${child.id}] ${child.title}${status}`);
      }
    });
    console.log();
  }
  if (task.relates && task.relates.length > 0) {
    console.log('🔗 Relates to:');
    task.relates.forEach(rid => {
      const rel = index.find(t => t.id === rid);
      if (rel) console.log(`  ↔ [${rel.id}] ${rel.title}`);
    });
    console.log();
  }
  if (task.blocked_by && task.blocked_by.length > 0) {
    console.log('🚫 Blocked by:');
    task.blocked_by.forEach(bid => {
      const b = index.find(t => t.id === bid);
      if (b) {
        const done = b.status === 'done' ? ' ✅' : '';
        console.log(`  ← [${b.id}] ${b.title}${done}`);
      }
    });
    console.log();
  }
  if (task.blocks && task.blocks.length > 0) {
    console.log('⏳ Blocks:');
    task.blocks.forEach(bid => {
      const b = index.find(t => t.id === bid);
      if (b) console.log(`  → [${b.id}] ${b.title}`);
    });
    console.log();
  }
  if (task.tags && task.tags.length > 0) {
    console.log(`🏷️  Tags: ${task.tags.map(t => `#${t}`).join(' ')}\n`);
  }

  const spec = readFileSafe(path.join(dir, 'spec.md'));
  if (spec) { console.log('--- Spec ---'); console.log(spec); }

  const plan = readFileSafe(path.join(dir, 'plan.md'));
  if (plan) { console.log('--- Plan ---'); console.log(plan); }

  const context = readFileSafe(path.join(dir, 'context.md'));
  if (context) { console.log('--- Context ---'); console.log(context); }

  // Latest journal
  const journalDir = path.join(dir, 'journal');
  if (fs.existsSync(journalDir)) {
    const journals = fs.readdirSync(journalDir).filter(f => f.endsWith('.md')).sort().reverse();
    if (journals.length > 0) {
      const latest = readFileSafe(path.join(journalDir, journals[0]));
      if (latest) { console.log(`--- Journal (${journals[0].replace('.md', '')}) ---`); console.log(latest); }
    }
  }

  // Artifacts
  const artifacts = readFileSafe(path.join(dir, 'artifacts', 'INDEX.md'));
  if (artifacts) { console.log('--- Artifacts ---'); console.log(artifacts); }
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

function cmdSearch(keyword) {
  const index = readIndex();
  const results = [];

  // Search by tag first
  const tagQuery = keyword.replace(/^#/, '');
  const tagMatches = index.filter(t => t.tags && t.tags.some(tag => tag.toLowerCase().includes(tagQuery.toLowerCase())));
  if (tagMatches.length > 0) {
    console.log(`Tag matches for "#${tagQuery}":\n`);
    tagMatches.forEach(t => {
      console.log(`  [${t.status}] [${t.id}] ${t.title} (${t.project}) — ${t.tags.map(x => '#' + x).join(' ')}\n`);
    });
  }

  // Search file contents
  const searchDir = (base, status) => {
    if (!fs.existsSync(base)) return;
    for (const slug of fs.readdirSync(base)) {
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
    console.log(`"${keyword}" file matches:\n`);
    results.forEach(r => {
      console.log(`  [${r.status}] ${r.slug}/${r.file}:${r.line}`);
      console.log(`    "${r.text}"\n`);
    });
  }

  if (tagMatches.length === 0 && results.length === 0) {
    console.log(`No results for "${keyword}"`);
  }
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
    for (const slug of fs.readdirSync(base)) {
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

// --- Main ---

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'list':    cmdList(); break;
  case 'find':    cmdFind(args[0]); break;
  case 'resume':  cmdResume(args[0]); break;
  case 'upsert':  cmdUpsert(args[0]); break;
  case 'done':    cmdDone(args[0]); break;
  case 'search':  cmdSearch(args.join(' ')); break;
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
  default:
    console.log('Usage: lake-cli.js <list|find|resume|upsert|done|search|rebuild> [args]');
    process.exit(1);
}
