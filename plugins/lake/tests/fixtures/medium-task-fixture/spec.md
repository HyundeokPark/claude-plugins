# Medium Task Fixture

- **Project**: nestads-frontend
- **Created**: 2026-04-13
- **Updated**: 2026-04-15

## Goal

Redesign the campaign list page to show pagination controls.
Add server-side filtering by status, date range, and project.
Integrate with the new backend API endpoint /v2/campaigns.
Display loading skeletons while data is being fetched.
Handle empty states gracefully with actionable CTAs.

## Background

The current campaign list loads all campaigns at once, causing slow TTI on large accounts.
A paginated approach with server-side filtering will reduce initial payload from ~2MB to ~50KB.
The new /v2/campaigns endpoint supports cursor-based pagination.
Design specs are in Figma — see context.md for link.
This task is a prerequisite for the ad group list refactor (WP-4321).

## Acceptance Criteria

- Page loads in under 1 second on 3G throttle.
- Filter state is reflected in the URL for shareability.
- Keyboard navigation works for the filter dropdowns.
- Pagination preserves scroll position when going back.
- All existing E2E tests continue to pass.

## Technical Notes

Use React Query for data fetching and cache invalidation.
The cursor is a base64-encoded timestamp+id composite key.
Debounce filter changes by 300ms before triggering API calls.
Add a skeleton loader component to the shared UI library.
