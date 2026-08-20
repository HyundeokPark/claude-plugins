'use strict';

/**
 * lake-recap.js — 사람용 요약(📍) 수확 + spec.md 반영
 *
 * 왜 수확인가: Claude Code는 사용자가 자리를 비웠다 돌아올 때 대화 전체를 보고
 * "무엇을 하던 중 → 어디까지 됐다 → 다음은 이것" 3박자 요약을 만들어 트랜스크립트에
 * `type=system, subtype=away_summary` 로 남긴다. lake의 spool은 도구 호출·사용자
 * 프롬프트만 담고 어시스턴트의 판단은 없으므로, 같은 품질을 프롬프트로 재현할 수 없다.
 * 그래서 만들지 않고 주워 쓴다 (추가 LLM 호출 0).
 *
 * 커버리지는 약 53%(자리를 비운 세션에만 생긴다). 없으면 compactor의 기존 haiku
 * 호출에 붙인 ===RECAP=== 블록으로 대체한다 — 이것도 추가 호출은 아니다.
 *
 * 사람이 손으로 쓴 요약은 절대 덮지 않는다. 자동 생성분에만 `<!-- lake:auto-recap -->`
 * 마커를 달고, 마커가 있을 때만 덮어쓴다 (spec.md는 resume/stop 훅이 Updated
 * 타임스탬프를 계속 갱신하므로 mtime 비교로는 수동 편집을 구분할 수 없다).
 */

const fs = require('fs');
const path = require('path');

const PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects');
const RECAP_HEADING = '## 📍 사람용 요약';
const AUTO_MARKER = '<!-- lake:auto-recap -->';
// 출처까지 적는 마커. away_summary(대화 전체를 본 것)가 haiku(도구 로그만 본 것)보다
// 항상 낫다. 중간 플러시가 잦아지면서, 좋은 요약을 나중 haiku 요약이 덮는 사고가
// 생길 수 있다 — 출처를 남겨야 그걸 막을 수 있다.
const AUTO_MARKER_RE = /<!--\s*lake:auto-recap(?:\s+source=(\w+))?\s*-->/;

// Claude Code가 요약 끝에 붙이는 UI 안내문 — lake에 남길 내용이 아니다.
const UI_HINT_RE = /\s*\(disable recaps in \/config\)\s*$/;

/**
 * session_id로 트랜스크립트 파일을 찾는다.
 * cwd → 디렉터리명 규칙(슬래시를 '-'로)에 의존하지 않고 프로젝트 디렉터리를 훑는다 —
 * session_id가 UUID라 충돌하지 않고, 규칙이 바뀌어도 깨지지 않는다.
 */
