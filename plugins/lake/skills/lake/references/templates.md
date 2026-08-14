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

## Decisions
- {Decision 1}: {reason}

## Blockers
- {Current blockers}
```

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
