---
autoload: false
description: epic 그래프 명령(link/unlink/tree/relate/unrelate/tag/untag/block/unblock/save --parent)
---

# Epic Graph Commands

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
