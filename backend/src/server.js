const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const {
  initDb,
  now,
  hashPassword,
  addHistory,
  generateTaskCode,
  one,
  many,
  query,
  withTransaction
} = require('./database');

const app = express();
const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-change-me';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_SECRET_KEY = String(
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
).trim();
const SUPABASE_STORAGE_BUCKET = String(
  process.env.SUPABASE_STORAGE_BUCKET || 'planning-task-attachments'
).trim();
const SUPABASE_SIGNED_URL_SECONDS = Math.min(
  Math.max(Number(process.env.SUPABASE_SIGNED_URL_SECONDS) || 3600, 60),
  86400
);
const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const supabase = SUPABASE_URL && SUPABASE_SECRET_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    })
  : null;

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 10
  }
});

function requestFiles(req) {
  if (Array.isArray(req.files)) return req.files;
  return [
    ...(req.files?.files || []),
    ...(req.files?.file || [])
  ];
}

async function removeLocalUpload(filePath) {
  if (!filePath) return;
  const filename = path.basename(filePath);
  const absolutePath = path.join(uploadDir, filename);
  try {
    await fs.promises.unlink(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Unable to remove uploaded file ${absolutePath}`, error);
  }
}

function storageBucket() {
  if (!supabase) {
    throw new Error(
      'Supabase Storage is not configured. Add SUPABASE_URL and SUPABASE_SECRET_KEY to the backend environment.'
    );
  }
  return supabase.storage.from(SUPABASE_STORAGE_BUCKET);
}

function safeStorageFileName(originalName) {
  const extension = path.extname(originalName || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 20);
  const baseName = path.basename(originalName || 'file', path.extname(originalName || ''))
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100) || 'file';
  return `${baseName}${extension}`;
}

function storageObjectPath(taskId, originalName) {
  return `tasks/${taskId}/${Date.now()}-${crypto.randomUUID()}-${safeStorageFileName(originalName)}`;
}

async function uploadSupabaseFile(taskId, file) {
  const objectPath = storageObjectPath(taskId, file.originalname);
  const fileBody = await fs.promises.readFile(file.path);
  const { error } = await storageBucket().upload(objectPath, fileBody, {
    contentType: file.mimetype || 'application/octet-stream',
    cacheControl: '3600',
    upsert: false
  });
  if (error) throw new Error(`Unable to upload ${file.originalname}: ${error.message}`);
  return objectPath;
}

async function createSupabaseDownloadUrl(file) {
  const { data, error } = await storageBucket().createSignedUrl(
    file.file_path,
    SUPABASE_SIGNED_URL_SECONDS,
    { download: file.file_name }
  );
  if (error || !data?.signedUrl) {
    throw new Error(`Unable to create download link for ${file.file_name}: ${error?.message || 'Unknown storage error'}`);
  }
  return data.signedUrl;
}

async function createSupabasePreviewUrl(file) {
  const { data, error } = await storageBucket().createSignedUrl(
    file.file_path,
    SUPABASE_SIGNED_URL_SECONDS
  );
  if (error || !data?.signedUrl) {
    throw new Error(`Unable to create preview link for ${file.file_name}: ${error?.message || 'Unknown storage error'}`);
  }
  return data.signedUrl;
}

function localStoredFilePath(file) {
  return path.join(uploadDir, path.basename(file.file_path || ''));
}

async function attachmentResponse(file) {
  const extension = path.extname(file.file_name || '').toLowerCase();
  const previewKind = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(extension)
    ? 'image'
    : extension === '.pdf'
      ? 'pdf'
      : ['.xls', '.xlsx', '.csv'].includes(extension)
        ? 'spreadsheet'
        : ['.ppt', '.pptx'].includes(extension)
          ? 'presentation'
          : 'browser';

  if (file.storage_provider === 'supabase') {
    try {
      const [downloadUrl, previewUrl] = await Promise.all([
        createSupabaseDownloadUrl(file),
        createSupabasePreviewUrl(file)
      ]);
      return {
        ...file,
        available: true,
        preview_kind: previewKind,
        preview_url: previewUrl,
        download_url: downloadUrl,
        url: downloadUrl
      };
    } catch (error) {
      console.error(`Unable to prepare Supabase attachment ${file.id}`, error);
      return {
        ...file,
        available: false,
        preview_kind: previewKind,
        preview_url: null,
        download_url: null,
        url: null,
        unavailable_reason: 'Stored file is unavailable. Please re-upload it.'
      };
    }
  }

  const exists = Boolean(file.file_path) && fs.existsSync(localStoredFilePath(file));
  const localUrl = exists ? `/uploads/${path.basename(file.file_path)}` : null;
  return {
    ...file,
    available: exists,
    preview_kind: previewKind,
    preview_url: localUrl,
    download_url: localUrl,
    url: localUrl,
    unavailable_reason: exists ? null : 'Old Render file is unavailable. Please re-upload it.'
  };
}

async function removeSupabaseObjects(paths, throwOnError = true) {
  const uniquePaths = [...new Set((paths || []).filter(Boolean))];
  if (uniquePaths.length === 0) return;
  const { error } = await storageBucket().remove(uniquePaths);
  if (error) {
    if (throwOnError) throw new Error(`Unable to delete stored file: ${error.message}`);
    console.error('Unable to clean up Supabase Storage objects', error);
  }
}

async function removeStoredFile(file, throwOnError = true) {
  if (!file) return;
  if (file.storage_provider === 'supabase') {
    await removeSupabaseObjects([file.file_path], throwOnError);
    return;
  }
  await removeLocalUpload(file.file_path);
}

async function removeStoredFilesBestEffort(files) {
  const supabasePaths = (files || [])
    .filter(file => file.storage_provider === 'supabase')
    .map(file => file.file_path);
  await removeSupabaseObjects(supabasePaths, false);
  await Promise.all(
    (files || [])
      .filter(file => file.storage_provider !== 'supabase')
      .map(file => removeLocalUpload(file.file_path))
  );
}

async function validateSupabaseStorage() {
  if (!supabase) {
    throw new Error(
      'Supabase Storage is not configured. Add SUPABASE_URL and SUPABASE_SECRET_KEY to Render before deploying.'
    );
  }
  const { data, error } = await supabase.storage.getBucket(SUPABASE_STORAGE_BUCKET);
  if (error || !data) {
    throw new Error(
      `Supabase Storage bucket "${SUPABASE_STORAGE_BUCKET}" is unavailable. Create it as a private bucket and verify the backend secret key.`
    );
  }
}

const STATUSES = [
  'Pending Lead Assignment',
  'Pending Acceptance',
  'Accepted',
  'In Progress',
  'Waiting for Details',
  'Submitted for Review',
  'Rework Required',
  'Completed',
  'Declined',
  'Cancelled'
];

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    role_label: row.role === 'manager' ? 'BD' : (row.role === 'planning_lead' ? 'Planning Lead' : (row.role === 'admin' ? 'Admin' : 'Planner')),
    department: row.department,
    phone: row.phone,
    verticals: row.verticals || '',
    status: row.status,
    created_at: row.created_at
  };
}

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ message: 'Missing authorization token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await one('SELECT * FROM users WHERE id = $1', [payload.id]);
    if (!user || user.status !== 'active') return res.status(401).json({ message: 'User is not active' });
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ message: 'You do not have access to this action' });
    next();
  };
}

function canViewTask(user, task) {
  if (!task) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'manager') return Number(task.assigned_by) === Number(user.id);
  if (user.role === 'planning_lead') {
    return Number(task.planning_lead_id) === Number(user.id)
      || Number(task.assigned_to) === Number(user.id)
      || Number(task.assigned_by) === Number(user.id);
  }
  if (user.role === 'planner') {
    return (task.planner_ids || []).map(Number).includes(Number(user.id))
      || Number(task.assigned_to) === Number(user.id);
  }
  return false;
}

async function fetchTask(id) {
  return one(`
    SELECT t.*,
      assigner.name AS assigned_by_name,
      assigner.email AS assigned_by_email,
      assigner.role AS assigned_by_role,
      planner.name AS assigned_to_name,
      planner.email AS assigned_to_email,
      planner.role AS assigned_to_role,
      lead.name AS planning_lead_name,
      lead.email AS planning_lead_email,
      ARRAY(
        SELECT a.planner_id
        FROM task_planner_assignments a
        WHERE a.task_id = t.id
        ORDER BY a.id
      ) AS planner_ids,
      COALESCE((
        SELECT string_agg(u.name, ', ' ORDER BY a.id)
        FROM task_planner_assignments a
        JOIN users u ON u.id = a.planner_id
        WHERE a.task_id = t.id
      ), '') AS assigned_planner_names,
      (SELECT COUNT(*)::int FROM task_planner_assignments a WHERE a.task_id = t.id) AS planner_count,
      (SELECT COUNT(*)::int FROM task_planner_assignments a WHERE a.task_id = t.id AND a.status = 'Completed') AS planner_completed_count,
      COALESCE((
        SELECT json_agg(json_build_object(
          'planner_id', a.planner_id,
          'status', a.status,
          'assigned_locations', a.assigned_locations
        ) ORDER BY a.id)
        FROM task_planner_assignments a
        WHERE a.task_id = t.id
      ), '[]'::json) AS planner_assignments_summary
    FROM tasks t
    JOIN users assigner ON assigner.id = t.assigned_by
    JOIN users planner ON planner.id = t.assigned_to
    LEFT JOIN users lead ON lead.id = t.planning_lead_id
    WHERE t.id = $1
  `, [id]);
}

async function addComment(taskId, userId, comment) {
  if (!comment || !comment.trim()) return;
  await query(
    'INSERT INTO task_comments (task_id, user_id, comment, created_at) VALUES ($1, $2, $3, $4)',
    [taskId, userId, comment.trim(), now()]
  );
}

function uniqueIds(ids = []) {
  return Array.from(new Set(ids.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0)));
}

function taskDisplayName(task) {
  if (!task) return 'Planning task';
  return task.brand_name || task.title || task.task_code || 'Planning task';
}

async function createNotification(userId, taskId, title, message, type = 'task_update') {
  if (!userId) return;
  await query(
    `INSERT INTO notifications (user_id, task_id, title, message, type, is_read, created_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, $6)`,
    [userId, taskId || null, title, message, type, now()]
  );
}

async function notifyUsers(userIds, taskId, title, message, type = 'task_update', excludeUserId = null) {
  const recipients = uniqueIds(userIds).filter(id => id !== Number(excludeUserId));
  for (const userId of recipients) {
    await createNotification(userId, taskId, title, message, type);
  }
}

function taskParticipantIds(task) {
  return uniqueIds([
    task?.assigned_by,
    task?.planning_lead_id,
    task?.assigned_to,
    ...(Array.isArray(task?.planner_ids) ? task.planner_ids : [])
  ]);
}

async function fetchPlannerAssignments(taskId) {
  return many(`
    SELECT a.*, u.name AS planner_name, u.email AS planner_email, u.verticals AS planner_verticals
    FROM task_planner_assignments a
    JOIN users u ON u.id = a.planner_id
    WHERE a.task_id = $1
    ORDER BY a.id
  `, [taskId]);
}

function overallTaskStatus(assignments) {
  if (!assignments.length) return 'Pending Lead Assignment';
  const states = assignments.map(item => item.status);
  if (states.every(status => status === 'Completed')) return 'Completed';
  if (states.every(status => status === 'Declined')) return 'Declined';
  if (states.some(status => status === 'Waiting for Details')) return 'Waiting for Details';
  if (states.some(status => status === 'In Progress' || status === 'Completed')) return 'In Progress';
  if (states.some(status => status === 'Accepted')) return 'Accepted';
  return 'Pending Acceptance';
}

async function syncTaskFromPlannerAssignments(taskId, tx = null) {
  const db = tx || { one, many, query };
  const assignments = await db.many(`
    SELECT * FROM task_planner_assignments
    WHERE task_id = $1
    ORDER BY id
  `, [taskId]);
  const task = await db.one('SELECT * FROM tasks WHERE id = $1', [taskId]);
  if (!task) return null;

  const nextStatus = overallTaskStatus(assignments);
  const firstPlannerId = assignments[0]?.planner_id || task.planning_lead_id || task.assigned_to;
  const timestamp = now();
  await db.query(`
    UPDATE tasks
    SET assigned_to = $1,
        status = $2,
        accepted_at = CASE WHEN $2 IN ('Accepted', 'In Progress', 'Waiting for Details', 'Completed') THEN COALESCE(accepted_at, $3) ELSE accepted_at END,
        declined_at = CASE WHEN $2 = 'Declined' THEN $3 ELSE NULL END,
        completed_at = CASE WHEN $2 = 'Completed' THEN $3 ELSE NULL END,
        updated_at = $3
    WHERE id = $4
  `, [firstPlannerId, nextStatus, timestamp, taskId]);
  return { oldStatus: task.status, newStatus: nextStatus, assignments };
}

function normalizePlannerAssignments(input) {
  const raw = Array.isArray(input) ? input : [];
  const seen = new Set();
  const normalized = [];
  for (const item of raw) {
    const plannerId = Number(item?.planner_id ?? item?.id);
    if (!Number.isInteger(plannerId) || plannerId <= 0 || seen.has(plannerId)) continue;
    seen.add(plannerId);
    normalized.push({
      planner_id: plannerId,
      assigned_locations: text(item?.assigned_locations || item?.locations)
    });
  }
  return normalized;
}

const REPORT_TIME_ZONE = String(process.env.REPORT_TIME_ZONE || 'Asia/Kolkata').trim() || 'Asia/Kolkata';

function reportDateTimeParts(value) {
  if (!value) return { date: null, time: null };
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return { date: null, time: null };

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(instant);
  const part = type => Number(parts.find(item => item.type === type)?.value || 0);
  const year = part('year');
  const month = part('month');
  const day = part('day');
  const hour = part('hour');
  const minute = part('minute');
  const second = part('second');

  return {
    date: new Date(Date.UTC(year, month - 1, day)),
    time: (hour * 3600 + minute * 60 + second) / 86400
  };
}

function reportDurationDays(startValue, endValue) {
  if (!startValue || !endValue) return null;
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  return (end.getTime() - start.getTime()) / 86400000;
}

function reportConversionStatus(value) {
  if (value === 'Won') return 'Won';
  if (value === 'Loss') return 'Loss';
  return 'Pending';
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function buildTaskTitle(body) {
  const explicitTitle = text(body.title);
  if (explicitTitle) return explicitTitle;
  const brand = text(body.brand_name);
  if (brand) return `Planning Request - ${brand}`;
  const clientType = text(body.direct_client_or_agency);
  const planFormat = text(body.plan_format);
  if (clientType || planFormat) return `${[clientType, planFormat].filter(Boolean).join(' ')} Planning Request`;
  return 'Planning Request';
}

function buildClientName(body) {
  const clientName = text(body.client_name);
  if (clientName) return clientName;
  const clientType = text(body.direct_client_or_agency);
  const agencyName = text(body.agency_name);
  if (clientType === 'Ad Agency' && agencyName && agencyName.toLowerCase() !== 'na') return agencyName;
  return clientType || agencyName || '';
}

function buildDeliverable(body) {
  const deliverable = text(body.deliverable);
  if (deliverable) return deliverable;
  const planFormat = text(body.plan_format);
  return planFormat ? `${planFormat} plan` : '';
}

function buildDescription(body) {
  const description = text(body.description);
  if (description) return description;
  return text(body.additional_specifications);
}

function deadlineDateExpression(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `CAST(COALESCE(NULLIF(${prefix}submission_deadline, ''), NULLIF(${prefix}due_date, '')) AS DATE)`;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'ADINN Planning Task Manager', database: 'postgresql', time: now() });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'ADINN Planning Task Manager', database: 'postgresql', time: now() });
});

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await one('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase()]);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }
  if (user.status !== 'active') return res.status(403).json({ message: 'This account is inactive' });
  res.json({ token: signToken(user), user: publicUser(user) });
}));

app.get('/api/auth/me', requireAuth, asyncHandler(async (req, res) => {
  res.json({ user: publicUser(req.user) });
}));

app.get('/api/notifications', requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 40), 1), 500);
  const notifications = await many(`
    SELECT n.*, t.task_code, t.brand_name, t.title AS task_title, t.status AS task_status
    FROM notifications n
    LEFT JOIN tasks t ON t.id = n.task_id
    WHERE n.user_id = $1
    ORDER BY n.created_at DESC
    LIMIT $2
  `, [req.user.id, limit]);
  const unread = await one('SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE', [req.user.id]);
  res.json({ notifications, unread_count: unread?.count || 0 });
}));

app.patch('/api/notifications/:id/read', requireAuth, asyncHandler(async (req, res) => {
  await query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [Number(req.params.id), req.user.id]);
  res.json({ message: 'Notification marked as read' });
}));

app.patch('/api/notifications/read-all', requireAuth, asyncHandler(async (req, res) => {
  await query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE', [req.user.id]);
  res.json({ message: 'Notifications marked as read' });
}));

app.get('/api/users', requireAuth, asyncHandler(async (req, res) => {
  const { role, status = 'active' } = req.query;
  const values = [];
  const where = [];

  if (role) {
    values.push(role);
    where.push(`role = $${values.length}`);
  }
  if (status !== 'all') {
    values.push(status);
    where.push(`status = $${values.length}`);
  }

  if (req.user.role === 'planner') {
    values.push(req.user.id);
    where.push(`(role IN ('manager', 'planning_lead', 'admin') OR id = $${values.length})`);
  }

  const rows = await many(`SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY role, name`, values);
  res.json({ users: rows.map(publicUser) });
}));

app.post('/api/users', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { name, email, password, role, department, phone, verticals } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ message: 'Name, email, password and role are required' });
  if (!['admin', 'manager', 'planning_lead', 'planner'].includes(role)) return res.status(400).json({ message: 'Invalid role' });

  try {
    const timestamp = now();
    const created = await one(`
      INSERT INTO users (name, email, password_hash, role, department, phone, verticals, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)
      RETURNING *
    `, [name.trim(), email.toLowerCase().trim(), hashPassword(password), role, department || 'Planning', phone || '', verticals || '', timestamp, timestamp]);
    res.status(201).json({ user: publicUser(created) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'Email already exists' });
    throw error;
  }
}));

app.patch('/api/users/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await one('SELECT * FROM users WHERE id = $1', [id]);
  if (!existing) return res.status(404).json({ message: 'User not found' });
  const next = {
    name: req.body.name ?? existing.name,
    email: req.body.email ? String(req.body.email).toLowerCase().trim() : existing.email,
    role: req.body.role ?? existing.role,
    department: req.body.department ?? existing.department,
    phone: req.body.phone ?? existing.phone,
    verticals: req.body.verticals ?? existing.verticals ?? '',
    status: req.body.status ?? existing.status
  };
  if (!['admin', 'manager', 'planning_lead', 'planner'].includes(next.role)) return res.status(400).json({ message: 'Invalid role' });
  if (!['active', 'inactive'].includes(next.status)) return res.status(400).json({ message: 'Invalid status' });

  // Safety rule: Admin accounts are permanent system users.
  // They cannot be deactivated, deleted, or converted to another role by mistake.
  if (existing.role === 'admin') {
    if (next.status !== 'active') return res.status(400).json({ message: 'Admin accounts cannot be deactivated' });
    if (next.role !== 'admin') return res.status(400).json({ message: 'Admin role cannot be changed' });
  }

  await query(
    `UPDATE users SET name = $1, email = $2, role = $3, department = $4, phone = $5, verticals = $6, status = $7, updated_at = $8 WHERE id = $9`,
    [next.name, next.email, next.role, next.department, next.phone, next.verticals, next.status, now(), id]
  );
  if (req.body.password) {
    await query('UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3', [hashPassword(req.body.password), now(), id]);
  }
  const user = await one('SELECT * FROM users WHERE id = $1', [id]);
  res.json({ user: publicUser(user) });
}));

app.delete('/api/users/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ message: 'Admin cannot delete their own account' });
  const existing = await one('SELECT * FROM users WHERE id = $1', [id]);
  if (!existing) return res.status(404).json({ message: 'User not found' });
  if (existing.role === 'admin') return res.status(400).json({ message: 'Admin accounts cannot be deleted' });

  const storedFiles = await many(`
    SELECT DISTINCT f.*
    FROM task_files f
    LEFT JOIN tasks t ON t.id = f.task_id
    WHERE f.user_id = $1 OR t.assigned_by = $1 OR t.assigned_to = $1 OR t.planning_lead_id = $1
  `, [id]);

  await withTransaction(async (tx) => {
    const linkedTasks = await tx.many('SELECT id FROM tasks WHERE assigned_by = $1 OR assigned_to = $1 OR planning_lead_id = $1', [id]);
    for (const task of linkedTasks) {
      await tx.query('DELETE FROM tasks WHERE id = $1', [task.id]);
    }
    await tx.query('DELETE FROM task_planner_assignments WHERE planner_id = $1 OR assigned_by = $1', [id]);
    await tx.query('DELETE FROM task_comments WHERE user_id = $1', [id]);
    await tx.query('DELETE FROM task_files WHERE user_id = $1', [id]);
    await tx.query('DELETE FROM task_status_history WHERE user_id = $1', [id]);
    await tx.query('DELETE FROM task_declines WHERE planner_id = $1', [id]);
    await tx.query('DELETE FROM users WHERE id = $1', [id]);
  });

  await removeStoredFilesBestEffort(storedFiles);
  res.json({ message: 'User deleted successfully' });
}));

app.get('/api/tasks', requireAuth, asyncHandler(async (req, res) => {
  const values = [];
  const where = [];
  const { status, priority, assigned_to, assigned_by, search, from, to, category, campaign_type, plan_format, view, scope } = req.query;

  function addWhere(sqlPart, value) {
    values.push(value);
    where.push(sqlPart.replace('?', `$${values.length}`));
  }

  if (req.user.role === 'manager') addWhere('t.assigned_by = ?', req.user.id);
  if (req.user.role === 'planning_lead') {
    values.push(req.user.id);
    const idx = values.length;
    where.push(`(t.planning_lead_id = $${idx} OR t.assigned_to = $${idx} OR t.assigned_by = $${idx})`);
  }
  // Planners can browse company-wide task summaries. Dashboard and other
  // personal views can explicitly request only their assigned records.
  if (req.user.role === 'planner' && scope === 'assigned') {
    values.push(req.user.id);
    where.push(`EXISTS (SELECT 1 FROM task_planner_assignments a WHERE a.task_id = t.id AND a.planner_id = $${values.length})`);
  }
  if (view === 'completed') {
    if (req.user.role === 'planner') {
      values.push(req.user.id);
      where.push(`EXISTS (
        SELECT 1
        FROM task_planner_assignments a
        WHERE a.task_id = t.id
          AND a.planner_id = $${values.length}
          AND a.status = 'Completed'
      )`);
    } else {
      where.push("t.status = 'Completed'");
    }
  }
  if (view === 'active') {
    if (req.user.role === 'planner') {
      values.push(req.user.id);
      where.push(`NOT EXISTS (
        SELECT 1
        FROM task_planner_assignments a
        WHERE a.task_id = t.id
          AND a.planner_id = $${values.length}
          AND a.status = 'Completed'
      )`);
    } else {
      where.push("t.status <> 'Completed'");
    }
  }
  if (status && status !== 'all') addWhere('t.status = ?', status);
  if (priority && priority !== 'all') addWhere('t.priority = ?', priority);
  if (assigned_to && assigned_to !== 'all') {
    values.push(Number(assigned_to));
    where.push(`EXISTS (SELECT 1 FROM task_planner_assignments a WHERE a.task_id = t.id AND a.planner_id = $${values.length})`);
  }
  if (assigned_by && assigned_by !== 'all') addWhere('t.assigned_by = ?', Number(assigned_by));
  if (category && category !== 'all') addWhere('t.category = ?', category);
  if (campaign_type && campaign_type !== 'all') addWhere('t.campaign_type = ?', campaign_type);
  if (plan_format && plan_format !== 'all') addWhere('t.plan_format = ?', plan_format);
  if (from) addWhere(`${deadlineDateExpression('t')} >= CAST(? AS DATE)`, from);
  if (to) addWhere(`${deadlineDateExpression('t')} <= CAST(? AS DATE)`, to);
  if (search) {
    const s = `%${search}%`;
    const fields = [
      't.task_code', 't.title', 't.client_name', 't.brand_name', 't.direct_client_or_agency',
      't.agency_name', 't.campaign_type', 't.category', 't.plan_format', 't.target_areas',
      't.target_audience_profile', 't.site_preferences', 't.additional_specifications'
    ];
    const clauses = [];
    for (const field of fields) {
      values.push(s);
      clauses.push(`${field} ILIKE $${values.length}`);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }

  let orderSql;
  if (view === 'completed' && req.user.role === 'planner') {
    values.push(req.user.id);
    orderSql = `COALESCE((
      SELECT a.completed_at
      FROM task_planner_assignments a
      WHERE a.task_id = t.id AND a.planner_id = $${values.length}
      LIMIT 1
    ), t.completed_at, t.updated_at, t.created_at) DESC, t.id DESC`;
  } else if (view === 'completed') {
    orderSql = 'COALESCE(t.completed_at, t.updated_at, t.created_at) DESC, t.id DESC';
  } else {
    orderSql = `CASE t.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
      ${deadlineDateExpression('t')} ASC NULLS LAST,
      t.created_at DESC`;
  }

  const tasks = await many(`
    SELECT t.*,
      assigner.name AS assigned_by_name,
      assigner.role AS assigned_by_role,
      planner.name AS assigned_to_name,
      planner.role AS assigned_to_role,
      lead.name AS planning_lead_name,
      ARRAY(
        SELECT a.planner_id
        FROM task_planner_assignments a
        WHERE a.task_id = t.id
        ORDER BY a.id
      ) AS planner_ids,
      COALESCE((
        SELECT string_agg(u.name, ', ' ORDER BY a.id)
        FROM task_planner_assignments a
        JOIN users u ON u.id = a.planner_id
        WHERE a.task_id = t.id
      ), '') AS assigned_planner_names,
      (SELECT COUNT(*)::int FROM task_planner_assignments a WHERE a.task_id = t.id) AS planner_count,
      (SELECT COUNT(*)::int FROM task_planner_assignments a WHERE a.task_id = t.id AND a.status = 'Completed') AS planner_completed_count,
      COALESCE((
        SELECT json_agg(json_build_object(
          'planner_id', a.planner_id,
          'status', a.status,
          'assigned_locations', a.assigned_locations
        ) ORDER BY a.id)
        FROM task_planner_assignments a
        WHERE a.task_id = t.id
      ), '[]'::json) AS planner_assignments_summary
    FROM tasks t
    JOIN users assigner ON assigner.id = t.assigned_by
    JOIN users planner ON planner.id = t.assigned_to
    LEFT JOIN users lead ON lead.id = t.planning_lead_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${orderSql}
  `, values);
  const visibleTasks = req.user.role === 'planner'
    ? tasks.map(task => {
        const plannerIds = (task.planner_ids || []).map(Number);
        const ownAssignment = (task.planner_assignments_summary || []).find(item => Number(item.planner_id) === Number(req.user.id));
        if (plannerIds.includes(Number(req.user.id)) || Number(task.assigned_to) === Number(req.user.id)) {
          return {
            ...task,
            is_summary_only: false,
            is_my_assignment: true,
            my_assignment_status: ownAssignment?.status || task.status,
            my_assigned_locations: ownAssignment?.assigned_locations || ''
          };
        }
        return {
          id: task.id,
          task_code: task.task_code,
          title: task.title,
          brand_name: task.brand_name,
          direct_client_or_agency: task.direct_client_or_agency,
          agency_name: task.agency_name,
          target_areas: task.target_areas,
          assigned_by: task.assigned_by,
          assigned_by_name: task.assigned_by_name,
          assigned_by_role: task.assigned_by_role,
          assigned_to: task.assigned_to,
          assigned_to_name: task.assigned_to_name,
          assigned_to_role: task.assigned_to_role,
          planning_lead_id: task.planning_lead_id,
          planning_lead_name: task.planning_lead_name,
          planner_ids: task.planner_ids,
          assigned_planner_names: task.assigned_planner_names,
          planner_count: task.planner_count,
          planner_completed_count: task.planner_completed_count,
          planner_assignments_summary: task.planner_assignments_summary,
          due_date: task.due_date,
          submission_deadline: task.submission_deadline,
          priority: task.priority,
          status: task.status,
          created_at: task.created_at,
          is_summary_only: true
        };
      })
    : tasks;
  res.json({ tasks: visibleTasks });
}));

app.post('/api/tasks', requireAuth, requireRole('admin', 'manager', 'planning_lead'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!body.assigned_to) {
    return res.status(400).json({ message: 'Planning Lead is required to assign this task' });
  }

  const leadId = Number(body.assigned_to);
  const lead = await one("SELECT * FROM users WHERE id = $1 AND role = 'planning_lead' AND status = 'active'", [leadId]);
  if (!lead) return res.status(400).json({ message: 'Assigned Planning Lead is not active or does not exist' });

  const isLeadCreator = req.user.role === 'planning_lead';
  const requestedAssignments = isLeadCreator
    ? normalizePlannerAssignments(body.planner_assignments || (body.planner_id ? [{ planner_id: body.planner_id, assigned_locations: body.target_areas }] : []))
    : [];
  let selectedPlanners = [];
  if (isLeadCreator) {
    if (requestedAssignments.length === 0) {
      return res.status(400).json({ message: 'Select at least one Planner when a Planning Lead creates a task' });
    }
    selectedPlanners = await many(
      "SELECT * FROM users WHERE id = ANY($1::int[]) AND role = 'planner' AND status = 'active'",
      [requestedAssignments.map(item => item.planner_id)]
    );
    if (selectedPlanners.length !== requestedAssignments.length) {
      return res.status(400).json({ message: 'One or more selected Planners are inactive or do not exist' });
    }
  }

  const allowedPlanningOptions = ['Outdoor', 'Roadshow', ''];
  const allowedPlanFormats = ['Customized PPT', 'Normal PPT', ''];
  const allowedPriorities = ['Low', 'Medium', 'High', 'Urgent'];
  if (!allowedPlanningOptions.includes(text(body.campaign_type || ''))) return res.status(400).json({ message: 'Planning option must be Outdoor or Roadshow' });
  if (!allowedPlanFormats.includes(text(body.plan_format || ''))) return res.status(400).json({ message: 'Plan required must be Customized PPT or Normal PPT' });
  if (!allowedPriorities.includes(text(body.priority || 'Medium'))) return res.status(400).json({ message: 'Invalid priority' });

  const timestamp = now();
  const campaignStartDate = text(body.campaign_start_date || body.start_date);
  const submissionDeadline = text(body.submission_deadline || body.plan_submission_deadline || body.due_date);
  const title = buildTaskTitle(body);
  const clientName = buildClientName(body);
  const additionalSpecifications = text(body.additional_specifications);
  const planFormat = text(body.plan_format);
  const initialStatus = isLeadCreator ? 'Pending Acceptance' : 'Pending Lead Assignment';
  const initialAssigneeId = isLeadCreator ? requestedAssignments[0].planner_id : lead.id;

  const created = await withTransaction(async (tx) => {
    const taskCode = await generateTaskCode(tx);
    const taskRow = await tx.one(`
      INSERT INTO tasks (
        task_code, title, client_name, brand_name, direct_client_or_agency, agency_name,
        campaign_name, campaign_type, city, state, category, deliverable, description, priority,
        status, assigned_by, assigned_to, planning_lead_id, start_date, due_date, campaign_start_date,
        campaign_duration, campaign_budget, display_cost_range, target_areas,
        target_audience_profile, site_preferences, ownership_type, location_type, size_preference,
        additional_specifications, plan_format, submission_deadline, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35)
      RETURNING id
    `, [
      taskCode,
      title,
      clientName,
      text(body.brand_name),
      text(body.direct_client_or_agency),
      text(body.agency_name),
      text(body.campaign_name || body.brand_name),
      text(body.campaign_type || ''),
      text(body.city),
      text(body.state || 'Tamil Nadu'),
      text(body.category || 'Campaign Plan'),
      buildDeliverable(body),
      buildDescription(body),
      text(body.priority || 'Medium') || 'Medium',
      initialStatus,
      req.user.id,
      initialAssigneeId,
      lead.id,
      campaignStartDate,
      submissionDeadline,
      campaignStartDate,
      text(body.campaign_duration),
      text(body.campaign_budget),
      text(body.display_cost_range),
      text(body.target_areas),
      text(body.target_audience_profile),
      text(body.site_preferences),
      text(body.ownership_type),
      text(body.location_type),
      text(body.size_preference),
      additionalSpecifications,
      planFormat,
      submissionDeadline,
      timestamp,
      timestamp
    ]);

    if (isLeadCreator) {
      for (const assignment of requestedAssignments) {
        await tx.query(`
          INSERT INTO task_planner_assignments (
            task_id, planner_id, assigned_by, assigned_locations, status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, 'Pending Acceptance', $5, $6)
        `, [taskRow.id, assignment.planner_id, req.user.id, assignment.assigned_locations, timestamp, timestamp]);
      }
    }
    return taskRow;
  });

  if (isLeadCreator) {
    const plannerById = new Map(selectedPlanners.map(item => [Number(item.id), item]));
    const assignmentSummary = requestedAssignments.map(item => {
      const plannerName = plannerById.get(Number(item.planner_id))?.name || `Planner #${item.planner_id}`;
      return item.assigned_locations ? `${plannerName}: ${item.assigned_locations}` : plannerName;
    });
    const remarks = `Planning Lead: ${lead.name}; Planners: ${assignmentSummary.join(' | ')}`;
    await addHistory(created.id, req.user.id, 'Task created and assigned to multiple Planners', null, 'Pending Acceptance', remarks);
    await addComment(created.id, req.user.id, `Task request created with Planning Lead ${lead.name}. Planner allocation: ${assignmentSummary.join(' | ')}.`);
    await notifyUsers(
      [lead.id],
      created.id,
      'New task assigned to Planning Lead',
      `${req.user.name} selected you as Planning Lead for ${taskDisplayName({ brand_name: text(body.brand_name), title })}.`,
      'task_assigned_to_lead',
      req.user.id
    );
    for (const assignment of requestedAssignments) {
      const planner = plannerById.get(Number(assignment.planner_id));
      await notifyUsers(
        [assignment.planner_id],
        created.id,
        'New task assigned to Planner',
        `${req.user.name} assigned ${taskDisplayName({ brand_name: text(body.brand_name), title })} to you for acceptance.${assignment.assigned_locations ? ` Your locations: ${assignment.assigned_locations}` : ''}`,
        'task_assigned_to_planner',
        req.user.id
      );
    }
  } else {
    await addHistory(created.id, req.user.id, 'Task assigned to Planning Lead', null, 'Pending Lead Assignment', `Assigned to Planning Lead ${lead.name}`);
    await addComment(created.id, req.user.id, `Task request created and assigned to Planning Lead ${lead.name}.`);
    await notifyUsers(
      [lead.id],
      created.id,
      'New task assigned to Planning Lead',
      `${req.user.name} assigned ${taskDisplayName({ brand_name: text(body.brand_name), title })} to you.`,
      'task_assigned_to_lead',
      req.user.id
    );
  }

  res.status(201).json({ task: await fetchTask(created.id) });
}));

