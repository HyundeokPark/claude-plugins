'use strict';

/**
 * lake-context.js — context.md에서 "지금 상태"·"블로커"를 뽑는 공용 규칙.
 *
 * 왜 필요한가: brief가 context.md를 보는 길은 지금까지 두 개뿐이었다.
 *   1) compactor가 심는 `<!-- lake:auto-context -->` 구간
 *   2) 영어 헤딩 `## Blockers` / `## Decisions` 정확 일치
 * 그래서 사람이 손으로 쓴 한국어 context.md(`## 지금 상태`, `## 막힌 것`)는
 * 통째로 무시됐다. 정성껏 정리할수록 브리프는 비고, 남는 건 몇 주 전 자동 요약뿐 —
 * "lake를 고도화하는데 브리프는 계속 틀린 옛날 얘기"의 직접 원인이다.
 *
 * 규칙을 여기 한 곳에 둔다. resume brief(lake-cli)와 SessionStart 자동 브리핑이
 * **같은 함수**를 본다. 같은 규칙을 두 벌 복사하면 형식이 어긋날 때 한쪽만 고쳐진다.
 */

const AUTO_START = '<!-- lake:auto-context:start -->';
const AUTO_END = '<!-- lake:auto-context:end -->';

// 헤딩 별칭. 사용자의 lake는 한국어로 쓰인다 — 영어만 알아보면 안 본 것과 같다.
const STATE_HEADINGS = ['지금 상태', '현재 상태', '현재상태', '현황', '진행 상황', 'status', 'current state', 'state'];
const BLOCKER_HEADINGS = ['blockers', 'blocker', '블로커', '막힌 것', '막힌것', '막힘', '차단', '보류'];

// "없음", "없음 — 다음 단계로" 같은 줄은 블로커가 아니다.
// (plan-check가 같은 오탐을 이미 겪었다 — f8ef417)
const NONE_RE = /^\s*(?:없음|없다|해당\s*없음|n\/?a|none|no\b)/i;

function isNone(text) {
  return !text || NONE_RE.test(String(text).trim());
}

