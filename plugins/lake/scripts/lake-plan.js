'use strict';

/**
 * lake-plan.js — plan.md 상태 어휘 + stale 판정 + reconcile 후보 추출
 *
 * 왜 있나: journal/context/index는 훅이 자동 갱신하는데 plan.md만 AI 재량이라
 * plan.md만 썩는다. 그 결과 brief의 "이제 할 차례"가 이미 폐기된 항목을 띄웠다.
 * v1.8.1에서 SKILL.md에 "reconcile 필수" 산문 지시를 넣었으나 또 안 지켜졌다 —
 * 그래서 사람의 성실성이 아니라 코드가 후보를 뽑아 판정을 강제하는 구조로 바꾼다.
 *
 * lake-cli.js와 훅(session-start/stop-save)이 같은 판정을 쓰도록 여기 모아둔다.
 * lake-cli.js는 ~/.claude/prd-lake/로 단독 배포되므로, 이 파일도 함께 배포된다
 * (lake-session-start.js ensureLakeSetup — 이 파일을 먼저 복사한 뒤 cli를 복사).
 */

const fs = require('fs');
const path = require('path');

// --- plan 항목 상태 어휘 ---
//   - [ ] 착수 가능
//   - [x] 완료
//   - [~] (until: 2026-08-18) 외부 이벤트 대기 — 해제조건을 괄호로
//   - [-] (폐기 2026-08-13) 사유 — 삭제하지 않는다 (같은 논의 재발 방지 기록)
// 미지원 마커는 파싱 대상에서 빠지고 기존 동작이 그대로 유지된다.
const PLAN_MARKER_STATE = {
  ' ': 'open',
  x: 'done',
  X: 'done',
  '~': 'waiting',
  '-': 'dropped',
};

const PLAN_ITEM_RE = /^\s*-\s\[([ xX~-])\](\s.*)?$/;

function parsePlanItems(planText) {
  if (!planText) return [];
  const items = [];
  const lines = String(planText).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PLAN_ITEM_RE);
    if (!m) continue;
    const state = PLAN_MARKER_STATE[m[1]];
    if (!state) continue;
    const body = (m[2] || '').trim();
    items.push({
      line: i + 1,
      raw: lines[i],
      state,
      body,
      until: state === 'waiting' ? parseUntil(body) : null,
    });
  }
  return items;
}

function parseUntil(body) {
  const m = String(body || '').match(/until\s*:?\s*(\d{4}-\d{2}-\d{2})/i);
  return m ? m[1] : null;
}

function planItemsByState(planText, state) {
  return parsePlanItems(planText).filter(it => it.state === state);
}

// --- stale 판정 ---
// 하루 단위로만 본다. mtime을 초 단위로 비교하면 /lake save가 plan.md를 쓴 직후
// journal을 append하는 정상 순서에서도 매번 stale이 뜬다 (false positive가 제일 해롭다).
// 같은 날 안에서의 누락은 놓치지만, 그건 plan-check의 키워드 매칭이 담당한다.

function localDate(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function latestJournal(dir) {
  const journalDir = path.join(dir, 'journal');
  let best = null;
  try {
    for (const f of fs.readdirSync(journalDir)) {
      if (!f.endsWith('.md')) continue;
      // 파일명 날짜가 정본. 파일명이 날짜 형식이 아니면 mtime으로 대체.
      const nameDate = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f);
      const st = fs.statSync(path.join(journalDir, f));
      const date = nameDate ? nameDate[1] : localDate(st.mtimeMs);
      if (!best || date > best.date) best = { date, file: f };
    }
  } catch {
    return null;
  }
  return best;
}

/**
 * plan.md가 최신 journal보다 오래됐는지. stale이면 {planDate, journalDate}, 아니면 null.
 */
function planStaleInfo(dir) {
  try {
    const planPath = path.join(dir, 'plan.md');
    const planDate = localDate(fs.statSync(planPath).mtimeMs);
    const journal = latestJournal(dir);
    if (!journal) return null;
    if (planDate >= journal.date) return null;
    return { planDate, journalDate: journal.date };
  } catch {
    return null;
  }
}

// --- reconcile 후보 매칭 ---
// 정밀할 필요 없다. AI가 눈으로 판정할 후보 목록이면 충분하다.

// 한국어는 조사가 붙어 활용되므로("설문" vs "설문에") 토큰 일치가 아니라
// 부분문자열 포함으로 본다.
const STOPWORDS = new Set([
  '작성', '확정', '완료', '진행', '반영', '기록', '검토', '정리', '사용자', '결정',
  '추가', '수정', '설계', '적용', '확인', '관련', '이번', '위해', '내용', '경우',
  '오늘', '어제', '전체', '기준', '대해', '해서', '하고', '하는', '한다', '했다',
  '그리고', '그런데', '이후', '그것', '저것', '여기', '거기', '때문',
]);

