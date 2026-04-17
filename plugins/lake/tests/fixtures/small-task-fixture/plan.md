# Plan: Small Task Fixture

## Checklist

- [x] Read lake-cli.js and understand cmdResume structure
- [x] Identify PROTECTED_SECTIONS requirements from plan doc
- [x] Define FLAG_SPEC constant with allowlist per command
- [x] Implement parseFlags(cmd, args) with conflict detection
- [x] Add VIEW_DEFAULTS_V1 constants block
- [x] Write renderResumeFull() extracting v0 byte-identical logic
- [x] Add RESUME_SECTION_BUDGETS and HARD_CHAR_CAP constants
- [x] Implement hybrid budget allocation loop
- [x] Handle protected-only overflow: relax cap + emit stderr warning
- [x] Write unit test for parseFlags unknown flag → exit 2
- [ ] Implement renderResumeSummary() with DROP_PRIORITY ordering
- [ ] Add spec.md Goal-section fallback (frontmatter + 20 lines)
- [ ] Wire --view=summary opt-in path through cmdResume
- [ ] Create tests/fixtures/ directory structure
- [ ] Write setup-fixtures.sh and capture-v0-golden.sh
- [ ] Run capture-v0-golden.sh and verify 7 golden files
- [ ] Add BASELINE_SHA.txt with commit hash
- [ ] Verify diff 0 bytes between resume output and golden file
- [ ] Run snapshot.sh TZ=UTC and confirm exit 0
- [ ] Update SKILL.md with lazy-load directive for references
