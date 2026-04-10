#!/usr/bin/env node

/**
 * PRD Lake Reminder Hook (PostToolUse)
 *
 * 30분마다 한 번씩 AI에게 /lake save 리마인더를 주입한다.
 * - inprogress 태스크가 있으면: "업데이트하세요"
 * - 없으면: "저장할 작업이 있으면 /lake save 하세요"
 */

const fs = require('fs');
const path = require('path');

const LAKE_DIR = path.join(process.env.HOME, '.claude', 'prd-lake');
const INPROGRESS = path.join(LAKE_DIR, 'inprogress');
const MARKER_FILE = path.join(LAKE_DIR, '.last-reminder');
const INTERVAL_MS = 30 * 60 * 1000; // 30분

function shouldRemind() {
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

let message = '';

if (shouldRemind()) {
  if (hasInprogressTasks()) {
    message = '[PRD Lake] 진행 중인 작업이 있습니다. 변경사항이 있으면 `/lake save`로 업데이트하세요.';
  } else {
    message = '[PRD Lake] 저장할 작업이 있으면 `/lake save "제목"`으로 진행 상황을 저장하세요.';
  }
}

process.stdout.write(JSON.stringify({ message }));
