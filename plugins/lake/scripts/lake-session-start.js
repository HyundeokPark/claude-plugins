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

  const tasksWithDate = tasks.map(task => {
    const specPath = path.join(INPROGRESS, task.name, 'spec.md');
    const dateStr = getUpdatedDate(specPath);
    return { name: task.name, dateStr };
  });

  const topThree = tasksWithDate
    .slice()
    .sort((a, b) => {
      const da = a.dateStr ? new Date(a.dateStr.replace(' ', 'T')).getTime() : 0;
      const db = b.dateStr ? new Date(b.dateStr.replace(' ', 'T')).getTime() : 0;
      return db - da;
    })
    .slice(0, 3);

  const staleItems = tasksWithDate.filter(t => isStale(t.dateStr));
  const stale = staleItems.length > 0;
  const staleCount = staleItems.length;

  const lines = [
    `[PRD Lake] 진행 중 ${tasks.length}개 (최근: ${topThree.map(t => t.name).join(', ')})`,
    stale ? `⚠ ${staleCount}개 stale (7일+)` : '모두 최근 업데이트',
    '`/lake resume`으로 이어서 할 수 있습니다.',
  ];

  return lines.join('\n');
}

// --- lake-cli.js 자동 배포 + 실행 스크립트 등록 ---
function ensureLakeSetup() {
  // 1. lake-cli.js를 ~/.claude/prd-lake/로 복사
  const cliSrc = path.join(__dirname, 'lake-cli.js');
  const cliDst = path.join(LAKE_DIR, 'lake-cli.js');
  fs.mkdirSync(LAKE_DIR, { recursive: true });
  // 항상 최신 버전으로 덮어쓰기
  if (fs.existsSync(cliSrc)) {
    const tmp = cliDst + '.tmp.' + process.pid;
    fs.copyFileSync(cliSrc, tmp);
    fs.renameSync(tmp, cliDst);
    // version 로그 기록 (stderr, 배포 확인용)
    try {
      const versionMatch = fs.readFileSync(cliSrc, 'utf8').match(/LAKE_CLI_VERSION\s*=\s*['"]([^'"]+)['"]/);
      if (versionMatch) {
        process.stderr.write(`[lake-session-start] deployed lake-cli v${versionMatch[1]}\n`);
      }
    } catch {
      // 버전 파싱 실패해도 블록되지 않음
    }
  }

  // 2. ~/.local/bin/lake 실행 스크립트 생성
  const binDir = path.join(process.env.HOME, '.local', 'bin');
  const binPath = path.join(binDir, 'lake');
  if (!fs.existsSync(binPath)) {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(binPath, '#!/bin/sh\nnode ~/.claude/prd-lake/lake-cli.js "$@"\n');
    fs.chmodSync(binPath, 0o755);
  }
}

try {
  ensureLakeSetup();
} catch {
  // 설정 실패해도 세션 시작 차단 안 함
}

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