app.get('/api/tasks/:id', requireAuth, asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.id));
  if (!canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });
  const comments = await many(`
    SELECT c.*, u.name, u.role FROM task_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.task_id = $1 ORDER BY c.created_at ASC
  `, [task.id]);
  const fileRows = await many(`
    SELECT f.*, u.name FROM task_files f
    JOIN users u ON u.id = f.user_id
    WHERE f.task_id = $1 ORDER BY f.created_at DESC
  `, [task.id]);
  const files = await Promise.all(fileRows.map(attachmentResponse));
  const history = await many(`
    SELECT h.*, u.name FROM task_status_history h
    JOIN users u ON u.id = h.user_id
    WHERE h.task_id = $1 ORDER BY h.created_at DESC
  `, [task.id]);
  const declines = await many(`
    SELECT d.*, u.name FROM task_declines d
    JOIN users u ON u.id = d.planner_id
    WHERE d.task_id = $1 ORDER BY d.created_at DESC
  `, [task.id]);
  const plannerAssignments = await fetchPlannerAssignments(task.id);
  const myAssignment = req.user.role === 'planner'
    ? plannerAssignments.find(item => Number(item.planner_id) === Number(req.user.id)) || null
    : null;
  res.json({ task, comments, files, history, declines, planner_assignments: plannerAssignments, my_assignment: myAssignment });
}));

