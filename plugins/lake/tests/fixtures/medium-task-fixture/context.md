# Context: Medium Task Fixture

- **Branch**: feature/campaign-list-pagination-WP-4320
- **Files**: apps/nestads-frontend/src/pages/campaigns/, packages/ui/src/components/skeleton/

## Decisions

- Chose React Query over SWR: better cache invalidation primitives and devtools support.
- Cursor-based pagination selected over offset pagination: avoids page drift on concurrent inserts.
- Filter state in URL via useSearchParams: enables shareable links without extra state management.
- Debounce at 300ms after user testing showed 200ms felt laggy on slow connections.
- Skeleton loader added to shared UI library rather than inline: reusable for ad group list refactor.
- Decided not to implement virtual scrolling in this ticket — separate optimization task.
- React.memo applied only to CampaignRow, not the filter panel (filter panel re-renders are cheap).

## API Notes

- /v2/campaigns returns: `{ items: [], nextCursor: string|null, totalCount: number }`
- Cursor is base64(timestamp + ":" + lastId) — decode for display in debug tools only.
- Filter params: status (enum), dateFrom (ISO), dateTo (ISO), projectId (UUID).
- Empty nextCursor means last page — disable "Next" button.

## Blockers

- Figma spec for the filter panel has not been finalized — waiting for design review from @ux-lead.
- /v2/campaigns endpoint returns 404 in staging — backend ticket WP-4315 must deploy first.
- Keyboard navigation (a11y) for the date range picker requires custom ARIA implementation; no library solution found yet.
