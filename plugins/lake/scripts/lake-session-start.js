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
const recap = require('./lake-recap');
const ctxlib = require('./lake-context');

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

const STATE_MAX_CHARS = 600;

function clipState(text) {
  // 브리핑은 들여쓴 블록으로 렌더된다 — 빈 줄이 그대로 남으면 공백만 든 줄이 생긴다.
  const s = String(text || '').replace(/\n\s*\n+/g, '\n').trim();
  if (!s) return null;
  return s.length > STATE_MAX_CHARS ? s.slice(0, STATE_MAX_CHARS - 1) + '…' : s;
}

function fileDate(p) {
  try {
    return new Date(fs.statSync(p).mtimeMs).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

// context.md의 "지금 상태". 파싱은 lake-context 한 곳에만 있다 — resume brief와
// 같은 규칙을 봐야 한다. 과거엔 여기서 compactor 자동 구간만 정규식으로 긁었고,
// 사람이 손으로 쓴 `## 지금 상태` 는 헤딩이 한국어라 통째로 무시됐다.
// 그래서 제일 잘 정리된 태스크가 브리핑에서 제일 조용했다.
function readContextState(slug) {
  const file = path.join(INPROGRESS, slug, 'context.md');
  try {
    const st = ctxlib.currentState(fs.readFileSync(file, 'utf-8'));
    if (!st) return null;
    return {
      text: st.text,
      date: st.date || fileDate(file),
      // 라벨을 붙여야 AI가 자동 요약을 사람이 확정한 사실로 오해하지 않는다.
      label: st.source === 'manual' ? 'context.md' : '자동 요약',
      manual: st.source === 'manual',
    };
  } catch {
    return null;
  }
}

// 막힌 것. 상태 문장과 별도로 낸다 — 브리핑이 막힌 항목을 조용히 빠뜨리면
// 새 세션은 그걸 '바로 착수 가능한 다음 할 일'로 보고한다.
function readBlockers(slug) {
  try {
    const found = ctxlib.blockers(fs.readFileSync(path.join(INPROGRESS, slug, 'context.md'), 'utf-8'));
    return found ? found.text : null;
  } catch {
    return null;
  }
}

// 사람용 요약(📍) — spec.md 맨 위. Claude Code의 away_summary를 compactor가 수확한 것.
// 대화가 어디까지 갔는지를 말한다. 본문은 `(YYYY-MM-DD) ` 로 시작한다(lake-recap).
function readHumanRecap(slug) {
  try {
    const s = fs.readFileSync(path.join(INPROGRESS, slug, 'spec.md'), 'utf-8');
    const body = recap.extractFromSpec(s);
    if (!body) return null;
    const m = body.match(/^\((\d{4}-\d{2}-\d{2})\)\s*/);
    return { text: body, date: m ? m[1] : null, label: '지난 세션 요약', manual: false };
  } catch {
    return null;
  }
}

// 무엇을 브리핑에 실을지 고른다.
//
// 규칙 1 — 사람이 손으로 쓴 `## 지금 상태` 가 있으면 그게 정본이다. 대화 전체를 보고
//   의도적으로 남긴 문장이고, 자동 요약은 도구 호출 로그만 보고 만든 것이다.
// 규칙 2 — 없으면 📍 요약과 자동 요약 중 **더 최신** 을 쓴다. 예전엔 `recap || auto` 라
//   2주 전 recap이 3일 전 자동 요약을 이겼다. 낡은 쪽이 이기는 우선순위가
//   "브리프에 계속 틀린 내용이 담긴다"의 나머지 절반이었다.
function pickState(slug) {
  const ctx = readContextState(slug);
  if (ctx && ctx.manual) return ctx;

  const rec = readHumanRecap(slug);
  // 동률(같은 날)이면 recap이 이긴다 — away_summary는 대화 전체를 보고 쓴 것이고
  // auto-context는 도구 로그만 본 것이다. compactor가 둘을 같은 날 쓰는 게 보통이라
  // 동률이 흔한데, ctx가 이기면 더 나은 요약이 항상 가려진다. (정렬이 stable하므로
  // rec을 앞에 두면 동률에서 rec이 남는다.)
  const candidates = [rec, ctx].filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return candidates[0];
}

// 아직 compactor가 처리하지 못한 세션 활동. 있으면 "자동 기록이 최신이 아니다" 는 뜻이다.
// 조용히 두면 AI는 며칠 전 요약을 지금 상태로 믿는다.
function pendingSpoolCount() {
  try {
    return fs.readdirSync(spool.SPOOL_DIR)
      .filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.processing')).length;
  } catch {
    return 0;
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
      const state = pickState(t.slug);
      const body = state && clipState(state.text);
      if (body) {
        // 출처와 날짜를 반드시 같이 낸다. 라벨 없는 요약은 AI가 '지금 확정된 사실'로 읽는다.
        lines.push(`  [${state.label}${state.date ? ` · ${state.date}` : ''}] ` +
          body.replace(/\n/g, '\n  '));
      }
      const blocked = readBlockers(t.slug);
      if (blocked) {
        // 원문이 `- ` 불릿이면 🚧 뒤에 그대로 붙어 "🚧 - ..." 로 읽힌다. 첫 불릿만 걷는다.
        const blockerBody = clipState(blocked).replace(/^-\s+/, '');
        lines.push(`  🚧 ${blockerBody.replace(/\n/g, '\n     ')}`);
      }
      // 자동 기록(journal/context)은 훅이 갱신하지만 plan.md는 사람·AI 재량이라
      // 혼자 썩는다. 낡은 채로 브리핑하면 다음 세션이 죽은 할 일을 보고한다.
      const stale = plan.planStaleInfo(path.join(INPROGRESS, t.slug));
      if (stale) {
        lines.push(`  ⚠ plan.md가 저널보다 낡음 (plan ${stale.planDate} < journal ${stale.journalDate})` +
          ` — 할 일 목록을 그대로 믿지 말고 \`lake-cli.js plan-check ${t.id}\` 를 먼저 실행하라.`);
      }
    }

    // 직전 세션이 방금 끝났으면 그 활동은 아직 spool에 있다 (compactor는 세션 종료
    // 후에, 고아 복구는 30분 뒤에 돈다). 그 사실을 말하지 않으면 새 세션은 아래 상태를
    // "이게 마지막"으로 믿는다 — 실제로는 직전 세션에서 정한 게 통째로 빠져 있다.
    const pending = pendingSpoolCount();
    if (pending > 0) {
      lines.push(`⚠ 미반영 세션 활동 ${pending}건 (spool 대기 중) — 위 상태에 직전 세션 내용이 빠져 있을 수 있다.`);
      lines.push('  직전 세션에서 정한 걸 물으면, 위 요약만 믿지 말고 사용자에게 확인하거나 ' +
        '`node ~/.claude/prd-lake/lake-cli.js resume <id>` 로 원문을 읽어라.');
    }

    return `[PRD Lake 자동 브리핑] 최근 진행 중 태스크와 마지막 상태:\n${lines.join('\n')}\n` +
      '→ 사용자의 요청이 위 태스크 중 하나를 이어가는 것 같으면, resume을 **자동 실행하지 말고** ' +
      '먼저 한 줄로 물어라: "기존 lake [<id>] <제목>에 관련 내용이 있습니다. ' +
      '(1) 복원해서 이어갈까요 (2) 참조만 하고 새로 할까요 (3) 무시할까요?" ' +
      '(lake 기록 자체가 오염됐을 수 있으므로 사용자 판단이 우선. 복원/참조를 고르면 그때 ' +
      '`node ~/.claude/prd-lake/lake-cli.js resume <id>`를 Bash로 실행하라 — ' +
      '이 세션의 자동 기록이 그 태스크로 귀속되는 마커도 이때 찍힌다).';
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
  for (const dep of ['lake-plan.js', 'lake-recap.js', 'lake-context.js']) {
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

  // 고아 마커(세션별 태스크 귀속)와 플러시 스탬프 청소 — 7일 지난 것.
  // 스탬프는 세션당 1개씩 쌓이므로 안 치우면 무한히 는다.
  try {
    for (const sub of ['markers', 'flush']) {
      const dir = path.join(spool.SPOOL_DIR, sub);
      if (!fs.existsSync(dir)) continue;
      for (const m of fs.readdirSync(dir)) {
        const mf = path.join(dir, m);
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
