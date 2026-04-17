# Context: Small Task Fixture

- **Branch**: feature/lake-token-diet-v1
- **Files**: scripts/lake-cli.js, tests/fixtures/, tests/golden/

## Decisions

- Use FLAG_SPEC allowlist approach to reject unknown flags with exit 2.
- VIEW_DEFAULTS_V1 sets resume='full' to preserve v0 byte-identical default.
- Golden baseline captured at SHA c3f4569 before any cli.js modifications.

## Blockers

- Need to confirm TZ=UTC is sufficient for deterministic snapshot output or if LAKE_NOW env var must also be wired into today() before capturing golden files.
- Waiting for architect review on whether hybrid cap overflow should emit to stderr or a separate log file.
- The current lake-cli.js uses emoji in console output (📋, 🔗, 🚫) — need to verify these render consistently across macOS and Linux terminal emulators for byte-identical comparison.
