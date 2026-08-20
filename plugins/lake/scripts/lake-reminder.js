#!/usr/bin/env node

/**
 * PRD Lake Reminder Hook (PostToolUse)
 *
 * 1. 도구 호출 이벤트를 세션 spool에 기록한다 (자동 저장의 원본 로그).
 * 2. 60분마다 한 번씩 AI에게 /lake save 리마인더를 주입한다.
 *    - inprogress 태스크가 있으면: "업데이트하세요"
 *    - 없으면: "저장할 작업이 있으면 /lake save 하세요"
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const spool = require('./lake-spool');

const LAKE_DIR = path.join(process.env.HOME, '.claude', 'prd-lake');
const INPROGRESS = path.join(LAKE_DIR, 'inprogress');
const MARKER_FILE = path.join(LAKE_DIR, '.last-reminder');
const INTERVAL_MS = 60 * 60 * 1000; // 60분

// --- 세션 중간 플러시 ---
//
// 왜 필요한가: spool을 태스크에 반영하는 경로는 SessionEnd 훅과 30분 묵은 고아 복구,
// 둘뿐이었다. 세션을 여러 개 띄워놓고 오래 유지하면 둘 다 안 걸려서, 자동 기록이
// 사흘씩 비었다 (compactor.log 실측: 08-18 이후 성공 0건).
//
// "AI에게 /lake save 하라고 시키기"는 이미 있었고 실패했다 — 리마인더 문구는
// 트랜스크립트에 49번 실제로 주입됐는데도 기록은 남지 않았다. 그래서 시키지 않고
// 훅이 직접 한다.
//
// detached spawn이라 메인 세션을 점유하지 않는다. compactor 쪽 방어는 그대로 살아
// 있다: `.processing` rename lock(이중 처리), context.md mtime 비교(수동 저장 우선),
// `<!-- lake:auto-recap -->` 마커(손으로 쓴 요약 보존).
const FLUSH_DIR = path.join(spool.SPOOL_DIR, 'flush');
const FLUSH_SOFT_MS = 30 * 60 * 1000;   // 많이 쌓였으면 30분마다
const FLUSH_HARD_MS = 60 * 60 * 1000;   // 조금이라도 쌓였으면 60분마다
const FLUSH_SOFT_BYTES = 32 * 1024;
const FLUSH_HARD_BYTES = 4 * 1024;

function shouldRemind() {
  const OFF_FILE = path.join(LAKE_DIR, '.reminder-off');
  if (fs.existsSync(OFF_FILE)) return false;
  const now = Date.now();

  try {
    if (fs.existsSync(MARKER_FILE)) {
      const last = parseInt(fs.readFileSync(MARKER_FILE, 'utf-8').trim(), 10);
      if (now - last < INTERVAL_MS) return false;
    }
  } catch {
    // 파일 읽기 실패 시 리마인더 보냄
  }

  // 마커 갱신
  try {
    fs.mkdirSync(LAKE_DIR, { recursive: true });
    fs.writeFileSync(MARKER_FILE, String(now), 'utf-8');
  } catch {
    // 마커 기록 실패해도 계속
  }

  return true;
}

function hasInprogressTasks() {
  try {
    if (!fs.existsSync(INPROGRESS)) return false;
    const dirs = fs.readdirSync(INPROGRESS, { withFileTypes: true })
      .filter(d => d.isDirectory());
    return dirs.length > 0;
  } catch {
    return false;
  }
}

function statMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

// 이 세션이 어떤 태스크에 붙어 있는지. 마커가 없으면 플러시하지 않는다 —
// 귀속처 없는 compact는 unfiled 파일만 만들고 끝난다.
function hasTaskMarker(sessionId) {
  const f = path.join(spool.SPOOL_DIR, 'markers', sessionId + '.json');
  try {
    const m = JSON.parse(fs.readFileSync(f, 'utf-8'));
    return !!(m.slug && fs.existsSync(path.join(INPROGRESS, m.slug)));
  } catch {
    return false;
  }
}

function shouldFlush(sessionId) {
  if (!sessionId) return false;
  if (process.env.LAKE_COMPACTOR === '1') return false;  // 재귀 방지
  if (!hasTaskMarker(sessionId)) return false;

  const file = spool.spoolPath(sessionId);
  let size;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size < FLUSH_HARD_BYTES) return false;

  // 처리 중인 게 있으면 겹치지 않게 넘어간다 (lock이 막아주긴 하지만 헛spawn 방지)
  if (fs.existsSync(file + '.processing')) return false;

  // 기준점: 마지막 플러시. 없으면 마커가 찍힌 시각(= 이 세션이 태스크를 잡은 때).
  const stampPath = path.join(FLUSH_DIR, sessionId);
  const last = statMs(stampPath) || statMs(path.join(spool.SPOOL_DIR, 'markers', sessionId + '.json'));
  if (!last) return false;
  const age = Date.now() - last;

  if (age >= FLUSH_HARD_MS) return true;
  if (age >= FLUSH_SOFT_MS && size >= FLUSH_SOFT_BYTES) return true;
  return false;
}

function flush(sessionId) {
  // 스탬프를 spawn **전에** 찍는다. compactor가 실패해도 매 도구 호출마다
  // 다시 띄우는 폭주를 막아야 한다 — 다음 기회는 규칙대로 30/60분 뒤다.
  try {
    fs.mkdirSync(FLUSH_DIR, { recursive: true });
    fs.writeFileSync(path.join(FLUSH_DIR, sessionId), String(Date.now()), 'utf-8');
  } catch {
    return; // 스탬프를 못 남기면 폭주 위험이 있으니 아예 안 띄운다
  }
  try {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'lake-compactor.js'), spool.spoolPath(sessionId), '--mid-session'],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch {
    // 플러시 실패가 훅을 실패시켜선 안 된다
  }
}

async function main() {
  const payload = await spool.readStdinJson();

  spool.append(payload.session_id, {
    e: 'tool',
    name: payload.tool_name,
    in: spool.briefInput(payload.tool_input),
    out: spool.briefOutput(payload.tool_response),
    cwd: payload.cwd,
  });

  // 기록은 훅이 직접 한다. 이벤트를 append한 **뒤**에 판단해야 방금 것까지 들어간다.
  try {
    if (shouldFlush(payload.session_id)) flush(payload.session_id);
  } catch {
    // 플러시 판단 실패가 리마인더나 훅을 막아선 안 된다
  }

  let message = '';

  if (shouldRemind()) {
    if (hasInprogressTasks()) {
      message = '[PRD Lake] 진행 중인 작업이 있습니다. 변경사항이 있으면 `/lake save`로 업데이트하세요.';
    } else {
      message = '[PRD Lake] 저장할 작업이 있으면 `/lake save "제목"`으로 진행 상황을 저장하세요.';
    }
  }

  // `message` 필드는 훅 규격에 없어 버려진다 — AI에게는 additionalContext로 주입해야 한다.
  const result = {};
  if (message) {
    result.hookSpecificOutput = {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    };
  }
  process.stdout.write(JSON.stringify(result));
}

main().catch(() => process.stdout.write('{}'));