// 헤딩 텍스트에서 장식(#, 이모지, 날짜 괄호, 콜론)을 걷어내고 비교용으로 정규화한다.
function normalizeHeading(line) {
  return String(line)
    .replace(/^#{1,6}\s*/, '')
    .replace(/\([^)]*\)/g, ' ')          // "지금 상태 (2026-08-21)" → "지금 상태"
    .replace(/[^\p{L}\p{N}\s/]/gu, ' ')  // 이모지·기호 제거
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// 헤딩 줄에 박힌 날짜(YYYY-MM-DD). 신선도 비교에 쓴다. 없으면 null.
function headingDate(line) {
  const m = String(line).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function headingLevel(line) {
  const m = String(line).match(/^(#{1,6})\s/);
  return m ? m[1].length : 0;
}

/**
 * 별칭 중 하나와 맞는 첫 섹션을 돌려준다. {heading, body, date, level} 또는 null.
 * 섹션의 끝은 같은 레벨 이하(더 굵은) 헤딩 또는 문서 끝.
 */
function findSection(text, aliases) {
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const level = headingLevel(lines[i]);
    if (!level) continue;
    const norm = normalizeHeading(lines[i]);
    if (!aliases.some(a => norm === a || norm.startsWith(a + ' ') || norm.endsWith(' ' + a))) continue;

    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = headingLevel(lines[j]);
      if (l && l <= level) break;
      body.push(lines[j]);
    }
    return {
      heading: lines[i].replace(/^#{1,6}\s*/, '').trim(),
      body: body.join('\n').trim(),
      date: headingDate(lines[i]),
      level,
    };
  }
  return null;
}

/** compactor 자동 구간 본문 (`## 자동 상태` 헤딩·마커 제거). 없으면 ''. */
function autoBody(text) {
  const s = String(text || '');
  const start = s.indexOf(AUTO_START);
  const end = s.indexOf(AUTO_END);
  if (start < 0 || end <= start) return '';
  return s.slice(start + AUTO_START.length, end).replace(/^\s*##\s.*\n/, '').trim();
}

/** 자동 구간을 걷어낸 본문. 수동 섹션만 보고 싶을 때 쓴다. */
function stripAuto(text) {
  const s = String(text || '');
  const start = s.indexOf(AUTO_START);
  const end = s.indexOf(AUTO_END);
  if (start < 0 || end <= start) return s;
  return (s.slice(0, start) + s.slice(end + AUTO_END.length)).replace(/\n{3,}/g, '\n\n');
}

/** 자동 구간의 `현재:` / `다음:` / `블로커:` 한 줄을 뽑는다. */
function autoLine(text, label) {
  const body = autoBody(text);
  if (!body) return '';
  const re = new RegExp('^\\s*' + label + '\\s*:\\s*(.+)$', 'm');
  const m = body.match(re);
  return m ? m[1].trim() : '';
}

/** 자동 구간 헤딩(`## 자동 상태 (compactor, 2026-08-21)`)에 박힌 날짜. 없으면 null. */
function autoDate(text) {
  const s = String(text || '');
  const start = s.indexOf(AUTO_START);
  if (start < 0) return null;
  const head = s.slice(start, start + 200).split('\n').find(l => /^\s*##\s/.test(l));
  return head ? headingDate(head) : null;
}

/**
 * 지금 상태.
 *
 * 기본은 수동 섹션이 이긴다 — 사람이 대화 전체를 보고 쓴 것이고, 자동 요약은
 * 도구 호출 로그만 보고 만든 것이다.
 *
 * 단 **날짜가 둘 다 있고 자동 쪽이 더 새것이면 자동을 쓴다.** 중간 플러시가 붙으면서
 * 자동 요약이 수시로 갱신되는데, 몇 주 전 `## 지금 상태 (2026-07-01)` 이 오늘 자동
 * 요약을 계속 이기면 "손으로 쓸수록 낡은 걸 본다"는 원래 병이 방향만 바꿔 재발한다.
 * 날짜가 없는 수동 섹션은 종전대로 이긴다 (사람이 최근에 손댔다고 보는 게 안전하다).
 *
 * @returns {{text, source:'manual'|'auto', date:string|null}|null}
 */
function currentState(text) {
  const manual = findSection(stripAuto(text), STATE_HEADINGS);
  const aDate = autoDate(text);
  const now = autoLine(text, '현재');
  const next = autoLine(text, '다음');
  const autoLines = [];
  if (now) autoLines.push('현재: ' + now);
  if (next) autoLines.push('다음: ' + next);
  const auto = autoLines.length ? { text: autoLines.join('\n'), source: 'auto', date: aDate } : null;

  if (manual && manual.body) {
    const manualLoses = auto && manual.date && aDate && aDate > manual.date;
    if (!manualLoses) return { text: manual.body, source: 'manual', date: manual.date };
  }
  return auto;
}

/**
 * 블로커. 수동 헤딩 섹션 → 자동 구간 `블로커:` 줄 순. "없음"은 블로커가 아니다.
 * @returns {{text, source:'manual'|'auto'}|null}
 */
function blockers(text) {
  const manual = findSection(stripAuto(text), BLOCKER_HEADINGS);
  if (manual && manual.body && !isNone(manual.body)) {
    // 마커 주석이 섹션에 섞여 화면으로 새던 사고가 있었다 (677cb1a).
    const body = manual.body.split('\n').filter(l => !/^\s*<!--/.test(l)).join('\n').trim();
    if (body && !isNone(body)) return { text: body, source: 'manual' };
  }
  const auto = autoLine(text, '블로커');
  if (auto && !isNone(auto)) return { text: auto, source: 'auto' };
  return null;
}

module.exports = {
  AUTO_START, AUTO_END, STATE_HEADINGS, BLOCKER_HEADINGS,
  isNone, normalizeHeading, headingDate, findSection,
  autoBody, stripAuto, autoLine, autoDate, currentState, blockers,
};