app.post('/api/tasks/:id/comments', requireAuth, asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.id));
  if (!canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });
  if (!req.body.comment || !req.body.comment.trim()) return res.status(400).json({ message: 'Comment is required' });
  await addComment(task.id, req.user.id, req.body.comment);
  await notifyUsers(
    taskParticipantIds(task),
    task.id,
    'New comment added',
    `${req.user.name} commented on ${taskDisplayName(task)}.`,
    'comment_added',
    req.user.id
  );
  res.status(201).json({ message: 'Comment added' });
}));

app.post('/api/tasks/:id/files', requireAuth, upload.fields([
  { name: 'files', maxCount: 10 },
  { name: 'file', maxCount: 1 }
]), asyncHandler(async (req, res) => {
  const uploadedFiles = requestFiles(req);
  const task = await fetchTask(Number(req.params.id));
  if (!canViewTask(req.user, task)) {
    await Promise.all(uploadedFiles.map(file => removeLocalUpload(file.filename)));
    return res.status(404).json({ message: 'Task not found' });
  }
  if (uploadedFiles.length === 0) return res.status(400).json({ message: 'Select at least one file' });

  const storedFiles = [];
  try {
    for (const file of uploadedFiles) {
      const objectPath = await uploadSupabaseFile(task.id, file);
      storedFiles.push({ file, objectPath });
    }

    await withTransaction(async (tx) => {
      for (const { file, objectPath } of storedFiles) {
        await tx.query(`
          INSERT INTO task_files (
            task_id, user_id, file_name, file_path, file_type, file_size, storage_provider, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'supabase', $7)
        `, [task.id, req.user.id, file.originalname, objectPath, file.mimetype, file.size, now()]);
      }
    });
  } catch (error) {
    await removeSupabaseObjects(storedFiles.map(item => item.objectPath), false);
    throw error;
  } finally {
    await Promise.all(uploadedFiles.map(file => removeLocalUpload(file.filename)));
  }

  const fileNames = uploadedFiles.map(file => file.originalname);
  const summary = fileNames.length === 1 ? fileNames[0] : `${fileNames.length} files: ${fileNames.join(', ')}`;
  await addHistory(task.id, req.user.id, fileNames.length === 1 ? 'File uploaded' : 'Files uploaded', task.status, task.status, summary);
  await notifyUsers(
    taskParticipantIds(task),
    task.id,
    fileNames.length === 1 ? 'File uploaded' : 'Files uploaded',
    `${req.user.name} uploaded ${fileNames.length === 1 ? fileNames[0] : `${fileNames.length} files`} for ${taskDisplayName(task)}.`,
    'file_uploaded',
    req.user.id
  );
  res.status(201).json({
    message: fileNames.length === 1 ? 'File uploaded' : `${fileNames.length} files uploaded`,
    count: fileNames.length
  });
}));

