---
autoload: false
description: spec/plan/context/journal/artifacts 템플릿
---

# Lake File Templates

## spec.md template

```markdown
# {title}
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
