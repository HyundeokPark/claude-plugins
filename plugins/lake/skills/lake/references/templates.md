---
autoload: false
description: spec/plan/context/journal/artifacts 템플릿
---

# Lake File Templates

## spec.md template

```markdown
# {title}

## 📍 사람용 요약
<!-- lake:auto-recap -->
({yyyy-MM-dd}) {2~3문장. 무엇을 하던 중 → 어디까지 됐다 → 다음은 이것.}

- **Project**: {project}
- **Created**: {yyyy-MM-dd HH:mm}
- **Updated**: {yyyy-MM-dd HH:mm}

## Goal
{One-line goal}

## Background
{Why this task exists}

## Requirements
{Requirements list}
```

`## 📍 사람용 요약`은 **세션 종료 시 compactor가 자동으로 채운다** (Claude Code의
away_summary 수확 → 없으면 haiku). `<!-- lake:auto-recap -->` 마커가 붙은 것만 자동
갱신 대상이며, 마커를 지우고 직접 쓰면 그 뒤로는 자동이 덮지 않는다.
`/lake save`에서 손으로 고쳐도 된다 — 상세는 `references/advanced.md`.

## plan.md template

```markdown
# Plan

## Checklist
- [x] 완료된 항목
- [ ] 지금 착수 가능한 항목
- [~] (until: 2026-08-18) 외부 이벤트 대기 — 해제조건을 괄호로
- [-] (폐기 2026-08-13) 폐기된 항목 — 사유. 삭제하지 말 것

## Notes
{Implementation notes}
```

체크박스 4종의 의미와 `plan-check` 절차 → `references/advanced.md`.
`[~]`는 brief의 "⏳ 대기중"으로, `[-]`는 brief에서 숨겨진다. **폐기 항목을 지우면
같은 논의가 재발하므로 `[-]`로 남긴다.**

## context.md template

```markdown
# Context
- **Branch**: {branch}
- **Modified Files**:
  - {file1}
  - {file2}

## 지금 상태 ({yyyy-MM-dd})
{지금 어디까지 왔고 무엇이 막혀 있는지 2~5줄. brief·SessionStart 브리핑의 정본이다.}

## Decisions
- {Decision 1}: {reason}

## Blockers
- {Current blockers}
```

**`## 지금 상태`는 brief가 Goal 바로 아래, "이제 할 차례"보다 **위에** 싣는다** —
무엇을 할지 정하기 전에 읽어야 하는 정보이기 때문이다. 헤딩에 날짜를 적으면 브리핑이
출처와 함께 `[context.md · 2026-08-21]`로 표시한다.

인식하는 헤딩 별칭 (한국어 문서를 영어 헤딩으로 바꿔 쓸 필요 없다):

| 뜻 | 별칭 |
|---|---|
| 지금 상태 | `지금 상태` `현재 상태` `현황` `진행 상황` `Status` `Current State` |
| 막힌 것 | `Blockers` `블로커` `막힌 것` `막힘` `차단` `보류` |

수동으로 쓴 `## 지금 상태`는 compactor의 `<!-- lake:auto-context -->` 자동 요약을
**항상 이긴다**. 자동 요약은 도구 호출 로그만 보고 만든 것이고, 수동 섹션은 사람이
대화 전체를 보고 남긴 것이다. 블로커 본문이 `없음`으로 시작하면 블로커로 보고하지 않는다.

## journal/{date}.md template

```markdown
# {yyyy-MM-dd}

## Work Done
- {time} {what was done}

## Notes
- {misc notes}
```

## artifacts/INDEX.md template

```markdown
# Artifacts

| # | Path | Description | Added |
|---|------|-------------|-------|
| 1 | ~/project/terraform/ | Terraform IaC for OCI ARM | 2026-04-10 |
```

When appending rows, increment `#` automatically based on the current highest row number.
