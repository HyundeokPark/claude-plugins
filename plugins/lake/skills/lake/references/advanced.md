---
autoload: false
description: lake 스킬의 Notes 및 고급 주제
---

# Advanced Usage & Notes

## Notes

- Lake file total line limit: 200 lines (warn if exceeded)
- Non-git directory save: fallback Project to dirname
- Re-save same task name: update existing files (no new folder)
- `/lake save` should be minimal friction — require minimum user input
- Artifacts section in `/lake resume` is shown only when `artifacts/INDEX.md` exists

`--view=summary`/`--view=compressed` opt-in 플래그는 lake-cli.js의 `help` 서브커맨드로 확인하세요.

## 세션 자동 기록 (spool + compactor, v1.7.0+)

`/lake save`를 깜빡해도 세션 활동이 유실되지 않도록, 훅이 활동을 자동 기록한다.

```
세션 중:  UserPromptSubmit/PostToolUse 훅 → .spool/{session_id}.jsonl append (LLM 없음)
저장/재개: lake-cli resume·upsert → .active-task 마커 ("이 세션은 이 태스크")
세션 종료: SessionEnd 훅 → lake-compactor.js (detached, claude -p haiku)
           ├─ journal/{today}.md: "세션 자동 기록" 섹션 append — 정제(시간순 사실), 요약 아님
           └─ context.md: <!-- lake:auto-context --> 마커 구간만 덮어쓰기 (수동 작성분 보존)
크래시:    다음 SessionStart 훅이 고아 spool(mtime 2분+) 발견 → compactor 재실행 (최대 3개)
```

- 자동 저장 범위는 journal/context뿐. spec/plan은 의도적 저장(`/lake save`) 전용.
- 마커 없는 세션의 spool은 `.spool/unfiled/`에 보존 (잘못된 태스크 오염 방지).
- 이벤트 3개 미만 spool은 폐기. compactor 로그: `.spool/compactor.log`.
- 재귀 방지: compactor의 headless claude에는 `LAKE_COMPACTOR=1`이 심어져 훅이 spool을 남기지 않음.
- 테스트: `tests/autosave-golden.sh` (LAKE_SUMMARIZER_CMD 스텁으로 LLM 없이 검증).
- 동시 세션 주의: 마커는 전역 1개라, 병렬 세션이 서로 다른 태스크를 작업하면 나중 마커가 이긴다.
