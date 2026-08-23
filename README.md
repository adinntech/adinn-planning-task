# ADINN Planning Task Manager

A white ADINN-themed planning work allocation and tracker for the Planning Desk.

## Current version

- Create Task uses only the planning brief fields requested by ADINN, plus Assign Planner.
- BD can assign planning requests to planners.
- Planners can accept or decline with reason.
- Admin can create, deactivate, activate, and permanently delete users.
- Planner planning options can be selected as Outdoor and/or Roadshow.
- Data is now stored in PostgreSQL using `DATABASE_URL`, so production data is safer than local SQLite.

## Tech stack

- Frontend: React + Vite
- Backend: Node.js + Express
- Database: PostgreSQL via `pg`
- Auth: JWT

## Required database

Create a PostgreSQL database first. Supabase, Neon, Railway PostgreSQL, Render PostgreSQL, or any managed PostgreSQL will work.

Set this in `backend/.env`:

```env
PORT=5001
JWT_SECRET=change-this-to-a-long-random-secret
CORS_ORIGIN=http://localhost:5173
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
DB_SSL=true
UPLOAD_DIR=./uploads
```

For local PostgreSQL without SSL, set:

```env
DB_SSL=false
```

## Install

```bash
npm install
npm run install:all
```

## Run backend

```bash
cd backend
cp .env.example .env
# Add your real DATABASE_URL in .env before starting
npm run dev
```

The backend creates the PostgreSQL tables automatically and verifies the default users.

## Run frontend

```bash
cd frontend
npm run dev
```

Open:

```text
http://localhost:5173
```

## Default logins

| Role | Email | Password |
|---|---|---|
| Admin | admin@adinn.co.in | Admin@123 |
| BD | bd@adinn.co.in | BD@123 |
| Planner | planner@adinn.co.in | Planner@123 |
| Planner 2 | planner2@adinn.co.in | Planner@123 |

Change these passwords after the first production login.

## Deployment notes

### Render backend

Root directory:

```text
backend
```

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Environment variables:

```env
JWT_SECRET=your-long-production-secret
CORS_ORIGIN=https://your-vercel-url.vercel.app
DATABASE_URL=your-postgresql-connection-string
DB_SSL=true
UPLOAD_DIR=/data/uploads
```

For file uploads on Render, add a persistent disk mounted at `/data` if you want uploaded files to survive redeploys.

### Vercel frontend

Root directory:

```text
frontend
```

Build command:

```bash
npm run build
```

Output directory:

```text
dist
```

Environment variable:

```env
VITE_API_URL=https://your-render-backend-url.onrender.com/api
```


## Login security update

- Login form no longer pre-fills any email or password by default.
- Password is never auto-filled by demo shortcuts.
- Remember Me stores the session in localStorage for persistent login.
- Without Remember Me, the session is stored only in sessionStorage and ends when the browser session closes.


## Safety Update

- Protected admin accounts cannot be deactivated or deleted from the Users page.
- Backend also blocks admin deactivation, deletion, and role conversion for safety.
- If an admin was deactivated earlier, reactivate it in Supabase with: `UPDATE users SET status = 'active' WHERE role = 'admin';`

## Planning Lead Workflow Update

This version adds a new **Planning Lead** role.

Workflow:
1. **BD / Admin** creates the planning task request.
2. The task is assigned first to a **Planning Lead**.
3. The **Planning Lead** opens the task and assigns it to a **Planner**.
4. The **Planner** accepts or declines the task with a reason.
5. BD, Planning Lead, Planner and Admin can track the task according to their access level.

Default Planning Lead login:

| Role | Email | Password |
|---|---|---|
| Planning Lead | lead@adinn.co.in | Lead@123 |

Admin accounts remain protected and cannot be deactivated or deleted.