app.delete('/api/tasks/:taskId/files/:fileId', requireAuth, asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.taskId));
  if (!canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });

  const file = await one(`
    SELECT * FROM task_files
    WHERE id = $1 AND task_id = $2
  `, [Number(req.params.fileId), task.id]);
  if (!file) return res.status(404).json({ message: 'File not found' });

  await removeStoredFile(file);
  await query('DELETE FROM task_files WHERE id = $1', [file.id]);
  await addHistory(task.id, req.user.id, 'File deleted', task.status, task.status, file.file_name);
  await notifyUsers(
    taskParticipantIds(task),
    task.id,
    'File deleted',
    `${req.user.name} deleted ${file.file_name} from ${taskDisplayName(task)}.`,
    'file_deleted',
    req.user.id
  );
  res.json({ message: 'File deleted' });
}));

app.post('/api/tasks/:id/accept', requireAuth, requireRole('planner'), asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.id));
  if (!task || !canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });
  if (['Completed', 'Cancelled'].includes(task.status)) {
    return res.status(400).json({ message: 'This task is already closed' });
  }
  const assignment = await one(
    'SELECT * FROM task_planner_assignments WHERE task_id = $1 AND planner_id = $2',
    [task.id, req.user.id]
  );
  if (!assignment) return res.status(404).json({ message: 'Planner assignment not found' });
  if (assignment.status !== 'Pending Acceptance') {
    return res.status(400).json({ message: 'This planner assignment cannot be accepted now' });
  }

  const timestamp = now();
  await query(`
    UPDATE task_planner_assignments
    SET status = 'Accepted', accepted_at = $1, declined_at = NULL, updated_at = $2
    WHERE id = $3
  `, [timestamp, timestamp, assignment.id]);
  const synced = await syncTaskFromPlannerAssignments(task.id);
  const remarks = req.body.remarks || 'Planner accepted their assigned portion.';
  await addHistory(task.id, req.user.id, 'Planner assignment accepted', task.status, synced.newStatus, remarks);
  await addComment(task.id, req.user.id, `${remarks}${assignment.assigned_locations ? ` Locations: ${assignment.assigned_locations}` : ''}`);
  const refreshed = await fetchTask(task.id);
  await notifyUsers(
    taskParticipantIds(refreshed),
    task.id,
    'Planner assignment accepted',
    `${req.user.name} accepted their portion of ${taskDisplayName(task)}.`,
    'task_accepted',
    req.user.id
  );
  res.json({ task: refreshed });
}));