function findTranscript(sessionId, cwdHint) {
  if (!sessionId) return null;
  const file = `${sessionId}.jsonl`;

  if (cwdHint) {
    const guess = path.join(PROJECTS_DIR, String(cwdHint).replace(/\//g, '-'), file);
    if (fs.existsSync(guess)) return guess;
  }

  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const candidate = path.join(PROJECTS_DIR, dir, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 트랜스크립트의 away_summary들을 시간순으로 반환. [{ts, text}]
 */
function readAwaySummaries(transcriptPath) {
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    // JSON.parse 전에 값싼 문자열 필터 — 트랜스크립트는 수 MB까지 간다.
    if (!line || line.indexOf('away_summary') === -1) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'system' || o.subtype !== 'away_summary') continue;
    const text = String(o.content || '').replace(UI_HINT_RE, '').trim();
    if (!text) continue;
    out.push({ ts: new Date(o.timestamp || 0).getTime(), text });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * 태스크 구간(events)에 해당하는 away_summary 하나를 고른다.
 *
 * 한 세션이 여러 태스크를 오갈 수 있으므로 구간의 시간 창에 든 것만 본다.
 * 창 안에 여러 개면 마지막(가장 최근 상태)을 쓴다.
 * 창 안에 없으면 null — 다른 태스크의 상태를 이 태스크에 적는 것보다 없는 게 낫다.
 */
function pickForSegment(summaries, events) {
  if (!summaries.length || !events || !events.length) return null;
  const stamps = events.map(e => new Date(e.t || 0).getTime()).filter(Boolean);
  if (!stamps.length) return null;
  const from = Math.min(...stamps);
  const to = Math.max(...stamps);
  // 요약은 구간 활동 직후에 찍히기도 하므로 뒤쪽에 여유를 둔다.
  const GRACE_MS = 10 * 60 * 1000;
  const inWindow = summaries.filter(s => s.ts >= from && s.ts <= to + GRACE_MS);
  if (!inWindow.length) return null;
  return inWindow[inWindow.length - 1].text;
}

/**
 * session_id + 구간 이벤트로 사람용 요약을 수확한다. 없으면 null.
 */
function harvest(sessionId, events, cwdHint) {
  const transcript = findTranscript(sessionId, cwdHint);
  if (!transcript) return null;
  return pickForSegment(readAwaySummaries(transcript), events);
}

function eventsCwd(events) {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    if (events[i] && events[i].cwd) return events[i].cwd;
  }
  return null;
}

/**
 * spec.md에서 `## 📍 …` 섹션의 범위를 찾는다. {start, end, body} 또는 null.
 *
 * 섹션의 끝은 **문단 경계**로 잡는다 — 요약은 한 문단이다. 다음 헤딩이나 특정
 * 메타데이터 형식(`- **`)을 종료 조건으로 쓰면, 메타데이터를 `**Updated:**`처럼
 * 다른 형식으로 적은 spec에서 그 블록까지 요약으로 빨아들인다 (실제로 겪음).
 */
function findRecapSection(specText) {
  const text = String(specText || '');
  const lines = text.split('\n');
  const headIdx = lines.findIndex(l => /^##\s*📍/.test(l));
  if (headIdx === -1) return null;

  let i = headIdx + 1;
  const bodyLines = [];
  // 마커·선행 빈 줄 통과
  while (i < lines.length && (/^\s*<!--/.test(lines[i]) || lines[i].trim() === '')) i++;
  // 내용 문단: 빈 줄 또는 새 헤딩에서 끝
  while (i < lines.length && lines[i].trim() !== '' && !/^#{1,6}\s/.test(lines[i])) {
    bodyLines.push(lines[i]);
    i++;
  }

  const start = lines.slice(0, headIdx).join('\n').length + (headIdx > 0 ? 1 : 0);
  const end = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
  return { start, end, body: bodyLines.join(' ').trim() };
}

/**
 * 화면에 내보낼 사람용 요약 본문. 없으면 ''.
 */
function extractFromSpec(specText) {
  const sec = findRecapSection(specText);
  return sec ? sec.body : '';
}

/**
 * 📍 요약 섹션을 걷어낸 spec 본문. 요약은 브리프 맨 위에서 따로 보여주므로,
 * spec을 앞에서부터 잘라 쓰는 쪽(Goal 폴백)이 같은 문장을 두 번 내보내지 않게 한다.
 * 파싱 규칙을 한곳에 두려고 여기 둔다 — findRecapSection과 짝이다.
 */
function stripRecapFromSpec(specText) {
  const text = String(specText || '');
  const sec = findRecapSection(text);
  if (!sec) return text;
  return (text.slice(0, sec.start) + text.slice(sec.end)).replace(/^\n+/, '');
}

/**
 * spec.md의 `## 📍 사람용 요약` 섹션을 자동 생성분으로 갱신한다.
 *
 * @returns 'written' | 'created' | 'manual-kept' | 'no-spec'
 */
function writeRecap(taskDir, text, dateStr, source) {
  const specPath = path.join(taskDir, 'spec.md');
  let body;
  try {
    body = fs.readFileSync(specPath, 'utf-8');
  } catch {
    return 'no-spec';
  }

  const clean = String(text || '').replace(UI_HINT_RE, '').replace(/\s*\n\s*/g, ' ').trim();
  if (!clean) return 'manual-kept';

  const src = source === 'away_summary' ? 'away_summary' : 'haiku';
  const marker = `<!-- lake:auto-recap source=${src} -->`;
  const section = `${RECAP_HEADING}\n${marker}\n(${dateStr}) ${clean}\n`;
  const sec = findRecapSection(body);

  if (sec) {
    // 사람이 쓴 요약은 건드리지 않는다 — 자동 마커가 있을 때만 덮는다.
    const existing = body.slice(sec.start, sec.end);
    const m = existing.match(AUTO_MARKER_RE);
    if (!m) return 'manual-kept';
    // 출처 강등 금지: 이미 away_summary가 있는데 haiku로 덮지 않는다.
    // (출처 표기가 없는 옛 마커는 haiku로 간주 — 덮여도 손해가 아니다)
    if (m[1] === 'away_summary' && src !== 'away_summary') return 'kept-better';
    fs.writeFileSync(specPath, body.slice(0, sec.start) + section + body.slice(sec.end), 'utf-8');
    return 'written';
  }

  // 신규 삽입: 제목(`# ...`) 바로 아래. 메타데이터 불릿보다 위에 온다.
  const lines = body.split('\n');
  const titleIdx = lines.findIndex(l => /^#\s+\S/.test(l));
  const insertAt = titleIdx === -1 ? 0 : titleIdx + 1;
  lines.splice(insertAt, 0, '', section.trimEnd(), '');
  fs.writeFileSync(specPath, lines.join('\n'), 'utf-8');
  return 'created';
}

module.exports = {
  RECAP_HEADING,
  AUTO_MARKER,
  AUTO_MARKER_RE,
  findRecapSection,
  extractFromSpec,
  stripRecapFromSpec,
  findTranscript,
  readAwaySummaries,
  pickForSegment,
  harvest,
  eventsCwd,
  writeRecap,
};
