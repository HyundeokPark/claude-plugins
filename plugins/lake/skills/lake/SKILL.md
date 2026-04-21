---
name: lake
description: "PRD Lake - Session progress persistence system. Save work progress per task (spec/plan/context/journal) and resume instantly in the next session."
argument-hint: "save|list|resume|done|search|artifacts|link|unlink|tree|relate|unrelate|tag|untag|block|unblock [args]"
---

# /lake — PRD Lake Session Progress Persistence

## Role

Save work progress to `~/.claude/prd-lake/` per task, so you can instantly restore context in the next session even after session termination.

**Design philosophy:** Make `/lake save` as frictionless as Ctrl+S.

> **Do NOT Read `skills/lake/references/*.md` unless the user invokes one of:**
> `link`, `unlink`, `tree`, `relate`, `unrelate`, `tag`, `untag`, `block`, `unblock`, or `save --parent`.
> Each reference file declares `autoload: false` in its frontmatter and must be opened on demand only.

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

> **IMPORTANT — visibility rule:** Bash tool stdout is NOT rendered to the user in this environment. For every `lake-cli.js` invocation whose output the user needs to see (`list`, `resume`, `search`, `tree`, `find`, and confirmation messages from `done`/`link`/`tag`/`block`/etc.), the assistant MUST copy the captured stdout verbatim into a fenced code block in the final text reply. Do not summarize or paraphrase. If stdout is empty, say so explicitly.

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

Create or update a task folder and save spec/plan/context.

1. Generate slug; auto-extract Project (git root) and Branch
2. Check if folder exists → update (confirm) or create new
3. AI drafts spec.md / plan.md / context.md from current session
4. AskUserQuestion: "Saving with this content. Anything to change?"
5. Write files; run `lake-cli.js upsert` to update index.json
6. Append to `journal/{today}.md`
7. AskUserQuestion: "Any artifacts to record? (path or skip)"

Templates → see `references/templates.md`. `--parent` flag → see `references/epic-graph.md`.

### `/lake list`

**Bash 1회로 끝낸다. 기본 `--view=compressed`(빠름 — 1줄/태스크).**

1. Run: `node ~/.claude/prd-lake/lake-cli.js list --view=compressed`
2. Echo captured stdout verbatim inside a fenced code block in your text reply. No Read, no Glob.
3. 전체 트리는 `--view=tree`, 오래된 항목까지 모두 보려면 `--view=all`.

### `/lake resume [name-or-hash]`

**Bash 1회로 끝낸다. 기본 `--view=summary`(빠름 — 토큰 최소).**

1. No arg: run `list --view=compressed`, AskUserQuestion to select
2. With arg: `lake-cli.js resume <arg> --view=summary` → Echo captured stdout verbatim inside a fenced code block in your text reply
3. summary로 부족하거나 사용자가 전체 내용을 요청하면 `lake-cli.js resume <arg> --view=full` 재호출
4. Update spec.md Updated timestamp + `lake-cli.js upsert`

### `/lake done [name-or-hash]`

**Bash 1회로 끝낸다.**

1. No arg: run `list`, AskUserQuestion to select
2. With arg: `lake-cli.js done <arg>` → print confirmation

### `/lake search "keyword"`

1. Run: `node ~/.claude/prd-lake/lake-cli.js search <keyword> --view=compressed` → Echo captured stdout verbatim inside a fenced code block in your text reply
2. 결과가 잘리거나 더 보고 싶으면 `--view=full`로 재호출

### `/lake journal [name-or-hash]`

1. No arg: run `list`, AskUserQuestion to select
2. Resolve path via `lake-cli.js find <arg>`
3. Edit or Write `journal/{today}.md`; AskUserQuestion for today's work; append

### `/lake artifacts [name-or-hash]`

1. No arg: run `list`, AskUserQuestion to select
2. Resolve via `lake-cli.js find <arg>`; create `artifacts/INDEX.md` if missing
3. Display current artifacts; AskUserQuestion: "Add new artifact? (path+desc or 'done')"

Artifact INDEX.md template → see `references/templates.md`.

### Epic graph commands (link/unlink/tree/relate/unrelate/tag/untag/block/unblock/save --parent)

Read `references/epic-graph.md` only when one of these commands is invoked.

## Notes

See `references/advanced.md` for full notes and advanced usage.

- Lake file total line limit: 200 lines (warn if exceeded)
- Re-save same task name: update existing files (no new folder)
- `/lake save` should be minimal friction

## References (lazy-load when needed)

- `/Users/hyundeokpark/.claude/plugins/marketplaces/hpotter-plugins/plugins/lake/skills/lake/references/templates.md` — spec/plan/context/journal/artifacts 템플릿
- `/Users/hyundeokpark/.claude/plugins/marketplaces/hpotter-plugins/plugins/lake/skills/lake/references/epic-graph.md` — link/unlink/tree/relate/unrelate/tag/untag/block/unblock, save --parent
- `/Users/hyundeokpark/.claude/plugins/marketplaces/hpotter-plugins/plugins/lake/skills/lake/references/advanced.md` — Notes, advanced usage