app.post('/api/tasks/:id/decline', requireAuth, requireRole('planner'), asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.id));
  if (!task || !canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });
  if (['Completed', 'Cancelled'].includes(task.status)) {
    return res.status(400).json({ message: 'This task is already closed' });
  }
  const assignment = await one(
    'SELECT * FROM task_planner_assignments WHERE task_id = $1 AND planner_id = $2',
    [task.id, req.user.id]
  );
  if (!assignment) return res.status(404).json({ message: 'Planner assignment not found' });
  if (assignment.status !== 'Pending Acceptance') return res.status(400).json({ message: 'Only pending planner assignments can be declined' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ message: 'Decline reason is required' });

  const timestamp = now();
  await query(`
    UPDATE task_planner_assignments
    SET status = 'Declined', declined_at = $1, updated_at = $2
    WHERE id = $3
  `, [timestamp, timestamp, assignment.id]);
  await query('INSERT INTO task_declines (task_id, planner_id, reason, created_at) VALUES ($1, $2, $3, $4)', [task.id, req.user.id, reason, timestamp]);
  const synced = await syncTaskFromPlannerAssignments(task.id);
  await addHistory(task.id, req.user.id, 'Planner assignment declined', task.status, synced.newStatus, reason);
  await addComment(task.id, req.user.id, `Declined assigned portion: ${reason}`);
  const refreshed = await fetchTask(task.id);
  await notifyUsers(
    taskParticipantIds(refreshed),
    task.id,
    'Planner assignment declined',
    `${req.user.name} declined their portion of ${taskDisplayName(task)}. Reason: ${reason}`,
    'task_declined',
    req.user.id
  );
  res.json({ task: refreshed });
}));

