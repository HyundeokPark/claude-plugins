---
autoload: false
description: lake 스킬의 Notes 및 고급 주제
---

# Advanced Usage & Notes

## Notes

- Lake file total line limit: 200 lines (warn if exceeded)
- Non-git directory save: fallback Project to dirname
- Re-save same task name: update existing files (no new folder)
- `/lake save` should be minimal friction — require minimum user input
- Artifacts section in `/lake resume` is shown only when `artifacts/INDEX.md` exists

`--view=summary`/`--view=compressed` opt-in 플래그는 lake-cli.js의 `help` 서브커맨드로 확인하세요.

## 세션 자동 기록 (spool + compactor, v1.7.0+)

`/lake save`를 깜빡해도 세션 활동이 유실되지 않도록, 훅이 활동을 자동 기록한다.

```
세션 중:  UserPromptSubmit/PostToolUse 훅 → .spool/{session_id}.jsonl append (LLM 없음)
저장/재개: lake-cli resume·upsert → .spool/markers/{session_id}.json 마커
           + spool 타임라인에 task 이벤트 기록 (세션 중 태스크 전환 시 구간 분리 근거)
세션 시작: SessionStart 훅이 최근 inprogress 태스크 3개의 마지막 자동 상태를
           AI 컨텍스트에 브리핑 주입 → AI가 이어가는 요청을 감지하면 스스로 resume
세션 종료: SessionEnd 훅 → lake-compactor.js (detached, claude -p haiku)
           ├─ journal/{today}.md: "세션 자동 기록" 섹션 append — 정제(시간순 사실), 요약 아님
           └─ context.md: <!-- lake:auto-context --> 마커 구간만 덮어쓰기 (수동 작성분 보존)
크래시:    다음 SessionStart 훅이 고아 spool(mtime 2분+) 발견 → compactor 재실행 (최대 3개)
```

- 자동 저장 범위는 journal/context뿐. spec/plan은 의도적 저장(`/lake save`) 전용.
- 마커 없는 세션의 spool은 `.spool/unfiled/`에 보존 (잘못된 태스크 오염 방지).
- 이벤트 3개 미만 spool은 폐기. compactor 로그: `.spool/compactor.log`.
- 재귀 방지: compactor의 headless claude에는 `LAKE_COMPACTOR=1`이 심어져 훅이 spool을 남기지 않음.
- 테스트: `tests/autosave-golden.sh` (LAKE_SUMMARIZER_CMD 스텁으로 LLM 없이 검증).
- 병렬 세션 안전 (v1.7.1+): 마커가 세션별(`markers/{session_id}.json`)이라 동시 세션이 서로 다른 태스크를 작업해도 각자 태스크로 귀속된다. compactor는 자기 세션 마커만 보며, 전역 `.active-task`(레거시)로 폴백하지 않는다 — 마커 없으면 unfiled.
- 세션이 resume/save 없이 작업만 한 경우: 태스크 귀속을 알 수 없으므로 unfiled 보존. 자동 journal을 원하면 세션 시작 시 `/lake resume <태스크>`부터.

## plan.md 상태 어휘 + plan-check (v1.9.0)

### 왜 필요했나

journal·context·index는 훅이 자동 갱신하는데 **plan.md만 AI 재량**이라 plan.md만 썩는다.
brief의 "이제 할 차례"는 plan.md 미체크 항목에서만 나오므로, 폐기된 항목이 `- [ ]`로 남으면
다음 세션이 죽은 할 일을 최상단에 보고한다 (2026-08 실제 사고: "로컬 E2E 설문은 안 만든다"고
결정하고 journal에 기록했는데 plan.md 체크박스는 그대로여서 다음 resume이 그걸 1순위로 띄웠다).

v1.8.1에서 SKILL.md에 "reconcile 필수"라는 **산문 지시**를 넣었으나 그 뒤에 또 같은 사고가 났다.
그래서 v1.9.0은 처방을 바꿨다 — 문구 강화가 아니라 **코드가 후보를 뽑고 절차가 커맨드를 박는다.**

### 상태 어휘 (하위호환 추가)

```
- [ ] 지금 착수 가능한 일
- [x] 완료
- [~] (until: 2026-08-18) 설문 응답 수렴 — 외부 이벤트 대기
- [-] (폐기 2026-08-13) 로컬 E2E 설문 문항 설계 — 존재하지 않는 도구라 가상 선호만 나옴
```

- `[~]` 대기: 해제조건을 괄호로. 파서가 `until:` 날짜를 추출해 기한 경과 시 brief에 `⚠ 기한 지남`.
- `[-]` 폐기: 날짜·사유 필수. **삭제하지 않는다** — 같은 논의가 재발한다.
- 미지원 마커는 파싱 대상에서 빠지고 기존 동작 그대로. `[ ]`/`[x]`만 쓰는 태스크의 brief 출력은
  이전과 동일하다(stale이 아닌 경우).
- brief 노출: `[ ]`→"▶ 이제 할 차례", `[~]`→"⏳ 대기중", `[-]`→숨김(건수만 알림, `--view=full`에서 확인).

### `plan-check <hash>`

```
1) stale 검사        plan.md mtime 날짜 < 최신 journal 날짜 → 경고
2) 불일치 후보        미체크 항목 ↔ 최근 journal 2개의 불릿을 토큰 부분일치로 매칭.
                     불릿에 해소 신호("합치지 않음/폐기/완료/대기"…)가 있으면 후보로 제시 +
                     추정 판정([x]/[~]/[-]) 제안. 상위 12건까지, 초과분은 건수 표시.
3) Blockers 모순      context.md `## Blockers` 항목이 plan에서 이미 `[x]`로 닫혀 있으면 후보
4) 현재 상태          착수가능/완료/대기/폐기 건수 + 판정 어휘 안내
```

정밀할 필요 없다 — **AI가 눈으로 판정할 후보 목록**이면 충분하다. 판정은 사람/AI가 한다.

stale 판정은 **하루 단위**다. 초 단위 mtime 비교는 `/lake save`가 plan.md를 쓴 직후 journal을
append하는 정상 순서에서도 매번 stale을 띄운다 — false positive가 제일 해롭다. 같은 날 안의
누락은 stale이 못 잡고 2)의 키워드 매칭이 담당한다.

### 단일 정본

"다음 할 일"의 정본은 **plan.md 하나**다. context.md의 `<!-- lake:auto-context -->`는
compactor가 쓰는 **최근 활동 로그**이며 할 일 목록이 아니다. 과거엔 두 서술이 각자 낡아
서로 다른 말을 했고 사용자가 어느 쪽도 믿을 수 없게 됐다. 둘이 다르면 plan.md가 이긴다.

### stale 경고가 뜨는 지점

```
/lake resume (brief)   → 최상단 ⚠ 한 줄 + plan-check 실행 안내
SessionStart 브리핑     → 태스크별 ⚠ 한 줄 (다음 세션 AI가 곧바로 인지)
Stop 훅                 → systemMessage 1회 (태스크·journal 날짜당 1회, .plan-stale-warned로 억제)
```

## project registry — `projects.json` 상세

```json
{
  "projects": ["nestads", "heypoll", "infra"],
  "aliases": { "nestads-deliverer": "nestads", "heypoll-backend": "heypoll" }
}
```

정규화 순서: `aliases` 정확 일치 → 정식명 / `projects` 정확 일치 → 자기 자신 /
그 외엔 끝의 괄호를 떼고(`"nestads (pilot)"` → `nestads`) 재시도 / 끝까지 모르면
값을 그대로 통과시킨다 (데이터를 절대 파괴하지 않는다).
