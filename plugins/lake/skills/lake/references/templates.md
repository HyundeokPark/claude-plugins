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
- [x] Completed item
- [ ] Pending item

## Notes
{Implementation notes}
```

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