app.patch('/api/tasks/:id/status', requireAuth, asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.id));
  if (!canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });
  const nextStatus = req.body.status;
  const remarks = req.body.remarks || '';
  if (!STATUSES.includes(nextStatus)) return res.status(400).json({ message: 'Invalid status' });

  const plannerAllowed = ['In Progress', 'Waiting for Details', 'Completed'];
  const managerAllowed = ['Pending Lead Assignment', 'Pending Acceptance', 'Accepted', 'In Progress', 'Waiting for Details', 'Submitted for Review', 'Rework Required', 'Completed', 'Cancelled'];

  if (req.user.role === 'planner') {
    if (task.status === 'Cancelled') {
      return res.status(400).json({ message: 'Cancelled tasks cannot be updated' });
    }
    if (!plannerAllowed.includes(nextStatus)) {
      return res.status(403).json({ message: 'Planner can only update their portion to In Progress, Waiting for Details or Completed' });
    }
    const assignment = await one(
      'SELECT * FROM task_planner_assignments WHERE task_id = $1 AND planner_id = $2',
      [task.id, req.user.id]
    );
    if (!assignment) return res.status(403).json({ message: 'This task is not assigned to you' });
    if (assignment.status === 'Pending Acceptance') return res.status(400).json({ message: 'Accept your assignment before updating its status' });

    const timestamp = now();
    await query(`
      UPDATE task_planner_assignments
      SET status = $1,
          completed_at = CASE WHEN $1 = 'Completed' THEN $2 ELSE NULL END,
          updated_at = $2
      WHERE id = $3
    `, [nextStatus, timestamp, assignment.id]);
    const synced = await syncTaskFromPlannerAssignments(task.id);
    const locationNote = assignment.assigned_locations ? ` Locations: ${assignment.assigned_locations}.` : '';
    await addHistory(task.id, req.user.id, 'Planner portion status updated', task.status, synced.newStatus, `${nextStatus}.${locationNote}${remarks ? ` ${remarks}` : ''}`);
    if (remarks) await addComment(task.id, req.user.id, remarks);
    const refreshed = await fetchTask(task.id);
    await notifyUsers(
      taskParticipantIds(refreshed),
      task.id,
      'Planner progress updated',
      `${req.user.name} changed their portion of ${taskDisplayName(task)} to ${nextStatus}.${remarks ? ` ${remarks}` : ''}`,
      'status_updated',
      req.user.id
    );
    return res.json({ task: refreshed });
  }

  if (req.user.role === 'manager' && (Number(task.assigned_by) !== Number(req.user.id) || !managerAllowed.includes(nextStatus))) {
    return res.status(403).json({ message: 'BD can only update their assigned tasks' });
  }
  if (req.user.role === 'planning_lead' && ((Number(task.planning_lead_id) !== Number(req.user.id) && Number(task.assigned_by) !== Number(req.user.id)) || !managerAllowed.includes(nextStatus))) {
    return res.status(403).json({ message: 'Planning Lead can only update tasks assigned to or created by them' });
  }

  const timestamp = now();
  const assignments = await fetchPlannerAssignments(task.id);
  if (nextStatus === 'Completed' && assignments.length > 0) {
    // Admin, BD and Lead retain their existing ability to complete a task.
    // Completing the parent task also closes every planner portion so progress stays consistent.
    await query(`
      UPDATE task_planner_assignments
      SET status = 'Completed', completed_at = $1, updated_at = $2
      WHERE task_id = $3
    `, [timestamp, timestamp, task.id]);
    await syncTaskFromPlannerAssignments(task.id);
  } else {
    const updates = ['status = $1', 'updated_at = $2'];
    const values = [nextStatus, timestamp];
    if (nextStatus === 'Submitted for Review') {
      values.push(timestamp);
      updates.push(`submitted_at = $${values.length}`);
    }
    if (nextStatus === 'Completed') {
      values.push(timestamp);
      updates.push(`completed_at = $${values.length}`);
    }
    if (nextStatus === 'Rework Required') updates.push('rework_count = COALESCE(rework_count, 0) + 1');
    values.push(task.id);
    await query(`UPDATE tasks SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
  }

  await addHistory(task.id, req.user.id, 'Status updated', task.status, nextStatus, remarks);
  if (remarks) await addComment(task.id, req.user.id, remarks);
  const refreshed = await fetchTask(task.id);
  await notifyUsers(
    taskParticipantIds(refreshed),
    task.id,
    'Task status updated',
    `${req.user.name} changed ${taskDisplayName(task)} from ${task.status} to ${nextStatus}.${remarks ? ` ${remarks}` : ''}`,
    'status_updated',
    req.user.id
  );
  res.json({ task: refreshed });
}));

app.patch('/api/tasks/:id/conversion-status', requireAuth, requireRole('admin', 'manager', 'planning_lead'), asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.id));
  if (!canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });
  if (task.status !== 'Completed') {
    return res.status(400).json({ message: 'Conversion status can be updated only for completed tasks' });
  }

  const nextStatus = String(req.body.conversion_status || '').trim();
  if (!['Pending', 'Won', 'Loss'].includes(nextStatus)) {
    return res.status(400).json({ message: 'Conversion status must be Pending, Won or Loss' });
  }

  const previousStatus = task.conversion_status || 'Pending';
  if (previousStatus === nextStatus) return res.json({ task });

  const timestamp = now();
  await query(
    'UPDATE tasks SET conversion_status = $1, updated_at = $2 WHERE id = $3',
    [nextStatus, timestamp, task.id]
  );
  await addHistory(
    task.id,
    req.user.id,
    'Plan conversion updated',
    previousStatus,
    nextStatus,
    nextStatus === 'Won' ? 'Plan Converted' : (nextStatus === 'Loss' ? 'Plan Not Converted' : 'Decision Pending')
  );

  const refreshed = await fetchTask(task.id);
  await notifyUsers(
    taskParticipantIds(refreshed),
    task.id,
    'Plan conversion updated',
    `${req.user.name} marked ${taskDisplayName(task)} as ${nextStatus}${nextStatus === 'Won' ? ' – Plan Converted' : (nextStatus === 'Loss' ? ' – Plan Not Converted' : '')}.`,
    'conversion_status_updated',
    req.user.id
  );
  res.json({ task: refreshed });
}));

app.patch('/api/tasks/:id/reassign-lead', requireAuth, requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.id));
  if (!canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });
  if (task.status === 'Completed') return res.status(400).json({ message: 'Completed tasks cannot be reassigned' });

  const newLeadId = Number(req.body.planning_lead_id);
  const newLead = await one("SELECT * FROM users WHERE id = $1 AND role = 'planning_lead' AND status = 'active'", [newLeadId]);
  if (!newLead) return res.status(400).json({ message: 'Selected Planning Lead is not active or does not exist' });
  if (Number(task.planning_lead_id) === newLeadId) return res.status(400).json({ message: 'This Planning Lead is already assigned to the task' });

  const previousLeadName = task.planning_lead_name || 'Unassigned';
  const previousAssignments = await fetchPlannerAssignments(task.id);
  const previousPlannerNames = previousAssignments.map(item => item.planner_name);
  const message = previousPlannerNames.length
    ? `Planning Lead changed from ${previousLeadName} to ${newLead.name}. Planner assignments cleared: ${previousPlannerNames.join(', ')}.`
    : `Planning Lead changed from ${previousLeadName} to ${newLead.name}.`;

  await withTransaction(async (tx) => {
    await tx.query('DELETE FROM task_planner_assignments WHERE task_id = $1', [task.id]);
    await tx.query(`
      UPDATE tasks
      SET planning_lead_id = $1,
          assigned_to = $1,
          status = 'Pending Lead Assignment',
          declined_at = NULL,
          accepted_at = NULL,
          completed_at = NULL,
          updated_at = $2
      WHERE id = $3
    `, [newLeadId, now(), task.id]);
  });
  await addHistory(task.id, req.user.id, 'Planning Lead reassigned', task.status, 'Pending Lead Assignment', message);
  await addComment(task.id, req.user.id, message);
  await notifyUsers(
    uniqueIds([...taskParticipantIds(task), ...previousAssignments.map(item => item.planner_id), newLeadId]),
    task.id,
    'Planning Lead reassigned',
    `${req.user.name} reassigned ${taskDisplayName(task)} to Planning Lead ${newLead.name}.${previousPlannerNames.length ? ' Existing planner allocations were cleared.' : ''}`,
    'planning_lead_reassigned',
    req.user.id
  );
  res.json({ task: await fetchTask(task.id) });
}));

app.put('/api/tasks/:id/planner-assignments', requireAuth, requireRole('admin', 'manager', 'planning_lead'), asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.id));
  if (!canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });
  if (task.status === 'Completed') return res.status(400).json({ message: 'Completed tasks cannot be reassigned' });

  const requestedAssignments = normalizePlannerAssignments(req.body.assignments);
  if (requestedAssignments.length === 0) {
    return res.status(400).json({ message: 'Select at least one Planner' });
  }

  const plannerIds = requestedAssignments.map(item => item.planner_id);
  const selectedPlanners = await many(
    "SELECT * FROM users WHERE id = ANY($1::int[]) AND role = 'planner' AND status = 'active'",
    [plannerIds]
  );
  if (selectedPlanners.length !== plannerIds.length) {
    return res.status(400).json({ message: 'One or more selected Planners are inactive or do not exist' });
  }

  const previousAssignments = await fetchPlannerAssignments(task.id);
  const previousIds = new Set(previousAssignments.map(item => Number(item.planner_id)));
  const nextIds = new Set(plannerIds.map(Number));
  const addedIds = plannerIds.filter(id => !previousIds.has(Number(id)));
  const removedAssignments = previousAssignments.filter(item => !nextIds.has(Number(item.planner_id)));
  const timestamp = now();

  await withTransaction(async (tx) => {
    if (removedAssignments.length) {
      await tx.query(
        'DELETE FROM task_planner_assignments WHERE task_id = $1 AND planner_id = ANY($2::int[])',
        [task.id, removedAssignments.map(item => item.planner_id)]
      );
    }
    for (const assignment of requestedAssignments) {
      await tx.query(`
        INSERT INTO task_planner_assignments (
          task_id, planner_id, assigned_by, assigned_locations, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'Pending Acceptance', $5, $6)
        ON CONFLICT (task_id, planner_id) DO UPDATE SET
          assigned_locations = EXCLUDED.assigned_locations,
          assigned_by = EXCLUDED.assigned_by,
          status = CASE
            WHEN task_planner_assignments.status = 'Declined' THEN 'Pending Acceptance'
            ELSE task_planner_assignments.status
          END,
          declined_at = CASE
            WHEN task_planner_assignments.status = 'Declined' THEN NULL
            ELSE task_planner_assignments.declined_at
          END,
          updated_at = EXCLUDED.updated_at
      `, [task.id, assignment.planner_id, req.user.id, assignment.assigned_locations, timestamp, timestamp]);
    }
    await tx.query('UPDATE tasks SET assigned_to = $1, updated_at = $2 WHERE id = $3', [requestedAssignments[0].planner_id, timestamp, task.id]);
    await syncTaskFromPlannerAssignments(task.id, tx);
  });

  const plannerById = new Map(selectedPlanners.map(item => [Number(item.id), item]));
  const summaryParts = requestedAssignments.map(item => {
    const name = plannerById.get(Number(item.planner_id))?.name || `Planner #${item.planner_id}`;
    return item.assigned_locations ? `${name}: ${item.assigned_locations}` : name;
  });
  const updatedTask = await fetchTask(task.id);
  await addHistory(task.id, req.user.id, 'Planner allocation updated', task.status, updatedTask.status, summaryParts.join(' | '));
  await addComment(task.id, req.user.id, `Planner allocation updated: ${summaryParts.join(' | ')}.`);

  for (const assignment of requestedAssignments) {
    const planner = plannerById.get(Number(assignment.planner_id));
    const isNew = addedIds.map(Number).includes(Number(assignment.planner_id));
    await notifyUsers(
      [assignment.planner_id],
      task.id,
      isNew ? 'New task portion assigned' : 'Task allocation updated',
      `${req.user.name} ${isNew ? 'assigned' : 'updated'} your portion of ${taskDisplayName(task)}.${assignment.assigned_locations ? ` Locations: ${assignment.assigned_locations}` : ''}`,
      'task_assigned_to_planner',
      req.user.id
    );
  }
  for (const removed of removedAssignments) {
    await notifyUsers(
      [removed.planner_id],
      task.id,
      'Removed from task',
      `${req.user.name} removed you from ${taskDisplayName(task)}.`,
      'planner_removed',
      req.user.id
    );
  }

  res.json({ task: updatedTask, planner_assignments: await fetchPlannerAssignments(task.id) });
}));

