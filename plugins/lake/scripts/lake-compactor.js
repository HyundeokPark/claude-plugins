#!/usr/bin/env node
/**
 * lake-compactor.js — 세션 spool을 lake 태스크에 자동 반영
 *
 * Usage: node lake-compactor.js <spool-file>
 *
 * Stop 훅(정상 종료) 또는 SessionStart 훅(크래시 복구)이 detached로 띄운다.
 * 처리 규칙:
 *   - journal = 정제 (요약 금지): 노이즈 제거한 시간순 사실 기록을 append
 *   - context = 요약: 자동 섹션(마커 구간)만 덮어쓰기, 수동 작성분은 보존
 *   - 대상 태스크 = .active-task 마커 (24h 유효). 없으면 .spool/unfiled/ 보존
 *   - 성공 시 spool 삭제, 실패 시 spool 유지 (다음 SessionStart가 재시도)
 * 요약 LLM: `claude -p --model haiku` (LAKE_SUMMARIZER_CMD로 대체 가능 — 테스트용).
 * 재귀 방지: headless claude에 LAKE_COMPACTOR=1을 심어 그 세션의 훅이 spool을 남기지 않게 한다.
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const LAKE_DIR = path.join(process.env.HOME, '.claude', 'prd-lake');
const INPROGRESS = path.join(LAKE_DIR, 'inprogress');
const SPOOL_DIR = path.join(LAKE_DIR, '.spool');
const UNFILED_DIR = path.join(SPOOL_DIR, 'unfiled');
const ACTIVE_TASK_PATH = path.join(LAKE_DIR, '.active-task');
const LOG_PATH = path.join(SPOOL_DIR, 'compactor.log');

const MIN_EVENTS = 3;          // 이보다 적으면 기록할 가치 없음 → spool 폐기
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROMPT_BUDGET = 80 * 1024; // 이벤트 렌더링 상한 (최근 것 우선)

function log(msg) {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* best-effort */ }
}

function readEvents(spoolFile) {
  const lines = fs.readFileSync(spoolFile, 'utf-8').split('\n').filter(Boolean);
  const events = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { /* 깨진 라인 무시 */ }
  }
  return events;
}

function readActiveTask() {
  try {
    const marker = JSON.parse(fs.readFileSync(ACTIVE_TASK_PATH, 'utf-8'));
    if (!marker.slug || !marker.at) return null;
    if (Date.now() - new Date(marker.at).getTime() > MARKER_MAX_AGE_MS) return null;
    if (!fs.existsSync(path.join(INPROGRESS, marker.slug))) return null;
    return marker;
  } catch {
    return null;
  }
}

function renderEvents(events) {
  const rendered = events.map((ev) => {
    const hm = (ev.t || '').slice(11, 16);
    if (ev.e === 'prompt') return `${hm} [사용자] ${ev.text || ''}`;
    const out = ev.out ? ` → ${ev.out}` : '';
    return `${hm} [${ev.name || 'tool'}] ${ev.in || ''}${out}`;
  });
  // 예산 초과 시 최근 이벤트 우선 (뒤에서부터 채움)
  let total = 0;
  const kept = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    total += rendered[i].length + 1;
    if (total > PROMPT_BUDGET) break;
    kept.unshift(rendered[i]);
  }
  const dropped = rendered.length - kept.length;
  return (dropped > 0 ? `(앞부분 ${dropped}개 이벤트 생략)\n` : '') + kept.join('\n');
}

