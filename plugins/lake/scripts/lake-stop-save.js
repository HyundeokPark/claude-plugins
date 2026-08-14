#!/usr/bin/env node

/**
 * PRD Lake Stop Hook
 *
 * 세션 정상 종료 시, 이번 세션이 실제로 만진 태스크(.active-task 마커)의
 * Updated 타임스탬프만 갱신한다. 마커가 없거나 오래됐으면 아무것도 하지 않는다.
 * (전체 inprogress 일괄 갱신은 stale 감지를 무력화하므로 금지 — 과거 버그)
 * 자동으로 새 lake 파일을 생성하지는 않는다 (의도적 저장만).
 */

const fs = require('fs');
const path = require('path');
const spool = require('./lake-spool');
const plan = require('./lake-plan');

const LAKE_DIR = path.join(process.env.HOME, '.claude', 'prd-lake');
const INPROGRESS = path.join(LAKE_DIR, 'inprogress');
const ACTIVE_TASK_PATH = path.join(LAKE_DIR, '.active-task');
const MARKERS_DIR = path.join(LAKE_DIR, '.spool', 'markers');
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 마커는 24시간까지만 유효

function parseMarker(file) {
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!marker.slug || !marker.at) return null;
    if (Date.now() - new Date(marker.at).getTime() > MARKER_MAX_AGE_MS) return null;
    return marker;
  } catch {
    return null;
  }
}

// 이 세션의 마커 우선. 없으면 레거시 전역 마커 폴백 (타임스탬프 갱신은 저위험이라 허용).
function readActiveMarker(sessionId) {
  if (sessionId) {
    const m = parseMarker(path.join(MARKERS_DIR, sessionId + '.json'));
    if (m) return m;
  }
  return parseMarker(ACTIVE_TASK_PATH);
}

function updateTimestamp(sessionId) {
  const marker = readActiveMarker(sessionId);
  if (!marker) return;

  const specPath = path.join(INPROGRESS, marker.slug, 'spec.md');
  if (!fs.existsSync(specPath)) return;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);

  try {
    let content = fs.readFileSync(specPath, 'utf-8');
    const updatedRegex = /^- \*\*Updated\*\*: .+$/m;
    if (updatedRegex.test(content)) {
      content = content.replace(updatedRegex, `- **Updated**: ${now}`);
      fs.writeFileSync(specPath, content, 'utf-8');
    }
  } catch {
    // 조용히 실패 — stop을 차단하면 안 됨
  }
}

// 자동 기록 경로(spool→compactor)는 journal/context만 갱신하고 plan.md는 방치한다.
// 그래서 저장은 되는데 "다음 할 일"만 낡는 사고가 난다. 여기서 최소한 경고는 남긴다.
// 매 턴 도는 훅이므로 태스크·날짜당 1회만 알린다 (스팸이면 아무도 안 읽는다).
function planStaleWarning(sessionId) {
  const marker = readActiveMarker(sessionId);
  if (!marker) return null;

  const dir = path.join(INPROGRESS, marker.slug);
  const stale = plan.planStaleInfo(dir);
  if (!stale) return null;

  try {
    const stampPath = path.join(LAKE_DIR, '.plan-stale-warned');
    const key = `${marker.slug}:${stale.journalDate}`;
    const seen = fs.existsSync(stampPath)
      ? fs.readFileSync(stampPath, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean)
      : [];
    if (seen.includes(key)) return null;
    // 최근 20개만 유지 — 무한히 자라면 안 된다
    fs.writeFileSync(stampPath, seen.concat(key).slice(-20).join('\n') + '\n', 'utf-8');
  } catch {
    // 중복 억제 실패는 경고를 막을 이유가 못 된다
  }

  return `[PRD Lake] ⚠ ${marker.slug}의 plan.md가 저널보다 낡음 ` +
    `(plan ${stale.planDate} < journal ${stale.journalDate}). ` +
    '`/lake save` 시 plan-check로 할 일 목록을 맞출 것.';
}

async function main() {
  const payload = await spool.readStdinJson();
  try {
    updateTimestamp(payload.session_id);
  } catch {
    // 조용히 실패
  }

  let warning = null;
  try {
    warning = planStaleWarning(payload.session_id);
  } catch {
    // 경고 실패해도 stop을 막지 않는다
  }

  // Stop hook은 절대 세션 종료를 차단하지 않는다
  const result = { continue: true, suppressOutput: true };
  if (warning) result.systemMessage = warning;
  process.stdout.write(JSON.stringify(result));
}

main().catch(() => process.stdout.write(JSON.stringify({ continue: true })));
