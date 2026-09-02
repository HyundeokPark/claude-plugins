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
      journal/{yyyy-MM-dd}.md    ← Daily work log
      artifacts/INDEX.md         ← 산출물 목록 + 실제 경로
  done/{task-name}/...           ← Completed tasks
  archive/{yyyy-MM}/...          ← Auto-cleaned after 30 days
```

### index.json format

```json
[{ "id": "ce119e", "slug": "내집마련-로드맵", "title": "내집마련 로드맵",
   "project": "my-dashboard", "status": "inprogress",
   "created": "2026-04-10", "updated": "2026-04-10" }]
```

Optional fields: `parent` (parent epic id), `children` (child task ids), `relates` (bidirectionally linked task ids), `tags` (tag strings without `#`), `blocked_by` (blocker task ids), `blocks` (task ids this task blocks). `id` is a 6-char SHA1 hash of the slug. Users can reference tasks by hash prefix (e.g. `ce11`).

### project registry — `projects.json` (optional, per-install)

`~/.claude/prd-lake/projects.json`이 프로젝트 정식명 + alias를 정의하면 자유 입력된 `project`
값이 `list --project` 아래로 깔끔히 묶이고 `upsert`가 저장 시 정규화한다. **파일이 없거나
깨져도 강제 없음(완전 하위호환).** 형식·정규화 규칙 → `references/advanced.md`,
`scripts/projects.example.json`.

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
| `plan-check <hash-or-slug>` | plan.md stale 여부 + journal/Blockers 불일치 후보 (save 4단계 필수) |

## Commands

### `/lake save "title"`

Create or update a task folder and save spec/plan/context.

1. Generate slug; auto-extract Project (git root) and Branch
2. Check if folder exists → update (confirm) or create new
3. AI drafts spec.md / plan.md / context.md from current session
4. **Reconcile plan.md — 반드시 커맨드로 한다** (기억에 의존한 판단 금지):
   `node ~/.claude/prd-lake/lake-cli.js plan-check <hash>` 를 실행하고, 출력된 **후보마다**
   `체크 [x] / 대기 [~] / 폐기 [-] / 유지 [ ]` 중 하나를 판정해 plan.md에 반영한다.
   `[~]`엔 `(until: YYYY-MM-DD)`, `[-]`엔 `(폐기 YYYY-MM-DD) 사유`를 붙인다.
   폐기 항목은 **삭제하지 않는다**. 배경·어휘 상세 → `references/advanced.md`
5. AskUserQuestion: "Saving with this content. Anything to change?"
   — **plan 상태 변경 diff 필수 포함** (무엇을 `[x]`/`[~]`/`[-]`로 바꿨는지 항목별로).
6. Write files; run `lake-cli.js upsert` to update index.json
7. Append to `journal/{today}.md`
8. AskUserQuestion: "Any artifacts to record? (path or skip)"

> **"다음 할 일"의 단일 정본은 `plan.md`다.** context.md의 `<!-- lake:auto-context -->`는
> compactor가 쓰는 **최근 활동 로그**이지 할 일 목록이 아니다. 둘이 다르면 plan.md가 이긴다.
> brief는 미체크 항목 중 **위 3개만** 집는다. 급한 게 아래 깔리면 `- [ ] ★1 ...` 처럼 **맨 앞에 `★N`**(작은 수 먼저)을 달아라.

> **📍는 태스크 상태가 아니다 — 절대 "지금 할 일"로 읽지 마라.** compactor가 Claude Code의
> away_summary(자리 비울 때의 *대화* 상태)를 수확한 것이라, 세션 끝이 도구 수리였으면 그
> 얘기가 올라온다. 손으로 쓰려면 `<!-- lake:auto-recap -->` 마커를 지우면 자동이 안 덮는다.

Templates → see `references/templates.md`. `--parent` flag → see `references/epic-graph.md`.

### `/lake list`

**Bash 1회로 끝낸다. 기본 `--view=compressed`(빠름 — 1줄/태스크).**

1. Run: `node ~/.claude/prd-lake/lake-cli.js list --view=compressed`
   - **사용자가 프로젝트를 지목하면 반드시 cli 인자로 넘긴다**: `list nestads --view=compressed`.
     전체를 받아 **손으로 필터하지 말 것** — stale·truncate 때문에 일부만 집는다. cli 필터는
     projects.json으로 정규화 + truncation 없이 전부 보여준다 (없으면 정확 일치).
2. Echo captured stdout verbatim inside a fenced code block in your text reply. No Read, no Glob.
3. 전체 트리는 `--view=tree`, 오래된 항목까지 모두 보려면 `--view=all`.

### `/lake resume [name-or-hash]`

**Bash 1회로 끝낸다. 기본 `--view=slim`(📍 지난 세션 요약 1개 + 다음 할 일 1개 + Blockers). recap이 없으면 brief로 자동 폴백.**

1. No arg: run `list --view=compressed`, AskUserQuestion to select
2. With arg: `lake-cli.js resume <arg>` → Echo captured stdout verbatim inside a fenced code block. slim이 기본이라 view 플래그 없이 호출.
   **slim이 나왔으면 정상이다. brief가 안 나왔다고 다시 호출하지 말 것.**
3. `--view=brief`(Goal/여기까지/이제 할 차례/대기중/Blockers/Context)는 사용자가 "자세히"를 원하거나 그 task 작업을 이어서 요청할 때(구현/디버그/수정 등)만 호출하고, 그 컨텍스트로 곧바로 시작한다 — full을 미리 호출하지 말 것.
4. **slim/brief 최상단에 `⚠ plan.md가 저널보다 낡음` 또는 `⚠ 요약 기준일 … 미반영`이 뜨면 할 일 목록을 그대로 보고하지 말 것.**
   `plan-check <hash>`를 먼저 돌려 후보를 판정한 뒤 이어간다. `⏳ 대기중`은 착수 가능한 일이 아니고, 폐기(`[-]`)는 brief에서 숨겨진다(`--view=full`에서 확인).
   **`… 외 N건`이 붙어 있으면 "이게 전부"라고 보고하지 말 것** — 감춰진 N건이 있다.
5. 작업 중 journal/history 정보가 *명시적으로* 필요할 때만 `--view=full` 호출.
6. 사용자가 명시적으로 다른 view를 요청하면(`brief`, `summary`, `recap`, `minimal`, `files`) 그 플래그로 호출.
7. Update spec.md Updated timestamp + `lake-cli.js upsert` — upsert JSON에는 **`slug`를 반드시 포함**한다(기존 항목 매칭 키가 slug 하나다). `id`만 넘기면 신규로 취급되어 해시 계산에서 `ERR_INVALID_ARG_TYPE`로 죽는다. slug는 `find <hash>`로 얻는다.

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