function buildPrompt(task, events) {
  return `아래는 Claude Code 세션의 활동 로그다. lake 태스크 "${task.slug}"에 기록할 두 산출물을 만들어라.

1) JOURNAL — 요약 금지, 정제만 한다. 파일 읽기·검색·조회 같은 탐색 노이즈는 버리고,
   시간순으로 다음만 bullet(-)로 남긴다: 시도한 것, 결과(성공/실패와 에러 내용),
   내린 결정과 그 근거, 새로 확정한 사실. 5~15줄. 구체적 파일명/명령/값을 보존할 것.
2) CONTEXT — 현재 상태 스냅숏. "현재:", "다음:", "블로커:" 세 줄 형식, 각 1~2문장.

출력 형식을 정확히 지켜라 (다른 텍스트 금지):
===JOURNAL===
- ...
===CONTEXT===
현재: ...
다음: ...
블로커: ...

--- 활동 로그 ---
${renderEvents(events)}`;
}

function summarize(prompt) {
  const custom = process.env.LAKE_SUMMARIZER_CMD;
  const opts = {
    input: prompt,
    encoding: 'utf-8',
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LAKE_COMPACTOR: '1' },
  };
  if (custom) return execSync(custom, opts);
  return execFileSync('claude', ['-p', '--model', 'haiku'], opts);
}

function parseBlocks(output) {
  const m = output.match(/===JOURNAL===\s*([\s\S]*?)===CONTEXT===\s*([\s\S]*)/);
  if (!m) return null;
  const journal = m[1].trim();
  const context = m[2].trim();
  if (!journal || !context) return null;
  return { journal, context };
}

function appendJournal(taskDir, journal, eventCount) {
  const today = new Date().toISOString().slice(0, 10);
  const hm = new Date().toISOString().slice(11, 16);
  const journalDir = path.join(taskDir, 'journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const file = path.join(journalDir, `${today}.md`);
  let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : `# ${today}\n`;
  if (!body.endsWith('\n')) body += '\n';
  body += `\n## 세션 자동 기록 (${hm} UTC, ${eventCount} events)\n${journal}\n`;
  fs.writeFileSync(file, body);
}

const AUTO_START = '<!-- lake:auto-context:start -->';
const AUTO_END = '<!-- lake:auto-context:end -->';

function updateContext(taskDir, context) {
  const file = path.join(taskDir, 'context.md');
  const section = `${AUTO_START}\n## 자동 상태 (compactor)\n${context}\n${AUTO_END}`;
  let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '# Context\n';
  const start = body.indexOf(AUTO_START);
  const end = body.indexOf(AUTO_END);
  if (start >= 0 && end > start) {
    body = body.slice(0, start) + section + body.slice(end + AUTO_END.length);
  } else {
    if (!body.endsWith('\n')) body += '\n';
    body += '\n' + section + '\n';
  }
  fs.writeFileSync(file, body);
}

function moveToUnfiled(spoolFile) {
  fs.mkdirSync(UNFILED_DIR, { recursive: true });
  fs.renameSync(spoolFile, path.join(UNFILED_DIR, path.basename(spoolFile)));
}

function main() {
  const spoolFile = process.argv[2];
  if (!spoolFile || !fs.existsSync(spoolFile)) return;

  const events = readEvents(spoolFile);
  if (events.length < MIN_EVENTS) {
    fs.unlinkSync(spoolFile);
    return;
  }

  const task = readActiveTask();
  if (!task) {
    moveToUnfiled(spoolFile);
    log(`unfiled: ${path.basename(spoolFile)} (${events.length} events, no active task)`);
    return;
  }

  const output = summarize(buildPrompt(task, events));
  const blocks = parseBlocks(output);
  if (!blocks) {
    log(`parse-fail: ${path.basename(spoolFile)} — spool 유지, 다음 세션에서 재시도`);
    process.exitCode = 1;
    return;
  }

  const taskDir = path.join(INPROGRESS, task.slug);
  appendJournal(taskDir, blocks.journal, events.length);
  updateContext(taskDir, blocks.context);
  fs.unlinkSync(spoolFile);
  log(`ok: ${path.basename(spoolFile)} → ${task.slug} (${events.length} events)`);
}

try {
  main();
} catch (e) {
  log(`error: ${e.message} — spool 유지`);
  process.exitCode = 1;
}
