# MongoDB Atlas + GridFS Migration

## Why

The backend originally ran on PostgreSQL (Supabase) for the database and Supabase Storage for file
attachments. Supabase's organization hit its billing quota and went into a restricted/unhealthy
state, blocking both the database and storage. Rather than fight that, the project moved fully off
Supabase:

- **Database**: PostgreSQL → **MongoDB Atlas** (Mongoose)
- **File attachments**: Supabase Storage → **MongoDB GridFS**

The frontend (`frontend/src/App.jsx`, `frontend/src/api.js`) needed **zero changes** — every route
path, request shape, and response JSON shape (including integer `id` fields) was kept identical.

## Key design decisions

### Integer `_id` instead of ObjectId
Every collection uses an **integer `_id`**, generated from a `counters` collection via an atomic
`findOneAndUpdate({_id: <name>}, {$inc: {seq: 1}}, {upsert: true, returnDocument: 'after'})`. This
keeps the frontend's existing `Number(id)` comparisons working with no changes on that side.

A shared `toJSON`/`toObject` transform (`jsonTransform` in `backend/src/database.js`) renames
`_id` → `id` and strips Mongoose's `__v` from every API response.

### Task codes
`nextTaskCode(session)` uses a separate daily counter document (`_id: 'PLN-YYMMDD'`), incremented
inside the same transaction session as the task-create call, so an aborted create rolls the counter
back too.

### Transactions
MongoDB multi-document ACID transactions (`mongoose.startSession()` + `session.withTransaction()`)
replace the old Postgres advisory-lock/transaction logic. A shared `withTransaction(callback)`
helper in `database.js` wraps every multi-write operation: user delete, task create, file upload
metadata insert, planning-lead reassignment, planner-assignment PUT, accept/decline sync, and the
single/multi-planner replace flow.

### No `.populate()`
Manual "joins" are done via batched `.lean()` queries + JS `Map` lookups instead of Mongoose's
`.populate()`, deliberately — to avoid field-name collisions with the existing `Number(id)` logic
used throughout the frontend and backend.

### GridFS file storage
- Files are streamed into a `GridFSBucket` (`task_attachments` bucket) after multer writes the
  temp file to local disk, then the `task_files` row is written inside the same transaction.
- Download/preview links are backend-relative URLs: `/files/:fileId?token=...&mode=download|preview`.
- `token` is a short-lived signed JWT (fileId + mode + expiry) — **no `Authorization` header**
  required, matching how the frontend already calls `fileUrl(...)` with no auth header.
- File delete uses `bucket.delete(gridfs_id)`, keeping the same best-effort (non-throwing) semantics
  used during cascading deletes.

### Cascading deletes
MongoDB has no FK cascade, so deletes are handled explicitly:
- **Task delete**: `task_planner_assignments`, `task_comments`, `task_files` (+ GridFS bytes),
  `task_status_history`, `task_declines`, `notifications`, then the task itself — all inside one
  transaction, via a shared `deleteTaskCascade(taskId, session)` helper.
- **User delete**: cascades every task the user owns, plus their planner assignments, comments,
  files, status history, declines, and notifications (`notifications` cleanup has no Postgres
  equivalent to copy — FK cascade handled it silently before, so this was added fresh).

## Windows-specific issue: `mongodb+srv://` DNS SRV failure

Node.js on Windows failed to resolve Atlas's `mongodb+srv://` connection string
(`querySrv ECONNREFUSED`). Worked around by manually resolving the SRV/TXT DNS records
(`nslookup -type=SRV`, `-type=TXT`) and building an equivalent standard `mongodb://` connection
string with explicit shard hosts plus `replicaSet=...&authSource=admin` query params.

## Data migration (legacy production data)

An earlier deployment of the app had already accumulated real production data (54 users, 526
tasks, ~11,500 related records) under the old ObjectId-`_id` + separate-numeric-`id` shape. This
was migrated to the new integer-`_id` schema with **zero data loss**, verified via before/after
document counts across all 7 relevant collections (users, tasks, taskplannerassignments,
taskcomments, taskfiles, taskstatushistories, notifications).

### BSON Date/String type-mismatch bug (major)
Legacy documents stored timestamp fields (`created_at`, etc.) as native BSON `Date`, while newly
created documents stored them as ISO **strings**. MongoDB's BSON type-ordering rules put all
`Date`-typed values above all `String`-typed values in a sort — regardless of the actual date —
so `.sort({created_at: -1})` silently ranked every legacy document above every new one. This broke
notification ordering and other date-based sorts across the app.

**Fix**: a one-off migration script converted every `Date`-typed timestamp field to an ISO string
(`$dateToString`) across all 8 collections, so every document uses a consistent field type. Verified
via a live API call showing correct descending date order after the fix.

## Removed
- `pg`, `@supabase/supabase-js` npm packages
- `DATABASE_URL`, `DB_SSL`, all `SUPABASE_*` env vars
- `validateSupabaseStorage()` and its startup call (GridFS needs no bucket-existence check — it's
  created implicitly on first write)

## Added
- `mongoose` npm package
- `MONGODB_URI` env var (Atlas connection string)
- `FILE_TOKEN_SECRET` / `FILE_LINK_SECONDS` env vars for signed file-link tokens
