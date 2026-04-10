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
  index.json                     ← Task index (lake list reads ONLY this)
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

### index.json format

```json
[
  {
    "id": "ce119e",
    "slug": "내집마련-로드맵",
    "title": "내집마련 로드맵",
    "project": "my-dashboard",
    "status": "inprogress",
    "created": "2026-04-10",
    "updated": "2026-04-10"
  }
]
```

`id` is a 6-char SHA1 hash of the slug. Users can reference tasks by hash prefix (e.g. `ce11`).

### lake-cli.js

Located at `~/.claude/prd-lake/lake-cli.js`. This is the **performance layer** — all read-heavy commands MUST use it via Bash to avoid multiple tool calls.

```
node ~/.claude/prd-lake/lake-cli.js <command> [args]
```

| Command | Description |
|---------|-------------|
| `list` | Print task table from index.json |
| `find <hash-or-slug>` | Find task, print JSON |
| `resume <hash-or-slug>` | Print all files (spec+plan+context+journal+artifacts) |
| `upsert '<json>'` | Add or update index entry |
| `done <hash-or-slug>` | Move to done, update index |
| `search <keyword>` | Grep across all lake files |
| `rebuild` | Rebuild index.json from disk |

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
7. Run `node ~/.claude/prd-lake/lake-cli.js upsert '<json>'` to update index.json (with id, slug, title, project, status, created, updated)
8. Append to `journal/{today}.md`
9. AskUserQuestion: "Any artifacts (files/directories) to record? (path or skip)"
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

Show inprogress + done tasks. **Read 1회로 끝낸다.**

**Steps:**

1. Read `~/.claude/prd-lake/index.json` (Read tool — no Bash, no Glob)
2. Parse JSON and format output directly

**Output format:**
```
In Progress ({N}):
  1. {id} {title} ({project}) — Updated {date}

Done ({N}):
  2. {id} {title} ({project}) — Updated {date}
```

That's it. No Bash, no Glob.

### `/lake resume [name-or-hash]`

Load previous task context into current session. **Bash 1회로 끝낸다.**

**Steps:**

1. No argument:
   - Run `node ~/.claude/prd-lake/lake-cli.js list` to show options
   - AskUserQuestion to select (hash or name)
2. With argument (hash prefix or slug substring):
   - Run: `node ~/.claude/prd-lake/lake-cli.js resume <arg>`
   - This prints spec+plan+context+journal+artifacts in one shot
3. Output the result as-is to the user
4. Update spec.md Updated timestamp + run `lake-cli.js upsert` to sync index

### `/lake done [name-or-hash]`

Mark task as completed. **Bash 1회로 끝낸다.**

**Steps:**

1. No argument:
   - Run `node ~/.claude/prd-lake/lake-cli.js list` to show options
   - AskUserQuestion to select
2. With argument:
   - Run: `node ~/.claude/prd-lake/lake-cli.js done <arg>`
   - This moves the folder and updates index in one shot
3. Print completion confirmation

### `/lake search "keyword"`

Search lake files for keyword. **Bash 1회로 끝낸다.**

**Steps:**

1. Run: `node ~/.claude/prd-lake/lake-cli.js search <keyword>`
2. Output the result as-is to the user

### `/lake journal [name-or-hash]`

Add today's journal entry to a task.

**Steps:**

1. No argument:
   - Run `node ~/.claude/prd-lake/lake-cli.js list` to show options
   - AskUserQuestion to select
2. With argument:
   - Run `node ~/.claude/prd-lake/lake-cli.js find <arg>` to resolve task slug/path
3. If `journal/{today}.md` exists → Edit, else → Write
4. AskUserQuestion for today's work
5. Append to journal file

### `/lake artifacts [name-or-hash]`

Show or add artifacts to a task.

**Steps:**

1. No argument:
   - Run `node ~/.claude/prd-lake/lake-cli.js list` to show options
   - AskUserQuestion to select
2. With argument:
   - Run `node ~/.claude/prd-lake/lake-cli.js find <arg>` to resolve task
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