async function replaceWithSinglePlanner(req, res) {
  const task = await fetchTask(Number(req.params.id));
  if (!canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });
  if (task.status === 'Completed') return res.status(400).json({ message: 'Completed tasks cannot be reassigned' });

  const newPlannerId = Number(req.body.assigned_to);
  const planner = await one("SELECT * FROM users WHERE id = $1 AND role = 'planner' AND status = 'active'", [newPlannerId]);
  if (!planner) return res.status(400).json({ message: 'Selected planner is not active or does not exist' });

  const previousAssignments = await fetchPlannerAssignments(task.id);
  if (previousAssignments.length === 1 && Number(previousAssignments[0].planner_id) === newPlannerId) {
    return res.status(400).json({ message: 'This planner is already the only assigned Planner' });
  }

  const timestamp = now();
  await withTransaction(async (tx) => {
    await tx.query('DELETE FROM task_planner_assignments WHERE task_id = $1', [task.id]);
    await tx.query(`
      INSERT INTO task_planner_assignments (
        task_id, planner_id, assigned_by, assigned_locations, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'Pending Acceptance', $5, $6)
    `, [task.id, newPlannerId, req.user.id, text(req.body.assigned_locations || task.target_areas), timestamp, timestamp]);
    await tx.query(`
      UPDATE tasks
      SET assigned_to = $1, status = 'Pending Acceptance', declined_at = NULL,
          accepted_at = NULL, completed_at = NULL, updated_at = $2
      WHERE id = $3
    `, [newPlannerId, timestamp, task.id]);
  });

  const previousNames = previousAssignments.map(item => item.planner_name);
  const message = previousNames.length
    ? `Planner allocation changed from ${previousNames.join(', ')} to ${planner.name}.`
    : `Planner assigned to ${planner.name}.`;
  await addHistory(task.id, req.user.id, previousNames.length ? 'Planner reassigned' : 'Planner assigned', task.status, 'Pending Acceptance', message);
  await addComment(task.id, req.user.id, message);
  const refreshed = await fetchTask(task.id);
  await notifyUsers(
    uniqueIds([...taskParticipantIds(task), ...previousAssignments.map(item => item.planner_id), newPlannerId]),
    task.id,
    previousNames.length ? 'Planner reassigned' : 'Task assigned to planner',
    `${req.user.name} assigned ${taskDisplayName(task)} to ${planner.name}.`,
    'task_assigned_to_planner',
    req.user.id
  );
  return res.json({ task: refreshed });
}

app.patch('/api/tasks/:id/reassign-planner', requireAuth, requireRole('admin', 'manager', 'planning_lead'), asyncHandler(replaceWithSinglePlanner));

// Backward-compatible endpoint for older frontend deployments.
app.patch('/api/tasks/:id/reassign', requireAuth, requireRole('admin', 'manager', 'planning_lead'), asyncHandler(replaceWithSinglePlanner));

app.delete('/api/tasks/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.id));
  if (!task) return res.status(404).json({ message: 'Task not found' });
  const files = await many('SELECT * FROM task_files WHERE task_id = $1', [task.id]);
  await query('DELETE FROM tasks WHERE id = $1', [task.id]);
  await removeStoredFilesBestEffort(files);
  res.json({ message: 'Task deleted' });
}));

