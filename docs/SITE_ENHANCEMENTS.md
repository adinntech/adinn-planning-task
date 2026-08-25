# Production Enhancements & Bug Fixes

Deployed stack: Render (backend) + Vercel (frontend). This log covers fixes and features shipped
against the live app after the [MongoDB migration](./MONGODB_MIGRATION.md).

## Bug fixes

### CORS blocking cross-origin requests
`CORS_ORIGIN` supports a comma-separated list of allowed origins, but the `cors` package was
echoing the raw joined string back as `Access-Control-Allow-Origin`, which browsers reject as
invalid. Fixed with a dynamic origin callback in `backend/src/server.js` that checks the request's
`origin` against the parsed allow-list and reflects back only that one origin.

### File preview blocked by CSP (`frame-ancestors`)
Image/PDF previews worked via `curl` but rendered blank in the browser. Helmet's default
`frame-ancestors 'self'` CSP directive was blocking the frontend's cross-origin `<iframe>` embed.
Fixed by overriding the CSP header specifically on the `GET /files/:fileId` route to
`frame-ancestors 'self' <allowed origins>`.

### Completed-tasks list sorted incorrectly
The completed-tasks view sorted by raw string comparison on date fields that weren't in a
consistent format. Fixed by parsing to a timestamp (`new Date(value).getTime()`) before comparing,
with a fallback chain (`effectiveDeadline → completed_at → updated_at → created_at`) and a
stable tiebreaker on `id`.

### Notifications (and other date-sorted lists) showing wrong order
Root cause was the BSON Date/String type-mismatch described in
[MONGODB_MIGRATION.md](./MONGODB_MIGRATION.md#bson-datestring-type-mismatch-bug-major) — legacy
`Date`-typed documents always sorted above newer `String`-typed ones. Fixed via a one-off data
migration normalizing every timestamp field to a consistent string type across all 8 collections.

## Features added

### Pagination (tasks & notifications)
Added a reusable `Pagination` component (`frontend/src/App.jsx`) used on all task list views
(others/mine/main) and the notifications list:
- Page-size dropdown (10 / 50 / 100 per page)
- **First / Previous / Next / Last** navigation buttons
- Page state resets to 1 whenever the active filters change

### Desktop notifications (tab-open only)
`NotificationBell` requests browser `Notification` permission on mount and, on each notification
poll, fires a native desktop popup for any notification newer than the last one already seen
(tracked via a `useRef`, so nothing fires spuriously on first load). Clicking a popup focuses the
tab and opens the related task. Scoped deliberately to "tab must be open" — no service worker /
push subscription — per user preference for the simplest reliable option.

## Known, deliberately unresolved

### Render free-tier cold start
The backend sleeps after ~15 minutes idle on Render's free tier; the first request after that
takes 30-60s to wake it, which can look like a connection failure. Two options were identified but
not decided on:
1. Upgrade to a paid Render plan (no sleep)
2. Add an external keep-alive ping (e.g. a cron hitting `/api/health` every ~10 min)

No action taken yet — revisit if cold starts become a recurring complaint.
