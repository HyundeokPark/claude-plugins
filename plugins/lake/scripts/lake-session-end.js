#!/usr/bin/env node
/**
 * PRD Lake SessionEnd Hook
 *
 * 세션 정상 종료 시 이 세션의 spool을 compactor에 넘긴다 (detached —
 * 세션 종료를 블록하지 않음). 크래시로 이 훅이 못 돌면 다음 SessionStart의
 * 고아 spool 복구가 처리한다.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const spool = require('./lake-spool');

async function main() {
  const payload = await spool.readStdinJson();
  const sid = payload.session_id;
  if (!sid || process.env.LAKE_COMPACTOR === '1') return;

  const file = spool.spoolPath(sid);
  if (!fs.existsSync(file)) return;

  const child = spawn(process.execPath, [path.join(__dirname, 'lake-compactor.js'), file], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

main().catch(() => { /* 조용히 실패 — 종료를 막지 않는다 */ })
  .finally(() => process.stdout.write('{}'));
