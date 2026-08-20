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
const recap = require('./lake-recap');

const LAKE_DIR = path.join(process.env.HOME, '.claude', 'prd-lake');
const INPROGRESS = path.join(LAKE_DIR, 'inprogress');
const SPOOL_DIR = path.join(LAKE_DIR, '.spool');
const UNFILED_DIR = path.join(SPOOL_DIR, 'unfiled');
const MARKERS_DIR = path.join(SPOOL_DIR, 'markers');
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

// 이 세션의 마커만 읽는다. 전역 마커 폴백은 하지 않는다 —
// 병렬 세션 환경에서 다른 세션의 태스크로 오염되는 것보다 unfiled 보존이 안전하다.
function readActiveTask(sessionId) {
  try {
    const markerFile = path.join(MARKERS_DIR, sessionId + '.json');
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf-8'));
    if (!marker.slug || !marker.at) return null;
    if (Date.now() - new Date(marker.at).getTime() > MARKER_MAX_AGE_MS) return null;
    if (!fs.existsSync(path.join(INPROGRESS, marker.slug))) return null;
    return marker;
  } catch {
    return null;
  }
}

function removeMarker(sessionId) {
  try { fs.unlinkSync(path.join(MARKERS_DIR, sessionId + '.json')); } catch { /* 없으면 무시 */ }
}

// spool 타임라인을 'task' 이벤트(resume/save 순간) 기준으로 구간 분리한다.
// 한 세션에서 태스크를 오가도 각 구간이 맞는 태스크로 귀속된다.
// 첫 resume 이전의 활동(탐색하다 resume하는 패턴)은 첫 태스크 구간에 합친다.
function segmentByTask(events) {
  const segments = [];
  let current = null;
  const pre = [];
  for (const ev of events) {
    if (ev.e === 'task' && ev.slug) {
      if (current && current.task.slug === ev.slug) continue; // 같은 태스크 재-resume은 구간 유지
      if (current) segments.push(current);
      current = { task: { id: ev.id, slug: ev.slug }, events: [] };
    } else if (current) {
      current.events.push(ev);
    } else {
      pre.push(ev);
    }
  }
  if (current) segments.push(current);
  if (segments.length > 0 && pre.length > 0) {
    segments[0].events = pre.concat(segments[0].events);
  }
  return { segments, unsegmented: segments.length === 0 ? pre : [] };
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
3) RECAP — 사람이 읽는 요약. 2~3문장, 120~180자. 라벨·불릿·마크다운 금지, 줄바꿈 없이.
   "무엇을 하던 중인지 → 어디까지 됐는지 → 다음은 무엇인지" 순서로 자연스러운 한국어 서술.
   예: "HeyPoll 시크릿을 금고로 옮기는 작업이고, 로컬 검증은 backend·scheduler 모두 통과했습니다.
   다음은 콘솔에서 금고를 만들고 값 20개를 넣는 것입니다."

출력 형식을 정확히 지켜라 (다른 텍스트 금지):
===JOURNAL===
- ...
===CONTEXT===
현재: ...
다음: ...
블로커: ...
===RECAP===
...

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
  // RECAP은 선택 블록이다 — 없어도 실패시키지 않는다 (사람용 요약은 away_summary
  // 수확이 1순위이고 이건 폴백일 뿐, 이것 때문에 journal/context를 버리면 손해다).
  const rest = m[2].split(/===RECAP===/);
  const context = rest[0].trim();
  const recapText = (rest[1] || '').trim();
  if (!journal || !context) return null;
  return { journal, context, recap: recapText || null };
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

