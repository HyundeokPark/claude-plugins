---
name: lake
description: "PRD Lake - Session progress persistence system. Save work progress per task (spec/plan/context/journal) and resume instantly in the next session."
argument-hint: "save|list|resume|done|search|artifacts|link|unlink|tree|relate|unrelate|tag|untag|block|unblock [args]"
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
    "updated": "2026-04-10",
    "parent": "a1b2c3",
    "children": ["23db04", "3415d8"]
  }
]
```

`parent` and `children` are optional. `parent` is the id of the parent epic. `children` is an array of child task ids. `relates` is an array of bidirectionally linked task ids. `tags` is an array of tag strings (without `#` prefix). `blocked_by` is an array of blocker task ids. `blocks` is an array of task ids this task blocks.

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
| `link <parent> <child>` | Link parent-child epic |
| `unlink <parent> <child>` | Unlink parent-child epic |
| `tree [hash-or-slug]` | Show epic tree |
| `relate <task1> <task2>` | Bidirectional relates-to link |
| `unrelate <task1> <task2>` | Remove relates-to link |
| `tag <task> <tag1> [tag2...]` | Add tags to a task |
| `untag <task> <tag1> [tag2...]` | Remove tags from a task |
| `block <blocked> <blocker>` | Mark task as blocked by another |
| `unblock <blocked> <blocker>` | Remove blocked-by link |

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

Show inprogress + done tasks. **Bash 1회로 끝낸다.**

**Steps:**

1. Run: `node ~/.claude/prd-lake/lake-cli.js list`
2. Output the result as-is to the user (do NOT reformat)

That's it. No Read, no Glob. CLI output is the final output.

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

### `/lake link <parent> <child>`

Link two tasks as parent-child (epic structure). Uses hash prefix or slug substring.

**Steps:**

1. Run: `node ~/.claude/prd-lake/lake-cli.js link <parent> <child>`
2. Print confirmation

**Example:**
```
/lake link 2f3d89 23db04
→ Linked: [2f3d89] Oracle 인프라 ← [23db04] 자동매매
```

### `/lake unlink <parent> <child>`

Remove parent-child link.

**Steps:**

1. Run: `node ~/.claude/prd-lake/lake-cli.js unlink <parent> <child>`
2. Print confirmation

### `/lake tree [name-or-hash]`

Show epic tree hierarchy.

**Steps:**

1. No argument: show all epic trees
2. With argument: find the task, walk up to root, show full tree from root
3. Run: `node ~/.claude/prd-lake/lake-cli.js tree [arg]`

**Output format:**
```
📋 [a1b2c3] n8n 자동화 허브 (personal-infra)
    └─ [23db04] 자동매매 (auto-trading)
    └─ [3415d8] 청약/임대 알림 (my-dashboard)
```

### `/lake relate <task1> <task2>`

Bidirectional "relates to" link between two tasks. Both sides get the link.

**Steps:**

1. Run: `node ~/.claude/prd-lake/lake-cli.js relate <task1> <task2>`
2. Print confirmation

**Example:**
```
/lake relate 23db04 3415d8
→ Related: [23db04] 자동매매 ↔ [3415d8] 청약/임대 알림
```

### `/lake unrelate <task1> <task2>`

Remove bidirectional relates-to link.

**Steps:**

1. Run: `node ~/.claude/prd-lake/lake-cli.js unrelate <task1> <task2>`
2. Print confirmation

### `/lake tag <task> <tag1> [tag2...]`

Add tags to a task. Tags are searchable via `/lake search #tagname`.

**Steps:**

1. Run: `node ~/.claude/prd-lake/lake-cli.js tag <task> <tag1> [tag2...]`
2. Print confirmation

**Example:**
```
/lake tag 23db04 n8n migration trading
→ Tagged: [23db04] 자동매매 → #n8n #migration #trading
```

### `/lake untag <task> <tag1> [tag2...]`

Remove tags from a task.

**Steps:**

1. Run: `node ~/.claude/prd-lake/lake-cli.js untag <task> <tag1> [tag2...]`
2. Print confirmation

### `/lake block <blocked> <blocker>`

Mark a task as blocked by another (dependency/선행 조건). The blocked task cannot proceed until the blocker is done.

**Steps:**

1. Run: `node ~/.claude/prd-lake/lake-cli.js block <blocked> <blocker>`
2. Print confirmation

**Example:**
```
/lake block 9e2963 2f3d89
→ Blocked: [9e2963] n8n 자동화 허브 ──blocked by──→ [2f3d89] Oracle K3s 인프라
```

Resume output shows both sides:
- Blocked task: `🚫 Blocked by: [2f3d89] Oracle K3s 인프라`
- Blocker task: `⏳ Blocks: [9e2963] n8n 자동화 허브`

### `/lake unblock <blocked> <blocker>`

Remove blocked-by dependency link.

**Steps:**

1. Run: `node ~/.claude/prd-lake/lake-cli.js unblock <blocked> <blocker>`
2. Print confirmation

### `/lake save "title"` with `--parent`

When saving with `--parent <hash>`, automatically link the new task as a child of the parent.

**Additional step after step 7 (upsert):**
- If `--parent` provided: Run `node ~/.claude/prd-lake/lake-cli.js link <parent-hash> <new-task-hash>`

## Notes

- Lake file total line limit: 200 lines (warn if exceeded)
- Non-git directory save: fallback Project to dirname
- Re-save same task name: update existing files (no new folder)
- `/lake save` should be minimal friction — require minimum user input
- Artifacts section in `/lake resume` is shown only when `artifacts/INDEX.md` exists
