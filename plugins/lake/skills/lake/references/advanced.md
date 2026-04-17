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
