#!/usr/bin/env node
/**
 * lake-cli.js — PRD Lake fast index CLI
 *
 * Usage:
 *   node lake-cli.js list                   # Print task table
 *   node lake-cli.js find <hash-prefix>     # Find task by hash prefix, print slug
 *   node lake-cli.js resume <hash-or-slug>  # Print all files for a task (spec+plan+context+journal+artifacts)
 *   node lake-cli.js upsert <json-string>   # Add or update index entry
 *   node lake-cli.js done <hash-or-slug>    # Move task to done, update index
 *   node lake-cli.js search <keyword>       # Search across all lake files
 *   node lake-cli.js rebuild                # Rebuild index.json from disk
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

  console.log(`In Progress (${inprog.length}):`);
  inprog.forEach((t, i) => {
    const stale = daysSince(t.updated) >= 7 ? ' (stale)' : '';
    console.log(`  ${i + 1}. [${t.id}] ${t.title} (${t.project}) — Updated ${t.updated}${stale}`);
  });

  if (done.length > 0) {
    console.log(`\nDone (recent ${done.length}):`);
    done.forEach((t, i) => {
      console.log(`  ${inprog.length + i + 1}. [${t.id}] ${t.title} (${t.project}) — Completed ${t.updated}`);
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
  const results = [];
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

  if (results.length === 0) {
    console.log(`No results for "${keyword}"`);
    return;
  }
  console.log(`"${keyword}" search results:\n`);
  results.forEach(r => {
    console.log(`  [${r.status}] ${r.slug}/${r.file}:${r.line}`);
    console.log(`    "${r.text}"\n`);
  });
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
  default:
    console.log('Usage: lake-cli.js <list|find|resume|upsert|done|search|rebuild> [args]');
    process.exit(1);
}