app.get('/api/reports/overview', requireAuth, asyncHandler(async (req, res) => {
  const user = req.user;
  const values = [];
  const where = [];
  if (user.role === 'manager') {
    values.push(user.id);
    where.push(`assigned_by = $${values.length}`);
  }
  if (user.role === 'planning_lead') {
    values.push(user.id);
    const idx = values.length;
    where.push(`(planning_lead_id = $${idx} OR assigned_to = $${idx} OR assigned_by = $${idx})`);
  }
  if (user.role === 'planner') {
    values.push(user.id);
    where.push(`EXISTS (SELECT 1 FROM task_planner_assignments a WHERE a.task_id = tasks.id AND a.planner_id = $${values.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const statusCounts = await many(`SELECT status, COUNT(*)::int as count FROM tasks ${whereSql} GROUP BY status`, values);
  const priorityCounts = await many(`SELECT priority, COUNT(*)::int as count FROM tasks ${whereSql} GROUP BY priority`, values);
  const total = (await one(`SELECT COUNT(*)::int as count FROM tasks ${whereSql}`, values))?.count || 0;
  const overdue = (await one(`SELECT COUNT(*)::int as count FROM tasks ${whereSql ? `${whereSql} AND` : 'WHERE'} status NOT IN ('Completed', 'Cancelled', 'Declined') AND ${deadlineDateExpression()} < CURRENT_DATE`, values))?.count || 0;
  const dueToday = (await one(`SELECT COUNT(*)::int as count FROM tasks ${whereSql ? `${whereSql} AND` : 'WHERE'} status NOT IN ('Completed', 'Cancelled', 'Declined') AND ${deadlineDateExpression()} = CURRENT_DATE`, values))?.count || 0;
  const completed = (await one(`SELECT COUNT(*)::int as count FROM tasks ${whereSql ? `${whereSql} AND` : 'WHERE'} status = 'Completed'`, values))?.count || 0;
  const conversionCounts = await many(`
    SELECT COALESCE(conversion_status, 'Pending') AS conversion_status, COUNT(*)::int AS count
    FROM tasks
    ${whereSql ? `${whereSql} AND` : 'WHERE'} status = 'Completed'
    GROUP BY COALESCE(conversion_status, 'Pending')
  `, values);
  const conversionMap = Object.fromEntries(conversionCounts.map(row => [row.conversion_status, row.count]));
  const won = conversionMap.Won || 0;
  const loss = conversionMap.Loss || 0;
  const pendingConversion = conversionMap.Pending || 0;
  const conversionRate = completed > 0 ? Number(((won / completed) * 100).toFixed(1)) : 0;

  const workloadParams = user.role === 'manager' ? [user.id] : (user.role === 'planning_lead' ? [user.id] : []);
  const workloadScope = user.role === 'manager'
    ? 'AND t.assigned_by = $1'
    : (user.role === 'planning_lead' ? 'AND (t.planning_lead_id = $1 OR t.assigned_by = $1)' : '');
  const workload = await many(`
    SELECT u.id, u.name, u.verticals, COUNT(t.id)::int AS total,
      COALESCE(SUM(CASE WHEN t.id IS NOT NULL AND a.status NOT IN ('Completed', 'Declined') THEN 1 ELSE 0 END), 0)::int AS active,
      COALESCE(SUM(CASE WHEN t.id IS NOT NULL AND a.status = 'Pending Acceptance' THEN 1 ELSE 0 END), 0)::int AS pending,
      COALESCE(SUM(CASE WHEN t.id IS NOT NULL AND a.status IN ('Waiting for Details') THEN 1 ELSE 0 END), 0)::int AS review,
      COALESCE(SUM(CASE WHEN t.id IS NOT NULL AND a.status NOT IN ('Completed', 'Declined') AND ${deadlineDateExpression('t')} < CURRENT_DATE THEN 1 ELSE 0 END), 0)::int AS overdue,
      COALESCE(SUM(CASE WHEN t.id IS NOT NULL AND a.status = 'Completed' THEN 1 ELSE 0 END), 0)::int AS completed
    FROM users u
    LEFT JOIN task_planner_assignments a ON a.planner_id = u.id
    LEFT JOIN tasks t ON t.id = a.task_id ${workloadScope}
    WHERE u.role = 'planner' AND u.status = 'active'
    GROUP BY u.id, u.name, u.verticals
    ORDER BY active DESC, overdue DESC, total DESC
  `, workloadParams);

  const workloadTaskWhere = user.role === 'manager'
    ? 'WHERE t.assigned_by = $1 AND'
    : user.role === 'planning_lead'
      ? 'WHERE (t.planning_lead_id = $1 OR t.assigned_by = $1) AND'
      : user.role === 'planner'
        ? 'WHERE a.planner_id = $1 AND'
        : 'WHERE';
  const workloadTasks = await many(`
    SELECT t.id, t.task_code, t.title, t.brand_name, a.status, t.priority, t.due_date, t.submission_deadline,
      a.planner_id AS assigned_to, a.assigned_locations, u.name AS planner_name
    FROM task_planner_assignments a
    JOIN tasks t ON t.id = a.task_id
    JOIN users u ON u.id = a.planner_id
    ${workloadTaskWhere} a.status NOT IN ('Completed', 'Declined')
    ORDER BY ${deadlineDateExpression('t')} ASC NULLS LAST,
      CASE t.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
      t.created_at DESC
    LIMIT 18
  `, values);

  res.json({
    total,
    overdue,
    dueToday,
    completed,
    statusCounts,
    priorityCounts,
    workload,
    workloadTasks,
    conversion: {
      won,
      loss,
      pending: pendingConversion,
      conversionRate
    }
  });
}));

app.get('/api/reports/export', requireAuth, asyncHandler(async (req, res) => {
  const values = [];
  const where = [];

  if (req.user.role === 'manager') {
    values.push(req.user.id);
    where.push(`t.assigned_by = $${values.length}`);
  }
  if (req.user.role === 'planning_lead') {
    values.push(req.user.id);
    const idx = values.length;
    where.push(`(t.planning_lead_id = $${idx} OR t.assigned_to = $${idx} OR t.assigned_by = $${idx})`);
  }
  if (req.user.role === 'planner') {
    values.push(req.user.id);
    where.push(`COALESCE(a.planner_id, t.assigned_to) = $${values.length}`);
  }

  const reportRows = await many(`
    SELECT
      t.created_at AS request_received_at,
      t.task_code,
      CASE
        WHEN LOWER(COALESCE(t.direct_client_or_agency, '')) = 'ad agency'
          THEN COALESCE(NULLIF(t.agency_name, ''), NULLIF(t.brand_name, ''), NULLIF(t.client_name, ''), '')
        ELSE COALESCE(NULLIF(t.brand_name, ''), NULLIF(t.client_name, ''), NULLIF(t.agency_name, ''), '')
      END AS brand_or_agency_name,
      COALESCE(t.direct_client_or_agency, '') AS customer_type,
      COALESCE(t.plan_format, '') AS plan_required,
      assigner.name AS assigned_by_name,
      COALESCE(CASE WHEN planner.role = 'planner' THEN planner.name END, '') AS planner_name,
      COALESCE(NULLIF(a.assigned_locations, ''), NULLIF(t.target_areas, ''), '') AS target_areas,
      CASE
        WHEN a.id IS NOT NULL THEN a.created_at
        WHEN planner.role = 'planner' THEN t.created_at
        ELSE NULL
      END AS plan_assigned_at,
      CASE
        WHEN a.id IS NOT NULL THEN a.completed_at
        WHEN planner.role = 'planner' AND t.status = 'Completed' THEN t.completed_at
        ELSE NULL
      END AS plan_completed_at,
      COALESCE(a.status, t.status) AS assignment_status,
      COALESCE(t.conversion_status, 'Pending') AS conversion_status
    FROM tasks t
    JOIN users assigner ON assigner.id = t.assigned_by
    LEFT JOIN task_planner_assignments a ON a.task_id = t.id
    LEFT JOIN users planner ON planner.id = COALESCE(a.planner_id, t.assigned_to)
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.created_at DESC, t.id DESC, a.id ASC NULLS LAST
  `, values);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ADINN Planning Task Manager';
  workbook.lastModifiedBy = req.user.name || 'ADINN';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;

  const worksheet = workbook.addWorksheet('Adinn Task Manager Report', {
    views: [{ state: 'frozen', ySplit: 2 }],
    properties: { defaultRowHeight: 22 },
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
      margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
    }
  });

  const headers = [
    'S No',
    'Request Received Date',
    'Request Received Time',
    'Task Code',
    'Brand Name / Agency Name',
    'Type of Customer',
    'Plan Required',
    'Assigned By / BD Name',
    'Planner Name',
    'Target Areas/Location',
    'Plan Assigned Date',
    'Plan Assigned Time',
    'Plan Completed Date',
    'Plan Completed Time',
    'Duration',
    'Status',
    'Conversion Status'
  ];

  worksheet.mergeCells('A1:Q1');
  const titleCell = worksheet.getCell('A1');
  titleCell.value = 'Adinn Task Manager Report';
  titleCell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD71920' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  worksheet.getRow(1).height = 30;

  const headerRow = worksheet.addRow(headers);
  headerRow.height = 36;
  headerRow.eachCell(cell => {
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FFD71920' } } };
  });

  const columnWidths = [8, 19, 18, 18, 30, 19, 18, 24, 22, 48, 19, 18, 19, 18, 14, 22, 22];
  columnWidths.forEach((width, index) => {
    worksheet.getColumn(index + 1).width = width;
  });

  reportRows.forEach((item, index) => {
    const requestReceived = reportDateTimeParts(item.request_received_at);
    const planAssigned = reportDateTimeParts(item.plan_assigned_at);
    const planCompleted = reportDateTimeParts(item.plan_completed_at);
    const durationDays = reportDurationDays(item.plan_assigned_at, item.plan_completed_at);

    const row = worksheet.addRow([
      index + 1,
      requestReceived.date,
      requestReceived.time,
      item.task_code || '',
      item.brand_or_agency_name || '',
      item.customer_type || '',
      item.plan_required || '',
      item.assigned_by_name || '',
      item.planner_name || '',
      item.target_areas || '',
      planAssigned.date,
      planAssigned.time,
      planCompleted.date,
      planCompleted.time,
      '',
      item.assignment_status || '',
      reportConversionStatus(item.conversion_status)
    ]);

    const rowNumber = row.number;
    if (durationDays !== null) {
      row.getCell(15).value = {
        formula: `IF(OR(K${rowNumber}="",L${rowNumber}="",M${rowNumber}="",N${rowNumber}=""),"",M${rowNumber}+N${rowNumber}-K${rowNumber}-L${rowNumber})`,
        result: durationDays
      };
    }

    [2, 11, 13].forEach(column => { row.getCell(column).numFmt = 'dd-mmm-yyyy'; });
    [3, 12, 14].forEach(column => { row.getCell(column).numFmt = 'hh:mm AM/PM'; });
    row.getCell(15).numFmt = '[h]:mm';

    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF111827' } };
      cell.alignment = {
        vertical: 'top',
        horizontal: [1, 2, 3, 11, 12, 13, 14, 15, 16, 17].includes(columnNumber) ? 'center' : 'left',
        wrapText: true
      };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
      if (rowNumber % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
      }
    });

    const statusCell = row.getCell(16);
    const statusValue = String(item.assignment_status || '');
    const statusColor = statusValue === 'Completed'
      ? { fill: 'FFE8F5EC', font: 'FF087443' }
      : ['Declined', 'Cancelled'].includes(statusValue)
        ? { fill: 'FFFFE8E8', font: 'FFB42318' }
        : ['Pending Acceptance', 'Pending Lead Assignment'].includes(statusValue)
          ? { fill: 'FFFFF4E5', font: 'FF9A4D00' }
          : { fill: 'FFEAF2FF', font: 'FF175CD3' };
    statusCell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: statusColor.font } };
    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusColor.fill } };

    const conversionCell = row.getCell(17);
    const conversionValue = reportConversionStatus(item.conversion_status);
    const conversionColor = conversionValue === 'Won'
      ? { fill: 'FFE8F5EC', font: 'FF087443' }
      : conversionValue === 'Loss'
        ? { fill: 'FFFFE8E8', font: 'FFB42318' }
        : { fill: 'FFFFF4E5', font: 'FF9A4D00' };
    conversionCell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: conversionColor.font } };
    conversionCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: conversionColor.fill } };

    row.height = 42;
  });

  const lastRow = Math.max(worksheet.rowCount, 2);
  worksheet.autoFilter = { from: 'A2', to: `Q${lastRow}` };
  worksheet.pageSetup.printTitlesRow = '1:2';
  worksheet.getColumn(1).alignment = { horizontal: 'center' };

  const output = await workbook.xlsx.writeBuffer({ useStyles: true, useSharedStrings: true });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Adinn Task Manager Report.xlsx"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(output));
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: err.message || 'Unexpected server error' });
});

async function start() {
  await initDb();
  await validateSupabaseStorage();
  app.listen(PORT, () => {
    console.log(`ADINN Planning Task Manager API running on http://localhost:${PORT}`);
    console.log(`Task attachments are stored in Supabase bucket: ${SUPABASE_STORAGE_BUCKET}`);
  });
}

start().catch((error) => {
  console.error('Failed to start ADINN Planning Task Manager API');
  console.error(error);
  process.exit(1);
});
