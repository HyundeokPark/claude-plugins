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

async function main() {
  const payload = await spool.readStdinJson();
  try {
    updateTimestamp(payload.session_id);
  } catch {
    // 조용히 실패
  }
  // Stop hook은 절대 세션 종료를 차단하지 않는다
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

main().catch(() => process.stdout.write(JSON.stringify({ continue: true })));
