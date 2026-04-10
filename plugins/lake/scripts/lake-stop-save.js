#!/usr/bin/env node

/**
 * PRD Lake Stop Hook
 *
 * 세션 정상 종료 시 inprogress 태스크의 Updated 타임스탬프를 갱신한다.
 * 자동으로 새 lake 파일을 생성하지는 않는다 (의도적 저장만).
 */

const fs = require('fs');
const path = require('path');

const LAKE_DIR = path.join(process.env.HOME, '.claude', 'prd-lake', 'inprogress');

function updateTimestamps() {
  if (!fs.existsSync(LAKE_DIR)) {
    return;
  }

  const tasks = fs.readdirSync(LAKE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  if (tasks.length === 0) {
    return;
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);

  for (const task of tasks) {
    const specPath = path.join(LAKE_DIR, task.name, 'spec.md');
    if (!fs.existsSync(specPath)) continue;

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
}

try {
  updateTimestamps();
} catch {
  // 조용히 실패
}

// Stop hook은 절대 세션 종료를 차단하지 않는다
const result = JSON.stringify({ continue: true, suppressOutput: true });
process.stdout.write(result);
