#!/usr/bin/env node

/**
 * PRD Lake SessionStart Hook
 *
 * 세션 시작 시:
 * 1. inprogress 태스크가 있으면 요약 알림 표시
 * 2. done/ 중 30일+ 항목을 archive/{yyyy-MM}/로 자동 이동
 */

const fs = require('fs');
const path = require('path');

const LAKE_DIR = path.join(process.env.HOME, '.claude', 'prd-lake');
const INPROGRESS = path.join(LAKE_DIR, 'inprogress');
const DONE = path.join(LAKE_DIR, 'done');
const ARCHIVE = path.join(LAKE_DIR, 'archive');

function getUpdatedDate(specPath) {
  try {
    const content = fs.readFileSync(specPath, 'utf-8');
    const match = content.match(/^\- \*\*Updated\*\*: (.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function isStale(dateStr) {
  if (!dateStr) return false;
  const updated = new Date(dateStr.replace(' ', 'T'));
  const now = new Date();
  const diffDays = (now - updated) / (1000 * 60 * 60 * 24);
  return diffDays >= 7;
}

function archiveOldDone() {
  if (!fs.existsSync(DONE)) return;

  const tasks = fs.readdirSync(DONE, { withFileTypes: true })
    .filter(d => d.isDirectory());

  const now = new Date();

  for (const task of tasks) {
    const specPath = path.join(DONE, task.name, 'spec.md');
    const dateStr = getUpdatedDate(specPath);
    if (!dateStr) continue;

    const updated = new Date(dateStr.replace(' ', 'T'));
    const diffDays = (now - updated) / (1000 * 60 * 60 * 24);

    if (diffDays >= 30) {
      const yearMonth = `${updated.getFullYear()}-${String(updated.getMonth() + 1).padStart(2, '0')}`;
      const archiveDir = path.join(ARCHIVE, yearMonth);
      fs.mkdirSync(archiveDir, { recursive: true });

      const src = path.join(DONE, task.name);
      const dst = path.join(archiveDir, task.name);
      fs.renameSync(src, dst);
    }
  }
}

function buildNotification() {
  if (!fs.existsSync(INPROGRESS)) return null;

  const tasks = fs.readdirSync(INPROGRESS, { withFileTypes: true })
    .filter(d => d.isDirectory());

  if (tasks.length === 0) return null;

  const lines = ['[PRD Lake] 진행 중인 작업이 있습니다:'];

  const items = tasks.slice(0, 5).map(task => {
    const specPath = path.join(INPROGRESS, task.name, 'spec.md');
    const dateStr = getUpdatedDate(specPath);
    const stale = isStale(dateStr) ? ' (stale)' : '';
    const date = dateStr ? dateStr.slice(0, 10) : '?';
    return `  - ${task.name} (${date})${stale}`;
  });

  lines.push(...items);

  if (tasks.length > 5) {
    lines.push(`  ... 외 ${tasks.length - 5}개`);
  }

  lines.push('`/lake resume`로 이어서 할 수 있습니다.');

  return lines.join('\n');
}

// --- lake 실행 스크립트 자동 등록 ---
function ensureLakeCommand() {
  const binDir = path.join(process.env.HOME, '.local', 'bin');
  const binPath = path.join(binDir, 'lake');

  try {
    if (!fs.existsSync(binPath)) {
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(binPath, '#!/bin/sh\nnode ~/.claude/prd-lake/lake-cli.js "$@"\n');
      fs.chmodSync(binPath, 0o755);
    }
  } catch {
    // 등록 실패해도 세션 시작 차단 안 함
  }
}

try {
  ensureLakeCommand();
} catch {}

try {
  archiveOldDone();
} catch {
  // 아카이브 실패해도 세션 시작 차단 안 함
}

let message = '';
try {
  message = buildNotification() || '';
} catch {
  // 알림 실패해도 세션 시작 차단 안 함
}

const result = JSON.stringify({
  continue: true,
  suppressOutput: false,
  message
});
process.stdout.write(result);
