#!/usr/bin/env node

/**
 * PRD Lake SessionStart Hook
 *
 * 세션 시작 시:
 * 1. inprogress 태스크가 있으면 요약 알림 표시
 * 2. done/ 중 30일+ 항목을 archive/{yyyy-MM}/로 자동 이동
 * 3. 고아 spool(크래시로 SessionEnd가 못 돈 세션의 활동 로그) 복구 — compactor 재실행
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const spool = require('./lake-spool');
const plan = require('./lake-plan');

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

// --- 신규 세션 자동 브리핑 (AI 컨텍스트 주입용) ---
// 사용자가 인수인계 문서를 직접 열지 않아도, 새 세션의 AI가 최근 태스크의
// 마지막 상태(compactor가 갱신한 자동 상태 섹션)를 알고 시작하게 한다.

function readAutoContext(slug) {
  try {
    const c = fs.readFileSync(path.join(INPROGRESS, slug, 'context.md'), 'utf-8');
    const m = c.match(/<!-- lake:auto-context:start -->[\s\S]*?\n([\s\S]*?)<!-- lake:auto-context:end -->/);
    if (!m) return null;
    const body = m[1].replace(/^## .*\n/, '').trim();
    return body ? body.slice(0, 300) : null;
  } catch {
    return null;
  }
}

function buildBriefing(cwd) {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(LAKE_DIR, 'index.json'), 'utf-8'));
    const inprog = index.filter(t => t.status === 'inprogress');
    if (inprog.length === 0) return '';

    // cwd가 태스크의 project와 맞으면 우선, 그 다음 최근 갱신순
    const base = cwd ? path.basename(cwd) : '';
    inprog.sort((a, b) => {
      const ap = base && a.project && base.includes(String(a.project)) ? 1 : 0;
      const bp = base && b.project && base.includes(String(b.project)) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return String(b.updated || '').localeCompare(String(a.updated || ''));
    });

    const lines = [];
    for (const t of inprog.slice(0, 3)) {
      lines.push(`- [${t.id}] ${t.title} (${t.project || '-'}, updated ${t.updated})`);
      const auto = readAutoContext(t.slug);
      if (auto) lines.push('  ' + auto.replace(/\n/g, '\n  '));
      // 자동 기록(journal/context)은 훅이 갱신하지만 plan.md는 사람·AI 재량이라
      // 혼자 썩는다. 낡은 채로 브리핑하면 다음 세션이 죽은 할 일을 보고한다.
      const stale = plan.planStaleInfo(path.join(INPROGRESS, t.slug));
      if (stale) {
        lines.push(`  ⚠ plan.md가 저널보다 낡음 (plan ${stale.planDate} < journal ${stale.journalDate})` +
          ` — 할 일 목록을 그대로 믿지 말고 \`lake-cli.js plan-check ${t.id}\` 를 먼저 실행하라.`);
      }
    }

    return `[PRD Lake 자동 브리핑] 최근 진행 중 태스크와 마지막 상태:\n${lines.join('\n')}\n` +
      '→ 사용자의 요청이 위 태스크 중 하나를 이어가는 것이면, 작업 시작 전에 ' +
      '`node ~/.claude/prd-lake/lake-cli.js resume <id>`를 Bash로 실행해 전체 컨텍스트를 로드하라 ' +
      '(이 세션의 자동 기록이 그 태스크로 귀속되는 마커도 이때 찍힌다).';
  } catch {
    return '';
  }
}

// --- lake-cli.js 자동 배포 + 실행 스크립트 등록 ---
function ensureLakeSetup() {
  // 1. lake-cli.js를 ~/.claude/prd-lake/로 복사
  const cliSrc = path.join(__dirname, 'lake-cli.js');
  const cliDst = path.join(LAKE_DIR, 'lake-cli.js');
  fs.mkdirSync(LAKE_DIR, { recursive: true });

  // lake-cli.js가 require하는 모듈을 **먼저** 배포한다. 순서가 뒤집히면
  // 새 cli는 배포됐는데 의존 모듈이 없는 순간이 생겨 lake 전체가 죽는다.
  for (const dep of ['lake-plan.js']) {
    const depSrc = path.join(__dirname, dep);
    if (!fs.existsSync(depSrc)) continue;
    const depDst = path.join(LAKE_DIR, dep);
    const depTmp = depDst + '.tmp.' + process.pid;
    fs.copyFileSync(depSrc, depTmp);
    fs.renameSync(depTmp, depDst);
  }

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

// 크래시 등으로 compactor가 처리 못 한 spool을 발견하면 재실행한다.
// mtime 30분 이내는 살아있는 세션(열어두고 잠시 조용한 것 포함)일 수 있으므로 건너뛴다.
// (기존 2분 가드는 조용히 열려있는 세션의 spool을 고아로 오판 → compact 후 마커까지
// 지워버려 그 세션의 이후 기록이 unfiled로 빠졌다)
function recoverOrphanSpools(currentSessionId) {
  if (process.env.LAKE_COMPACTOR === '1') return;
  if (!fs.existsSync(spool.SPOOL_DIR)) return;

  const now = Date.now();

  // 크래시한 compactor가 방치한 .processing lock 복원 (10분 이상 방치된 것만 —
  // 그보다 어리면 지금 처리 중일 수 있다). 되돌린 파일은 아래 고아 복구가 다시 잡는다.
  try {
    for (const f of fs.readdirSync(spool.SPOOL_DIR)) {
      if (!f.endsWith('.jsonl.processing')) continue;
      const full = path.join(spool.SPOOL_DIR, f);
      if (now - fs.statSync(full).mtimeMs > 10 * 60 * 1000) {
        fs.renameSync(full, full.replace(/\.processing$/, ''));
      }
    }
  } catch { /* 복원 실패해도 세션 시작 차단 안 함 */ }

  const files = fs.readdirSync(spool.SPOOL_DIR).filter(f => f.endsWith('.jsonl'));
  let spawned = 0;

  for (const f of files) {
    if (spawned >= 3) break; // 세션 시작당 복구 상한
    if (currentSessionId && f === `${currentSessionId}.jsonl`) continue;
    const full = path.join(spool.SPOOL_DIR, f);
    try {
      if (now - fs.statSync(full).mtimeMs < 30 * 60 * 1000) continue;
      const child = spawn(process.execPath, [path.join(__dirname, 'lake-compactor.js'), full], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      spawned++;
    } catch {
      // 복구 실패해도 세션 시작 차단 안 함
    }
  }

  // spool 없이 남은 고아 마커(세션별 태스크 귀속 기록) 청소 — 7일 지난 것
  try {
    const markersDir = path.join(spool.SPOOL_DIR, 'markers');
    if (fs.existsSync(markersDir)) {
      for (const m of fs.readdirSync(markersDir)) {
        const mf = path.join(markersDir, m);
        if (now - fs.statSync(mf).mtimeMs > 7 * 24 * 60 * 60 * 1000) fs.unlinkSync(mf);
      }
    }
  } catch {
    // 청소 실패해도 세션 시작 차단 안 함
  }
}

async function main() {
  const payload = await spool.readStdinJson();

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

  try {
    recoverOrphanSpools(payload.session_id);
  } catch {
    // 복구 실패해도 세션 시작 차단 안 함
  }

  let message = '';
  try {
    message = buildNotification() || '';
  } catch {
    // 알림 실패해도 세션 시작 차단 안 함
  }

  let briefing = '';
  try {
    briefing = buildBriefing(payload.cwd) || '';
  } catch {
    // 브리핑 실패해도 세션 시작 차단 안 함
  }

  // `message`는 Claude Code 훅 규격에 없는 필드라 조용히 버려진다 (과거 버그).
  // 사용자 화면에는 systemMessage(짧은 목록), AI 컨텍스트에는 additionalContext
  // (목록 + 태스크별 마지막 상태 브리핑)로 전달한다.
  const result = { continue: true };
  if (message) result.systemMessage = message;
  const context = [message, briefing].filter(Boolean).join('\n\n');
  if (context) {
    result.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: context,
    };
  }
  process.stdout.write(JSON.stringify(result));
}

main().catch(() => process.stdout.write(JSON.stringify({ continue: true })));
