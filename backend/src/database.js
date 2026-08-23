const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

function now() {
  return new Date().toISOString();
}

function getSslConfig(connectionString) {
  if (process.env.DB_SSL === 'false') return false;
  if (!connectionString) return false;
  if (connectionString.includes('localhost') || connectionString.includes('127.0.0.1')) return false;
  return { rejectUnauthorized: false };
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('DATABASE_URL is not set. Add a PostgreSQL connection string in backend/.env before starting the backend.');
}

const pool = new Pool({
  connectionString,
  ssl: getSslConfig(connectionString)
});

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function one(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

async function many(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function exec(sql, params = []) {
  return query(sql, params);
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = {
      query: (sql, params = []) => client.query(sql, params),
      one: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return result.rows[0] || null;
      },
      many: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return result.rows;
      }
    };
    const result = await callback(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

async function createSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'planning_lead', 'planner')),
      department TEXT DEFAULT 'Planning',
      phone TEXT DEFAULT '',
      verticals TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      task_code TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT 'Planning Request',
      client_name TEXT DEFAULT '',
      brand_name TEXT DEFAULT '',
      direct_client_or_agency TEXT DEFAULT '',
      agency_name TEXT DEFAULT '',
      campaign_name TEXT DEFAULT '',
      campaign_type TEXT DEFAULT '',
      city TEXT DEFAULT '',
      state TEXT DEFAULT '',
      category TEXT DEFAULT '',
      deliverable TEXT DEFAULT '',
      description TEXT DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'Medium' CHECK(priority IN ('Low', 'Medium', 'High', 'Urgent')),
      status TEXT NOT NULL DEFAULT 'Pending Acceptance',
      assigned_by INTEGER NOT NULL REFERENCES users(id),
      assigned_to INTEGER NOT NULL REFERENCES users(id),
      planning_lead_id INTEGER REFERENCES users(id),
      start_date TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      campaign_start_date TEXT DEFAULT '',
      campaign_duration TEXT DEFAULT '',
      campaign_budget TEXT DEFAULT '',
      display_cost_range TEXT DEFAULT '',
      target_areas TEXT DEFAULT '',
      target_audience_profile TEXT DEFAULT '',
      site_preferences TEXT DEFAULT '',
      ownership_type TEXT DEFAULT '',
      location_type TEXT DEFAULT '',
      size_preference TEXT DEFAULT '',
      additional_specifications TEXT DEFAULT '',
      plan_format TEXT DEFAULT '',
      submission_deadline TEXT DEFAULT '',
      accepted_at TEXT,
      declined_at TEXT,
      submitted_at TEXT,
      completed_at TEXT,
      conversion_status TEXT NOT NULL DEFAULT 'Pending',
      rework_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_planner_assignments (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      planner_id INTEGER NOT NULL REFERENCES users(id),
      assigned_by INTEGER NOT NULL REFERENCES users(id),
      assigned_locations TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Pending Acceptance',
      accepted_at TEXT,
      declined_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, planner_id)
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_files (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      storage_provider TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_status_history (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      remarks TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_declines (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      planner_id INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'task_update',
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_notifications_task ON notifications(task_id);

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned_by ON tasks(assigned_by);
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(submission_deadline);
    CREATE INDEX IF NOT EXISTS idx_task_planner_assignments_task ON task_planner_assignments(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_planner_assignments_planner ON task_planner_assignments(planner_id);
    CREATE INDEX IF NOT EXISTS idx_task_planner_assignments_status ON task_planner_assignments(status);
  `);
}

async function addColumnIfMissing(tableName, columnName, columnDefinition) {
  const row = await one(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tableName, columnName]
  );
  if (!row) {
    await query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}


async function ensureRoleConstraintSupportsPlanningLead() {
  const constraints = await many(`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%role%'
  `);

  for (const constraint of constraints) {
    await query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS ${constraint.conname}`);
  }

  await query(`
    ALTER TABLE users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'manager', 'planning_lead', 'planner'))
  `);
}

async function runMigrations() {
  await ensureRoleConstraintSupportsPlanningLead();
  const taskColumns = [
    ['direct_client_or_agency', "TEXT DEFAULT ''"],
    ['agency_name', "TEXT DEFAULT ''"],
    ['campaign_start_date', "TEXT DEFAULT ''"],
    ['campaign_duration', "TEXT DEFAULT ''"],
    ['campaign_budget', "TEXT DEFAULT ''"],
    ['display_cost_range', "TEXT DEFAULT ''"],
    ['target_areas', "TEXT DEFAULT ''"],
    ['target_audience_profile', "TEXT DEFAULT ''"],
    ['site_preferences', "TEXT DEFAULT ''"],
    ['ownership_type', "TEXT DEFAULT ''"],
    ['location_type', "TEXT DEFAULT ''"],
    ['size_preference', "TEXT DEFAULT ''"],
    ['additional_specifications', "TEXT DEFAULT ''"],
    ['plan_format', "TEXT DEFAULT ''"],
    ['submission_deadline', "TEXT DEFAULT ''"],
    ['accepted_at', 'TEXT'],
    ['declined_at', 'TEXT'],
    ['submitted_at', 'TEXT'],
    ['completed_at', 'TEXT'],
    ['conversion_status', "TEXT NOT NULL DEFAULT 'Pending'"],
    ['rework_count', 'INTEGER DEFAULT 0'],
    ['planning_lead_id', 'INTEGER REFERENCES users(id)']
  ];

  for (const [name, definition] of taskColumns) {
    await addColumnIfMissing('tasks', name, definition);
  }

  await addColumnIfMissing('users', 'verticals', "TEXT DEFAULT ''");
  await addColumnIfMissing('task_files', 'storage_provider', "TEXT NOT NULL DEFAULT 'local'");

  // Keep conversion values consistent even when an older preview/conversion
  // experiment previously created this column with different casing or labels.
  await query(`
    UPDATE tasks
    SET conversion_status = CASE
      WHEN LOWER(COALESCE(conversion_status, '')) IN ('won', 'plan converted', 'converted') THEN 'Won'
      WHEN LOWER(COALESCE(conversion_status, '')) IN ('loss', 'lost', 'plan not converted', 'not converted') THEN 'Loss'
      ELSE 'Pending'
    END
  `);
  await query(`ALTER TABLE tasks ALTER COLUMN conversion_status SET DEFAULT 'Pending'`);
  await query(`ALTER TABLE tasks ALTER COLUMN conversion_status SET NOT NULL`);

  // Preserve every existing single-planner task by creating one assignment row.
  // New tasks can then add more planners without breaking older records.
  await query(`
    INSERT INTO task_planner_assignments (
      task_id, planner_id, assigned_by, assigned_locations, status,
      accepted_at, declined_at, completed_at, created_at, updated_at
    )
    SELECT
      t.id,
      t.assigned_to,
      COALESCE(t.planning_lead_id, t.assigned_by),
      COALESCE(t.target_areas, ''),
      CASE
        WHEN t.status IN ('Pending Acceptance', 'Accepted', 'In Progress', 'Waiting for Details', 'Completed', 'Declined') THEN t.status
        WHEN t.status = 'Rework Required' THEN 'Pending Acceptance'
        ELSE 'In Progress'
      END,
      t.accepted_at,
      t.declined_at,
      t.completed_at,
      t.created_at,
      t.updated_at
    FROM tasks t
    JOIN users u ON u.id = t.assigned_to AND u.role = 'planner'
    ON CONFLICT (task_id, planner_id) DO NOTHING
  `);
}

async function insertUser({ name, email, password, role, department = 'Planning', phone = '', verticals = '' }) {
  const timestamp = now();
  const row = await one(
    `INSERT INTO users (name, email, password_hash, role, department, phone, verticals, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)
     RETURNING id`,
    [name, email.toLowerCase(), hashPassword(password), role, department, phone, verticals, timestamp, timestamp]
  );
  return row.id;
}

async function addHistory(taskId, userId, action, oldStatus, newStatus, remarks = '') {
  await query(
    `INSERT INTO task_status_history (task_id, user_id, action, old_status, new_status, remarks, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [taskId, userId, action, oldStatus, newStatus, remarks, now()]
  );
}

async function generateTaskCode(tx) {
  if (!tx?.query || !tx?.one) {
    throw new Error('generateTaskCode must be called inside a database transaction');
  }

  const d = new Date();
  const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const prefix = `PLN-${stamp}-`;

  // Lock task-code generation for this date until the task insert commits.
  // This prevents two simultaneous requests from receiving the same code.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`planning-task-code:${stamp}`]);

  // MAX is used instead of COUNT so deleted tasks or gaps cannot recreate an
  // already-used task code.
  const row = await tx.one(`
    SELECT COALESCE(MAX(
      CASE
        WHEN split_part(task_code, '-', 3) ~ '^[0-9]+$'
          THEN split_part(task_code, '-', 3)::integer
        ELSE 0
      END
    ), 0)::int AS max_number
    FROM tasks
    WHERE task_code LIKE $1
  `, [`${prefix}%`]);

  return `${prefix}${String((row?.max_number || 0) + 1).padStart(3, '0')}`;
}

async function ensureDefaultUser({ name, email, password, role, department = 'Planning', phone = '', verticals = '' }) {
  const existing = await one('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing) {
    // Never reactivate or overwrite an existing account during application startup.
    // Account status changes must remain under explicit Admin control.
    return existing.id;
  }
  return insertUser({ name, email, password, role, department, phone, verticals });
}

async function migrateDefaultBDUser() {
  const timestamp = now();
  const bdEmail = 'bd@adinn.co.in';
  const oldManagerEmail = 'manager@adinn.co.in';
  const bdUser = await one('SELECT * FROM users WHERE email = $1', [bdEmail]);
  const oldManager = await one('SELECT * FROM users WHERE email = $1', [oldManagerEmail]);

  if (bdUser) {
    // The migration has already been completed. Preserve the account exactly as
    // the Admin left it, including an inactive status.
    return bdUser.id;
  }

  if (oldManager) {
    await query(
      `UPDATE users
       SET name = $1, email = $2, password_hash = $3, role = 'manager', department = 'Planning', updated_at = $4
       WHERE id = $5`,
      ['Business Developer', bdEmail, hashPassword('BD@123'), timestamp, oldManager.id]
    );
    return oldManager.id;
  }

  return null;
}

async function seedDefaultUsers() {
  await ensureDefaultUser({
    name: 'ADINN Admin',
    email: 'admin@adinn.co.in',
    password: 'Admin@123',
    role: 'admin',
    department: 'Management'
  });

  const migratedBD = await migrateDefaultBDUser();
  if (!migratedBD) {
    await ensureDefaultUser({
      name: 'Business Developer',
      email: 'bd@adinn.co.in',
      password: 'BD@123',
      role: 'manager',
      department: 'Planning'
    });
  }

  await ensureDefaultUser({
    name: 'Planning Lead',
    email: 'lead@adinn.co.in',
    password: 'Lead@123',
    role: 'planning_lead',
    department: 'Planning',
    verticals: 'Outdoor,Roadshow'
  });

  await ensureDefaultUser({
    name: 'Senior Planner',
    email: 'planner@adinn.co.in',
    password: 'Planner@123',
    role: 'planner',
    department: 'Planning',
    verticals: 'Outdoor,Roadshow'
  });

  await ensureDefaultUser({
    name: 'Campaign Planner',
    email: 'planner2@adinn.co.in',
    password: 'Planner@123',
    role: 'planner',
    department: 'Planning',
    verticals: 'Outdoor,Roadshow'
  });
}

async function initDb() {
  if (!connectionString) {
    throw new Error('DATABASE_URL is missing. Create a PostgreSQL database and add DATABASE_URL in backend/.env or Render environment variables.');
  }
  await createSchema();
  await runMigrations();
  await seedDefaultUsers();
}

module.exports = {
  pool,
  query,
  one,
  many,
  exec,
  withTransaction,
  initDb,
  now,
  hashPassword,
  addHistory,
  generateTaskCode
};