function tokenize(text) {
  const cleaned = String(text || '')
    .replace(/\*\*/g, '')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ');
  const parts = cleaned.split(/[^0-9A-Za-z가-힣._#-]+/u);
  const out = [];
  for (const p of parts) {
    const t = p.replace(/^[._#-]+|[._#-]+$/g, '');
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    out.push(t);
  }
  return Array.from(new Set(out));
}

// 저널 문장이 "이 항목은 이미 끝났거나 없어졌다"고 말하는 신호.
// dropped를 먼저 본다 — "합치지 않음"은 done 신호("완료")와 같은 불릿에 섞여 나온다.
const RESOLUTION_SIGNALS = [
  { verdict: 'dropped', words: ['폐기', '취소', '안 함', '안함', '하지 않', '않기로', '않음', '제외', '불필요', '소멸', '기각', '드롭', '버렸', '버림', '철회', '없앰', '삭제'] },
  { verdict: 'waiting', words: ['보류', '대기', '마감', '나중', '다음 세션', '후 결정', '전엔', '착수 불가', '기다', '미정'] },
  { verdict: 'done', words: ['완료', '확정', '끝냈', '끝남', '게시됨', '반영됨', '성공', '통과', '머지', '배포', '생성', '해소'] },
];

function detectVerdict(text) {
  const t = String(text || '');
  for (const sig of RESOLUTION_SIGNALS) {
    for (const w of sig.words) {
      if (t.includes(w)) return { verdict: sig.verdict, signal: w };
    }
  }
  return null;
}

function journalBullets(dir, maxFiles) {
  const journalDir = path.join(dir, 'journal');
  const bullets = [];
  let files;
  try {
    files = fs.readdirSync(journalDir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return bullets;
  }
  const recent = files.slice(-(maxFiles || 2));
  for (const f of recent) {
    let text;
    try {
      text = fs.readFileSync(path.join(journalDir, f), 'utf-8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!/^[-*]\s/.test(line)) continue;
      const body = line.replace(/^[-*]\s*/, '').trim();
      if (body.length < 6) continue;
      bullets.push({ file: f.replace(/\.md$/, ''), text: body });
    }
  }
  return bullets;
}

function sharedTokenCount(itemTokens, bulletText) {
  const hay = bulletText.toLowerCase();
  let n = 0;
  for (const t of itemTokens) {
    if (hay.includes(t.toLowerCase())) n++;
  }
  return n;
}

/**
 * 미체크(`- [ ]`) 항목 중, 최신 저널이 "이미 처리됐다"고 말하는 것들을 후보로 반환.
 * @returns [{item, evidence:{file,text}, verdict, signal, shared}]
 */
function findReconcileCandidates(dir, planText, opts) {
  const options = opts || {};
  const minShared = options.minShared || 2;
  const bullets = journalBullets(dir, options.journalFiles || 2);
  if (bullets.length === 0) return [];

  const candidates = [];
  for (const item of planItemsByState(planText, 'open')) {
    const tokens = tokenize(item.body);
    if (tokens.length === 0) continue;
    const need = Math.min(minShared, tokens.length);
    let best = null;
    for (const b of bullets) {
      const verdict = detectVerdict(b.text);
      if (!verdict) continue;
      const shared = sharedTokenCount(tokens, b.text);
      if (shared < need) continue;
      // 동점이면 나중 불릿이 이긴다 — bullets는 오래된 저널부터 쌓이므로
      // 뒤쪽이 더 최근 판단이고, 그게 근거로 정확하다.
      if (!best || shared >= best.shared) {
        best = { evidence: b, verdict: verdict.verdict, signal: verdict.signal, shared };
      }
    }
    if (best) candidates.push({ item, ...best });
  }
  candidates.sort((a, b) => b.shared - a.shared);
  return candidates;
}

function extractBlockerBullets(contextText) {
  if (!contextText) return [];
  const m = String(contextText).match(/(^|\n)##\s*Blockers\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/);
  if (!m) return [];
  const out = [];
  for (const raw of m[2].split('\n')) {
    const line = raw.trim();
    if (!/^[-*]\s/.test(line)) continue;
    const body = line.replace(/^[-*]\s*/, '').trim();
    if (!body) continue;
    // "없음"으로 시작하는 줄은 블로커가 아니다. 뒤에 해소 경위를 덧붙여 쓰는 경우가
    // 많아 정확히 "없음"일 때만 걸러내면 그 설명이 블로커로 오인된다.
    if (/^없(음|다)(?![가-힣])/.test(body)) continue;
    out.push(body);
  }
  return out;
}

/**
 * context.md `## Blockers` 항목 중 plan.md에서 이미 `[x]`로 닫힌 것 → 모순 후보.
 */
function findBlockerContradictions(planText, contextText, opts) {
  const minShared = (opts && opts.minShared) || 2;
  const doneItems = planItemsByState(planText, 'done');
  if (doneItems.length === 0) return [];
  const out = [];
  for (const blocker of extractBlockerBullets(contextText)) {
    const tokens = tokenize(blocker);
    if (tokens.length === 0) continue;
    const need = Math.min(minShared, tokens.length);
    let best = null;
    for (const item of doneItems) {
      const shared = sharedTokenCount(tokens, item.body);
      if (shared < need) continue;
      if (!best || shared > best.shared) best = { item, shared };
    }
    if (best) out.push({ blocker, item: best.item, shared: best.shared });
  }
  return out;
}

module.exports = {
  PLAN_MARKER_STATE,
  parsePlanItems,
  parseUntil,
  planItemsByState,
  planStaleInfo,
  latestJournal,
  localDate,
  tokenize,
  detectVerdict,
  findReconcileCandidates,
  findBlockerContradictions,
  extractBlockerBullets,
};
