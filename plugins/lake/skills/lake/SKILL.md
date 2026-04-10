---
name: lake
description: "PRD Lake - Session progress persistence system. Save work progress per task (spec/plan/context/journal) and resume instantly in the next session."
argument-hint: "save|list|resume|done|search|artifacts [args]"
---

# /lake — PRD Lake Session Progress Persistence

## Role

Save work progress to `~/.claude/prd-lake/` per task, so you can instantly restore context in the next session even after session termination.

**Design philosophy:** Make `/lake save` as frictionless as Ctrl+S.

## Folder Structure

```
~/.claude/prd-lake/
  inprogress/                    ← Active tasks
    {task-name}/
      spec.md                    ← What (requirements/background)
      plan.md                    ← How (checklist)
      context.md                 ← Branch/files/decisions
      journal/                   ← Daily work log
        {yyyy-MM-dd}.md
      artifacts/                 ← 산출물 인덱스
        INDEX.md                 ← 산출물 목록 + 실제 경로
  done/                          ← Completed tasks
    {task-name}/...
  archive/                       ← Auto-cleaned after 30 days
    {yyyy-MM}/...
```

## Commands

### `/lake save "title"`

Create a task folder and save spec/plan/context.

**Steps:**

1. Generate slug from title (spaces→hyphens, lowercase, strip special chars)
2. Auto-extract:
   - Project: `basename $(git rev-parse --show-toplevel 2>/dev/null || basename $PWD)`
   - Branch: `git branch --show-current 2>/dev/null || "no-branch"`
3. Check if `~/.claude/prd-lake/inprogress/{slug}/` exists
   - Exists: update existing files (confirm overwrite)
   - New: create folder
4. AI drafts from current session conversation:
   - `spec.md`: Goal, background, requirements
   - `plan.md`: Checklist (`- [x]` done, `- [ ]` pending)
   - `context.md`: Branch, modified files, decisions
5. AskUserQuestion to confirm draft:
   - "Saving with this content. Anything to change?"
   - Proceed / Edit
6. Write files
7. Append to `journal/{today}.md`
8. AskUserQuestion: "Any artifacts (files/directories) to record? (path or skip)"
   - If path provided: create/update `artifacts/INDEX.md` with entry (path + auto-describe or prompt for description)
   - If "skip" or empty: proceed without artifacts

**spec.md template:**
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

**plan.md template:**
```markdown
# Plan

## Checklist
- [x] Completed item
- [ ] Pending item

## Notes
{Implementation notes}
```

**context.md template:**
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

**journal/{date}.md template:**
```markdown
# {yyyy-MM-dd}

## Work Done
- {time} {what was done}

## Notes
- {misc notes}
```

### `/lake list`

Show inprogress + done tasks.

**Steps:**

1. List subdirectories under `~/.claude/prd-lake/inprogress/` (Glob)
2. Read each directory's `spec.md` first line (title) and `context.md` Project
3. Sort by Updated date from `spec.md`
4. Mark items not updated for 7+ days as `(stale)`
5. Show up to 5 recent items from `done/`

**Output format:**
```
In Progress ({N}):
  1. {task-name} ({project}) — Updated {date}
  2. {task-name} ({project}) — Updated {date} (stale)

Done (recent 5):
  3. {task-name} ({project}) — Completed {date}
```

### `/lake resume [name]`

Load previous task context into current session.

**Steps:**

1. No argument:
   - Show inprogress list via AskUserQuestion
   - User selects
2. With argument:
   - Partial match in `~/.claude/prd-lake/inprogress/` (name substring)
   - Multiple matches → AskUserQuestion to select
3. Read spec.md, plan.md, context.md from selected task folder
4. **Output as plain text** (visible to user):
   ```
   === Loading previous work: {task-name} ===

   Spec:
   {spec.md content}

   Plan:
   {plan.md content}

   Context:
   {context.md content}

   Recent Journal ({latest date}):
   {latest journal file content}

   Artifacts:
   {artifacts/INDEX.md content}
   ```
   (Omit the Artifacts section if `artifacts/INDEX.md` does not exist)
5. Update spec.md Updated timestamp

### `/lake done [name]`

Mark task as completed.

**Steps:**

1. No argument → AskUserQuestion to select from inprogress list
2. With argument → partial match
3. Update `spec.md` Updated timestamp, change Status to done if present
4. Move task folder `inprogress/` → `done/`:
   ```bash
   mv ~/.claude/prd-lake/inprogress/{task-name} ~/.claude/prd-lake/done/{task-name}
   ```
5. Print completion confirmation

### `/lake search "keyword"`

Search lake files for keyword.

**Steps:**

1. Grep for keyword across `~/.claude/prd-lake/`
2. Show matched file's task name + status (inprogress/done) + matched line

**Output format:**
```
"{keyword}" search results:

  [inprogress] task-name/spec.md:3
    "matched line content"

  [done] other-task/plan.md:5
    "matched line content"
```

### `/lake journal [name]`

Add today's journal entry to a task.

**Steps:**

1. No argument → select from inprogress list
2. If `journal/{today}.md` exists → Edit, else → Write
3. AskUserQuestion for today's work
4. Append to journal file

### `/lake artifacts [name]`

Show or add artifacts to a task.

**Steps:**

1. No argument → AskUserQuestion to select from inprogress list
2. With argument → partial match in `~/.claude/prd-lake/inprogress/`
3. If `artifacts/INDEX.md` doesn't exist → create it with the header template below
4. Read and display current artifacts from INDEX.md:
   ```
   Artifacts for {task-name}:
   {INDEX.md content}
   ```
5. AskUserQuestion: "Add new artifact? Enter path and description (or 'done')"
   - If "done" or empty: finish
   - If path+description provided: append a new row to the table in INDEX.md, then repeat step 5

**artifacts/INDEX.md template:**
```markdown
# Artifacts

| # | Path | Description | Added |
|---|------|-------------|-------|
| 1 | ~/project/terraform/ | Terraform IaC for OCI ARM | 2026-04-10 |
```

When appending rows, increment `#` automatically based on the current highest row number.

## Notes

- Lake file total line limit: 200 lines (warn if exceeded)
- Non-git directory save: fallback Project to dirname
- Re-save same task name: update existing files (no new folder)
- `/lake save` should be minimal friction — require minimum user input
- Artifacts section in `/lake resume` is shown only when `artifacts/INDEX.md` exists