function updateContext(taskDir, context, lastEventTs) {
  const file = path.join(taskDir, 'context.md');
  // 수동 save(/lake save)가 spool의 마지막 이벤트보다 나중에 context.md를 갱신했다면
  // 그쪽이 더 최신 상태다 — 과거 이벤트를 요약한 auto-context로 되돌리지 않는다.
  // (과거: 늦게 돈 compactor가 새 세션의 수동 정리를 낡은 요약으로 덮음)
  try {
    if (lastEventTs && fs.existsSync(file) && fs.statSync(file).mtimeMs > lastEventTs) {
      log(`context-skip: ${path.basename(taskDir)} (수동 context.md가 spool보다 최신)`);
      return;
    }
  } catch { /* stat 실패 시 그냥 진행 */ }
  // 헤딩에 날짜를 박는다. 이게 없으면 brief가 수동 `## 지금 상태` 와 자동 요약 중
  // 어느 쪽이 최신인지 판단할 수 없어, 낡은 수동 섹션이 갓 만든 자동 요약을 이긴다.
  const stamp = new Date().toISOString().slice(0, 10);
  const section = `${AUTO_START}\n## 자동 상태 (compactor, ${stamp})\n${context}\n${AUTO_END}`;
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

function moveToUnfiled(file, originalName) {
  fs.mkdirSync(UNFILED_DIR, { recursive: true });
  fs.renameSync(file, path.join(UNFILED_DIR, originalName));
}

function main() {
  const args = process.argv.slice(2);
  // --mid-session: 아직 살아있는 세션의 spool을 중간에 비울 때 쓴다.
  // 차이는 딱 하나 — 마커를 지우지 않는다. 마커를 지우면 그 세션의 이후 활동이
  // 태스크 귀속을 잃고 unfiled로 빠진다 (세션 종료용 코드를 그대로 쓰면 나는 사고).
  const midSession = args.includes('--mid-session');
  const spoolFile = args.find(a => !a.startsWith('--'));
  if (!spoolFile || !fs.existsSync(spoolFile)) return;
  const sessionId = path.basename(spoolFile, '.jsonl');

  // 이중 실행 방지 lock: 처리 전 원자적 rename으로 선점한다.
  // SessionEnd 훅과 다른 세션의 SessionStart 고아 복구가 같은 spool을 동시에 잡아도
  // rename은 한 쪽만 성공한다. (과거: 동일 spool 2회 처리 → journal 중복 append)
  // 크래시로 방치된 .processing은 SessionStart 복구가 .jsonl로 되돌린다.
  const procFile = spoolFile + '.processing';
  try {
    fs.renameSync(spoolFile, procFile);
  } catch {
    return; // 다른 compactor가 선점
  }

  const events = readEvents(procFile);
  if (events.length < MIN_EVENTS) {
    fs.unlinkSync(procFile);
    if (!midSession) removeMarker(sessionId);
    return;
  }

  // spool의 마지막 이벤트 시각 — context.md 수동 갱신이 이보다 나중이면 auto-context를 덮지 않는다
  const lastEventTs = events.reduce((max, ev) => {
    const t = new Date(ev.t || 0).getTime();
    return t > max ? t : max;
  }, 0);

  const { segments, unsegmented } = segmentByTask(events);

  // task 이벤트가 없는 spool(resume 없는 세션 또는 구버전 cli): 세션 마커 폴백
  if (segments.length === 0) {
    const task = readActiveTask(sessionId);
    if (!task) {
      moveToUnfiled(procFile, path.basename(spoolFile));
      log(`unfiled: ${path.basename(spoolFile)} (${events.length} events, no session marker)`);
      return;
    }
    segments.push({ task, events: unsegmented });
  }

  let failed = 0;
  for (const seg of segments) {
    if (seg.events.length < MIN_EVENTS) continue; // resume만 찍고 지나간 구간
    const taskDir = path.join(INPROGRESS, seg.task.slug);
    if (!fs.existsSync(taskDir)) {
      log(`skip: ${seg.task.slug} (inprogress에 없음, ${seg.events.length} events)`);
      continue;
    }
    try {
      const blocks = parseBlocks(summarize(buildPrompt(seg.task, seg.events)));
      if (!blocks) {
        failed++;
        log(`parse-fail: ${path.basename(spoolFile)} → ${seg.task.slug}`);
        continue;
      }
      appendJournal(taskDir, blocks.journal, seg.events.length);
      updateContext(taskDir, blocks.context, lastEventTs);

      // 사람용 요약(📍): Claude Code가 이미 쓴 away_summary를 1순위로 수확한다.
      // 대화 전체를 보고 쓴 것이라 spool(도구 호출·프롬프트만)로 만든 것보다 정확하다.
      // 없는 세션(자리를 비우지 않았으면 안 생긴다)은 haiku RECAP 블록으로 대체.
      try {
        const harvested = recap.harvest(sessionId, seg.events, recap.eventsCwd(seg.events));
        const text = harvested || blocks.recap;
        if (text) {
          const source = harvested ? 'away_summary' : 'haiku';
          const result = recap.writeRecap(taskDir, text, new Date().toISOString().slice(0, 10), source);
          log(`recap-${result}: ${seg.task.slug} (${source})`);
        } else {
          log(`recap-none: ${seg.task.slug}`);
        }
      } catch (e) {
        // 사람용 요약 실패는 journal/context 저장을 되돌릴 이유가 못 된다
        log(`recap-error: ${seg.task.slug}: ${e.message}`);
      }

      log(`ok${midSession ? '(mid)' : ''}: ${path.basename(spoolFile)} → ${seg.task.slug} (${seg.events.length} events)`);
    } catch (e) {
      failed++;
      log(`error: ${seg.task.slug}: ${e.message}`);
    }
  }

  if (failed === 0) {
    fs.unlinkSync(procFile);
    // 중간 플러시는 마커를 남긴다 — 세션이 계속 이 태스크에 기록해야 한다.
    if (!midSession) removeMarker(sessionId);
  } else {
    // 실패 구간 재시도를 위해 spool 복원 → 다음 세션에서 재시도
    // (성공한 구간은 재시도 시 journal에 중복될 수 있음 — log 참조)
    try { fs.renameSync(procFile, spoolFile); } catch { /* best-effort */ }
    process.exitCode = 1;
  }
}

try {
  main();
} catch (e) {
  log(`error: ${e.message} — spool 유지`);
  process.exitCode = 1;
}
