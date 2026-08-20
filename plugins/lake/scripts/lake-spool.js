/**
 * lake-spool.js — 세션 활동 spool 공용 모듈
 *
 * 훅(UserPromptSubmit/PostToolUse)이 세션 이벤트를 JSONL로 append한다.
 * LLM 호출 없음, append 1회 ~0.1ms. 세션 종료/크래시 후 lake-compactor.js가
 * journal(정제)·context(요약)로 반영하고 spool을 삭제한다.
 */

const fs = require('fs');
const path = require('path');

const LAKE_DIR = path.join(process.env.HOME, '.claude', 'prd-lake');
const SPOOL_DIR = path.join(LAKE_DIR, '.spool');
const ACTIVE_TASK_PATH = path.join(LAKE_DIR, '.active-task');

function clip(v, n) {
  const s = typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v));
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// tool_input에서 사람이 알아볼 핵심 한 조각만 뽑는다
function briefInput(input) {
  if (input == null) return '';
  if (typeof input !== 'object') return clip(input, 200);
  const keys = ['description', 'command', 'file_path', 'pattern', 'query', 'url', 'prompt', 'skill'];
  for (const k of keys) {
    if (input[k]) return clip(`${k}=${input[k]}`, 300);
  }
  return clip(input, 200);
}

// tool_response는 거대할 수 있다 — 전체 stringify 전에 대표 필드만 집는다
function briefOutput(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return clip(resp, 200);
  if (typeof resp !== 'object') return clip(resp, 200);
  if (resp.error) return 'ERR: ' + clip(resp.error, 180);
  if (resp.stdout) return clip(resp.stdout, 200);
  if (resp.content) return clip(resp.content, 200);
  return '[ok]';
}

function spoolPath(sessionId) {
  return path.join(SPOOL_DIR, sessionId + '.jsonl');
}

function append(sessionId, event) {
  if (!sessionId) return;
  // compactor가 띄운 headless claude 세션은 기록하지 않는다 (재귀 방지)
  if (process.env.LAKE_COMPACTOR === '1') return;
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
    const line = JSON.stringify({ t: new Date().toISOString(), ...event });
    fs.appendFileSync(spoolPath(sessionId), line + '\n');
  } catch {
    // spool은 best-effort — 훅을 절대 실패시키지 않는다
  }
}

function readStdinJson(timeoutMs = 800) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    // 타임아웃으로 끝났는데 stdin이 아직 열려 있으면(파이프 상대가 안 닫는 경우),
    // 'data' 리스너가 핸들을 붙들어 이벤트 루프가 죽지 않는다 → 훅 프로세스가
    // 영영 안 끝난다. 실제로 이 상태로 테스트 러너가 멈췄다. 끝나면 반드시 놓는다.
    const release = () => {
      try {
        process.stdin.removeListener('data', onData);
        process.stdin.removeListener('end', finish);
        process.stdin.removeListener('error', finish);
        process.stdin.pause();
      } catch { /* 정리 실패가 결과를 바꿔선 안 된다 */ }
    };
    const onData = (c) => chunks.push(c);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      release();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch { resolve({}); }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', onData);
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

module.exports = {
  LAKE_DIR, SPOOL_DIR, ACTIVE_TASK_PATH,
  clip, briefInput, briefOutput, spoolPath, append, readStdinJson,
};
