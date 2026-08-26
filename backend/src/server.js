const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
require('dotenv').config();

const {
  mongoose,
  initDb,
  now,
  hashPassword,
  addHistory,
  generateTaskCode,
  withTransaction,
  nextId,
  User,
  Task,
  TaskPlannerAssignment,
  TaskComment,
  TaskFile,
  TaskStatusHistory,
  TaskDecline,
  Notification
} = require('./database');
const { scheduleCronJobs } = require('./cron');

const app = express();
const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-change-me';
const FILE_TOKEN_SECRET = process.env.FILE_TOKEN_SECRET || JWT_SECRET;
const FILE_LINK_SECONDS = Math.min(
  Math.max(Number(process.env.FILE_LINK_SECONDS || process.env.SUPABASE_SIGNED_URL_SECONDS) || 3600, 60),
  86400
);
const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
fs.mkdirSync(uploadDir, { recursive: true });

// File storage backend for new uploads: 'space' (DigitalOcean Spaces, public-read)
// or 'gridfs' (MongoDB GridFS). Existing records keep working via their own
// storage_provider regardless of this setting.
const STORAGE_TYPE = process.env.STORAGE_TYPE || 'gridfs';
const DO_SPACES_BUCKET = process.env.DO_SPACES_BUCKET || 'adinn-space';
const DO_SPACES_REGION = process.env.DO_SPACES_REGION || 'sgp1';
const DO_SPACES_ENDPOINT = process.env.DO_SPACES_ENDPOINT || 'https://sgp1.digitaloceanspaces.com';
const DO_SPACES_CDN_BASE = (process.env.DO_SPACES_CDN_BASE || `https://${DO_SPACES_BUCKET}.${DO_SPACES_REGION}.digitaloceanspaces.com`).replace(/\/+$/, '');

const spacesClient = new S3Client({
  region: DO_SPACES_REGION,
  endpoint: DO_SPACES_ENDPOINT,
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET
  },
  forcePathStyle: false
});

function spacePublicUrl(key) {
  return `${DO_SPACES_CDN_BASE}/${String(key || '').replace(/^\/+/, '')}`;
}

async function uploadSpaceFile(file, uploader) {
  const safeName = path.basename(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeUploaderName = String(uploader?.name || 'user')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'user';
  const uploaderFolder = `${safeUploaderName}-${uploader?.id ?? 'unknown'}`;
  const key = `Adinn-planning-task-attachments/${uploaderFolder}/${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`;
  // Multipart upload with several parts in flight at once. Over a
  // high-latency path (e.g. this server to the sgp1 Spaces endpoint), a
  // single TCP stream often can't saturate the actual available bandwidth --
  // running a few part uploads concurrently gets closer to it.
  const upload = new Upload({
    client: spacesClient,
    params: {
      Bucket: DO_SPACES_BUCKET,
      Key: key,
      Body: fs.createReadStream(file.path),
      ContentType: file.mimetype || 'application/octet-stream',
      ACL: 'public-read'
    },
    queueSize: 4,
    partSize: 10 * 1024 * 1024
  });
  await upload.done();
  return key;
}

async function removeSpaceFile(key, throwOnError = true) {
  if (!key) return;
  try {
    await spacesClient.send(new DeleteObjectCommand({ Bucket: DO_SPACES_BUCKET, Key: key }));
  } catch (error) {
    if (throwOnError) throw new Error(`Unable to delete stored file: ${error.message}`);
    console.error('Unable to clean up Space file', error);
  }
}

let gridFsBucket = null;
function getGridFsBucket() {
  if (!gridFsBucket) {
    gridFsBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'task_attachments' });
  }
  return gridFsBucket;
}

const allowedOrigins = String(process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map(origin => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 250;
const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
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

// ---------------------------------------------------------------------------
// File storage (MongoDB GridFS, replacing Supabase Storage / falling back to
// the local disk copy for older records created before this migration)
// ---------------------------------------------------------------------------

function safeStorageFileName(originalName) {
  const extension = path.extname(originalName || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 20);
  const baseName = path.basename(originalName || 'file', path.extname(originalName || ''))
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100) || 'file';
  return `${baseName}${extension}`;
}

async function uploadGridFsFile(file) {
  const bucket = getGridFsBucket();
  const filename = safeStorageFileName(file.originalname);
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: file.mimetype || 'application/octet-stream'
    });
    fs.createReadStream(file.path)
      .on('error', reject)
      .pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => resolve(uploadStream.id));
  });
}

async function removeGridFsFile(gridfsId, throwOnError = true) {
  if (!gridfsId) return;
  try {
    await getGridFsBucket().delete(new mongoose.Types.ObjectId(gridfsId));
  } catch (error) {
    if (throwOnError) throw new Error(`Unable to delete stored file: ${error.message}`);
    console.error('Unable to clean up GridFS file', error);
  }
}

function signFileToken(fileId, mode) {
  return jwt.sign({ fileId: String(fileId), mode }, FILE_TOKEN_SECRET, { expiresIn: FILE_LINK_SECONDS });
}

function fileLink(fileId, mode) {
  const token = signFileToken(fileId, mode);
  return `/files/${fileId}?mode=${mode}&token=${encodeURIComponent(token)}`;
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

  if (file.storage_provider === 'space') {
    const url = spacePublicUrl(file.file_path);
    return {
      ...file,
      available: true,
      preview_kind: previewKind,
      preview_url: url,
      download_url: url,
      url
    };
  }

  if (file.storage_provider === 'gridfs') {
    if (!file.gridfs_id) {
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
    const downloadUrl = fileLink(file.gridfs_id, 'download');
    const previewUrl = fileLink(file.gridfs_id, 'preview');
    return {
      ...file,
      available: true,
      preview_kind: previewKind,
      preview_url: previewUrl,
      download_url: downloadUrl,
      url: downloadUrl
    };
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
    unavailable_reason: exists ? null : 'Old file is unavailable. Please re-upload it.'
  };
}

async function removeStoredFile(file, throwOnError = true) {
  if (!file) return;
  if (file.storage_provider === 'space') {
    await removeSpaceFile(file.file_path, throwOnError);
    return;
  }
  if (file.storage_provider === 'gridfs') {
    await removeGridFsFile(file.gridfs_id, throwOnError);
    return;
  }
  await removeLocalUpload(file.file_path);
}

async function removeStoredFilesBestEffort(files) {
  await Promise.all((files || []).map(file => removeStoredFile(file, false)));
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

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

function toPlainId(doc) {
  if (!doc) return doc;
  const { _id, __v, ...rest } = doc;
  return { id: _id, ...rest };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function joinUserFields(rows, idField, fields) {
  if (!rows.length) return [];
  const ids = uniqueIds(rows.map(r => r[idField]));
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select(fields.join(' ')).lean() : [];
  const map = new Map(users.map(u => [Number(u._id), u]));
  return rows.map(r => {
    const u = map.get(Number(r[idField])) || {};
    const extra = {};
    for (const f of fields) extra[f] = u[f] ?? null;
    return { ...toPlainId(r), ...extra };
  });
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
    const user = await User.findById(payload.id).lean();
    if (!user || user.status !== 'active') return res.status(401).json({ message: 'User is not active' });
    req.user = toPlainId(user);
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

function uniqueIds(ids = []) {
  return Array.from(new Set(ids.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0)));
}

function taskDisplayName(task) {
  if (!task) return 'Planning task';
  return task.brand_name || task.title || task.task_code || 'Planning task';
}

async function createNotification(userId, taskId, title, message, type = 'task_update') {
  if (!userId) return;
  const id = await nextId('notifications');
  await Notification.create({
    _id: id,
    user_id: userId,
    task_id: taskId || null,
    title,
    message,
    type,
    is_read: false,
    created_at: now()
  });
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

async function addComment(taskId, userId, comment) {
  if (!comment || !comment.trim()) return;
  const id = await nextId('task_comments');
  await TaskComment.create({
    _id: id,
    task_id: taskId,
    user_id: userId,
    comment: comment.trim(),
    created_at: now()
  });
}

// ---------------------------------------------------------------------------
// Task read helpers (replace the correlated-subquery SQL in fetchTask / the
// task-list query with batched lookups + in-app joins)
// ---------------------------------------------------------------------------

async function fetchAssignmentsForTasks(taskIds) {
  const map = new Map();
  if (!taskIds.length) return map;
  const assignments = await TaskPlannerAssignment.find({ task_id: { $in: taskIds } }).sort({ _id: 1 }).lean();
  for (const a of assignments) {
    const key = Number(a.task_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }
  return map;
}

async function attachTaskDetailsBatch(taskDocs, assignmentsByTask) {
  const tasks = taskDocs.map(t => (t.toObject ? t.toObject() : t));
  if (tasks.length === 0) return [];
  const relatedUserIds = uniqueIds(tasks.flatMap(t => [t.assigned_by, t.assigned_to, t.planning_lead_id]));
  const allAssignments = [...assignmentsByTask.values()].flat();
  const plannerIds = uniqueIds(allAssignments.map(a => a.planner_id));
  const allUserIds = uniqueIds([...relatedUserIds, ...plannerIds]);
  const users = allUserIds.length
    ? await User.find({ _id: { $in: allUserIds } }).select('name email role verticals').lean()
    : [];
  const userMap = new Map(users.map(u => [Number(u._id), u]));

  return tasks.map(task => {
    const taskAssignments = assignmentsByTask.get(Number(task.id)) || [];
    const assigner = userMap.get(Number(task.assigned_by));
    const planner = userMap.get(Number(task.assigned_to));
    const lead = task.planning_lead_id ? userMap.get(Number(task.planning_lead_id)) : null;
    const plannerIdsForTask = taskAssignments.map(a => Number(a.planner_id));
    const assignedPlannerNames = taskAssignments
      .map(a => userMap.get(Number(a.planner_id))?.name)
      .filter(Boolean)
      .join(', ');
    return {
      ...task,
      assigned_by_name: assigner?.name || null,
      assigned_by_email: assigner?.email || null,
      assigned_by_role: assigner?.role || null,
      assigned_to_name: planner?.name || null,
      assigned_to_email: planner?.email || null,
      assigned_to_role: planner?.role || null,
      planning_lead_name: lead?.name || null,
      planning_lead_email: lead?.email || null,
      planner_ids: plannerIdsForTask,
      assigned_planner_names: assignedPlannerNames,
      planner_count: taskAssignments.length,
      planner_completed_count: taskAssignments.filter(a => a.status === 'Completed').length,
      planner_assignments_summary: taskAssignments.map(a => ({
        planner_id: a.planner_id,
        status: a.status,
        assigned_locations: a.assigned_locations
      }))
    };
  });
}

async function fetchTask(id) {
  const task = await Task.findById(id);
  if (!task) return null;
  const assignmentsByTask = await fetchAssignmentsForTasks([task._id]);
  const [attached] = await attachTaskDetailsBatch([task], assignmentsByTask);
  return attached;
}

async function fetchPlannerAssignments(taskId) {
  const assignments = await TaskPlannerAssignment.find({ task_id: taskId }).sort({ _id: 1 }).lean();
  if (!assignments.length) return [];
  const plannerIds = uniqueIds(assignments.map(a => a.planner_id));
  const planners = await User.find({ _id: { $in: plannerIds } }).select('name email verticals').lean();
  const plannerMap = new Map(planners.map(u => [Number(u._id), u]));
  return assignments.map(a => {
    const p = plannerMap.get(Number(a.planner_id));
    return {
      ...toPlainId(a),
      planner_name: p?.name || null,
      planner_email: p?.email || null,
      planner_verticals: p?.verticals || ''
    };
  });
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

async function syncTaskFromPlannerAssignments(taskId, session = null) {
  const assignmentsQuery = TaskPlannerAssignment.find({ task_id: taskId }).sort({ _id: 1 });
  if (session) assignmentsQuery.session(session);
  const assignments = await assignmentsQuery.lean();

  const taskQuery = Task.findById(taskId);
  if (session) taskQuery.session(session);
  const task = await taskQuery;
  if (!task) return null;

  const nextStatus = overallTaskStatus(assignments);
  const firstPlannerId = assignments[0]?.planner_id || task.planning_lead_id || task.assigned_to;
  const timestamp = now();
  const oldStatus = task.status;

  task.assigned_to = firstPlannerId;
  task.status = nextStatus;
  if (['Accepted', 'In Progress', 'Waiting for Details', 'Completed'].includes(nextStatus)) {
    task.accepted_at = task.accepted_at || timestamp;
  }
  task.declined_at = nextStatus === 'Declined' ? timestamp : null;
  task.completed_at = nextStatus === 'Completed' ? timestamp : null;
  task.updated_at = timestamp;
  await task.save(session ? { session } : undefined);

  return { oldStatus, newStatus: nextStatus, assignments };
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

// ---------------------------------------------------------------------------
// Cascading deletes (MongoDB has no FK cascade, so this replaces what
// Postgres's ON DELETE CASCADE used to do implicitly)
// ---------------------------------------------------------------------------

async function deleteTaskCascade(taskId, session) {
  await TaskPlannerAssignment.deleteMany({ task_id: taskId }).session(session);
  await TaskComment.deleteMany({ task_id: taskId }).session(session);
  await TaskFile.deleteMany({ task_id: taskId }).session(session);
  await TaskStatusHistory.deleteMany({ task_id: taskId }).session(session);
  await TaskDecline.deleteMany({ task_id: taskId }).session(session);
  await Notification.deleteMany({ task_id: taskId }).session(session);
  await Task.deleteOne({ _id: taskId }).session(session);
}

// ---------------------------------------------------------------------------
// Reports helpers
// ---------------------------------------------------------------------------

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

function priorityRank(priority) {
  return priority === 'Urgent' ? 0 : priority === 'High' ? 1 : priority === 'Medium' ? 2 : 3;
}

function effectiveDeadline(task) {
  return task.submission_deadline || task.due_date || '';
}

function deadlineExpr() {
  return {
    $cond: [
      { $and: [{ $ne: ['$submission_deadline', null] }, { $ne: ['$submission_deadline', ''] }] },
      '$submission_deadline',
      '$due_date'
    ]
  };
}

async function buildVisibilityFilter(user) {
  if (user.role === 'manager') return { assigned_by: user.id };
  if (user.role === 'planning_lead') {
    return { $or: [{ planning_lead_id: user.id }, { assigned_to: user.id }, { assigned_by: user.id }] };
  }
  if (user.role === 'planner') {
    const taskIds = await TaskPlannerAssignment.find({ planner_id: user.id }).distinct('task_id');
    return { _id: { $in: taskIds } };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'ADINN Planning Task Manager', database: 'mongodb', time: now() });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'ADINN Planning Task Manager', database: 'mongodb', time: now() });
});

app.get('/files/:fileId', asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ message: 'Missing file access token' });
  let payload;
  try {
    payload = jwt.verify(token, FILE_TOKEN_SECRET);
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired file link' });
  }
  if (String(payload.fileId) !== String(req.params.fileId)) {
    return res.status(401).json({ message: 'Invalid file link' });
  }
  const mode = payload.mode === 'preview' ? 'preview' : 'download';

  let objectId;
  try {
    objectId = new mongoose.Types.ObjectId(req.params.fileId);
  } catch (error) {
    return res.status(404).json({ message: 'File not found' });
  }
  const fileDoc = await TaskFile.findOne({ gridfs_id: objectId }).lean();
  if (!fileDoc) return res.status(404).json({ message: 'File not found' });

  // The default Content-Security-Policy (from helmet) sends frame-ancestors 'self',
  // which blocks the frontend (a different origin) from embedding this response in
  // an <iframe> for the preview modal. Relax it just for this route, scoped to the
  // configured frontend origins, so PDF/document previews can actually render.
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${allowedOrigins.join(' ')}`.trim());
  res.setHeader('Content-Type', fileDoc.file_type || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${mode === 'download' ? 'attachment' : 'inline'}; filename="${encodeURIComponent(fileDoc.file_name)}"`
  );
  const downloadStream = getGridFsBucket().openDownloadStream(objectId);
  downloadStream.on('error', () => {
    if (!res.headersSent) res.status(404).json({ message: 'File not found' });
  });
  downloadStream.pipe(res);
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email: String(email || '').toLowerCase() });
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }
  if (user.status !== 'active') return res.status(403).json({ message: 'This account is inactive' });
  const plain = user.toObject();
  res.json({ token: signToken(plain), user: publicUser(plain) });
}));

app.get('/api/auth/me', requireAuth, asyncHandler(async (req, res) => {
  res.json({ user: publicUser(req.user) });
}));

app.get('/api/notifications', requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 40), 1), 500);
  const rows = await Notification.find({ user_id: req.user.id }).sort({ created_at: -1 }).limit(limit).lean();
  const taskIds = uniqueIds(rows.map(r => r.task_id).filter(Boolean));
  const tasks = taskIds.length
    ? await Task.find({ _id: { $in: taskIds } }).select('task_code brand_name title status').lean()
    : [];
  const taskMap = new Map(tasks.map(t => [Number(t._id), t]));
  const notifications = rows.map(r => {
    const t = r.task_id ? taskMap.get(Number(r.task_id)) : null;
    return {
      ...toPlainId(r),
      task_code: t?.task_code || null,
      brand_name: t?.brand_name || null,
      task_title: t?.title || null,
      task_status: t?.status || null
    };
  });
  const unreadCount = await Notification.countDocuments({ user_id: req.user.id, is_read: false });
  res.json({ notifications, unread_count: unreadCount });
}));

app.patch('/api/notifications/:id/read', requireAuth, asyncHandler(async (req, res) => {
  await Notification.updateOne({ _id: Number(req.params.id), user_id: req.user.id }, { $set: { is_read: true } });
  res.json({ message: 'Notification marked as read' });
}));

app.patch('/api/notifications/read-all', requireAuth, asyncHandler(async (req, res) => {
  await Notification.updateMany({ user_id: req.user.id, is_read: false }, { $set: { is_read: true } });
  res.json({ message: 'Notifications marked as read' });
}));

app.get('/api/users', requireAuth, asyncHandler(async (req, res) => {
  const { role, status = 'active' } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (status !== 'all') filter.status = status;

  if (req.user.role === 'planner') {
    filter.$or = [
      { role: { $in: ['manager', 'planning_lead', 'admin'] } },
      { _id: req.user.id }
    ];
  }

  const rows = await User.find(filter).sort({ role: 1, name: 1 }).lean();
  res.json({ users: rows.map(r => publicUser(toPlainId(r))) });
}));

app.post('/api/users', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { name, email, password, role, department, phone, verticals } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ message: 'Name, email, password and role are required' });
  if (!['admin', 'manager', 'planning_lead', 'planner'].includes(role)) return res.status(400).json({ message: 'Invalid role' });

  try {
    const timestamp = now();
    const id = await nextId('users');
    const created = await User.create({
      _id: id,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password_hash: hashPassword(password),
      role,
      department: department || 'Planning',
      phone: phone || '',
      verticals: verticals || '',
      status: 'active',
      created_at: timestamp,
      updated_at: timestamp
    });
    res.status(201).json({ user: publicUser(created.toObject()) });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'Email already exists' });
    throw error;
  }
}));

app.patch('/api/users/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await User.findById(id);
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

  existing.name = next.name;
  existing.email = next.email;
  existing.role = next.role;
  existing.department = next.department;
  existing.phone = next.phone;
  existing.verticals = next.verticals;
  existing.status = next.status;
  existing.updated_at = now();
  if (req.body.password) existing.password_hash = hashPassword(req.body.password);
  await existing.save();
  res.json({ user: publicUser(existing.toObject()) });
}));

app.delete('/api/users/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ message: 'Admin cannot delete their own account' });
  const existing = await User.findById(id).lean();
  if (!existing) return res.status(404).json({ message: 'User not found' });
  if (existing.role === 'admin') return res.status(400).json({ message: 'Admin accounts cannot be deleted' });

  const ownedTasks = await Task.find({
    $or: [{ assigned_by: id }, { assigned_to: id }, { planning_lead_id: id }]
  }).select('_id').lean();
  const ownedTaskIds = ownedTasks.map(t => t._id);

  const directFiles = await TaskFile.find({ user_id: id }).lean();
  const ownedTaskFiles = ownedTaskIds.length
    ? await TaskFile.find({ task_id: { $in: ownedTaskIds } }).lean()
    : [];
  const allFilesToRemove = [...directFiles, ...ownedTaskFiles];

  await withTransaction(async (session) => {
    for (const taskId of ownedTaskIds) {
      await deleteTaskCascade(taskId, session);
    }
    await TaskPlannerAssignment.deleteMany({ $or: [{ planner_id: id }, { assigned_by: id }] }).session(session);
    await TaskComment.deleteMany({ user_id: id }).session(session);
    await TaskFile.deleteMany({ user_id: id }).session(session);
    await TaskStatusHistory.deleteMany({ user_id: id }).session(session);
    await TaskDecline.deleteMany({ planner_id: id }).session(session);
    await Notification.deleteMany({ user_id: id }).session(session);
    await User.deleteOne({ _id: id }).session(session);
  });

  await removeStoredFilesBestEffort(allFilesToRemove);
  res.json({ message: 'User deleted successfully' });
}));

app.get('/api/tasks', requireAuth, asyncHandler(async (req, res) => {
  const { status, priority, assigned_to, assigned_by, search, from, to, category, campaign_type, plan_format, view, scope } = req.query;
  const filter = {};
  const andConditions = [];

  if (req.user.role === 'manager') filter.assigned_by = req.user.id;
  if (req.user.role === 'planning_lead') {
    filter.$or = [
      { planning_lead_id: req.user.id },
      { assigned_to: req.user.id },
      { assigned_by: req.user.id }
    ];
  }
  // Planners can browse company-wide task summaries. Dashboard and other
  // personal views can explicitly request only their assigned records.
  if (req.user.role === 'planner' && scope === 'assigned') {
    const ids = await TaskPlannerAssignment.find({ planner_id: req.user.id }).distinct('task_id');
    andConditions.push({ _id: { $in: ids } });
  }

  if (view === 'completed') {
    if (req.user.role === 'planner') {
      const ids = await TaskPlannerAssignment.find({ planner_id: req.user.id, status: 'Completed' }).distinct('task_id');
      andConditions.push({ _id: { $in: ids } });
    } else {
      filter.status = 'Completed';
    }
  }
  if (view === 'active') {
    if (req.user.role === 'planner') {
      const completedIds = await TaskPlannerAssignment.find({ planner_id: req.user.id, status: 'Completed' }).distinct('task_id');
      andConditions.push({ _id: { $nin: completedIds } });
    } else {
      filter.status = { $ne: 'Completed' };
    }
  }
  if (status && status !== 'all') filter.status = status;
  if (priority && priority !== 'all') filter.priority = priority;
  if (assigned_to && assigned_to !== 'all') {
    const ids = await TaskPlannerAssignment.find({ planner_id: Number(assigned_to) }).distinct('task_id');
    andConditions.push({ _id: { $in: ids } });
  }
  if (assigned_by && assigned_by !== 'all') filter.assigned_by = Number(assigned_by);
  if (category && category !== 'all') filter.category = category;
  if (campaign_type && campaign_type !== 'all') filter.campaign_type = campaign_type;
  if (plan_format && plan_format !== 'all') filter.plan_format = plan_format;

  const exprConditions = [];
  if (from) exprConditions.push({ $gte: [deadlineExpr(), from] });
  if (to) exprConditions.push({ $lte: [deadlineExpr(), to] });
  if (exprConditions.length) {
    andConditions.push({ $expr: exprConditions.length === 1 ? exprConditions[0] : { $and: exprConditions } });
  }

  if (search) {
    const fields = [
      'task_code', 'title', 'client_name', 'brand_name', 'direct_client_or_agency',
      'agency_name', 'campaign_type', 'category', 'plan_format', 'target_areas',
      'target_audience_profile', 'site_preferences', 'additional_specifications'
    ];
    andConditions.push({ $or: fields.map(f => ({ [f]: { $regex: escapeRegex(search), $options: 'i' } })) });
  }

  if (andConditions.length) filter.$and = andConditions;

  const taskDocs = await Task.find(filter);
  const taskIds = taskDocs.map(t => t._id);
  const assignmentsByTask = await fetchAssignmentsForTasks(taskIds);
  let tasks = await attachTaskDetailsBatch(taskDocs, assignmentsByTask);

  if (view === 'completed') {
    // Newest submission deadline first (matches the "Submission Deadline" column
    // shown on the Completed page), falling back to completion/update time when
    // a task has no deadline recorded. Legacy records store this in inconsistent
    // date-string formats, so compare actual parsed timestamps rather than raw
    // strings (lexicographic comparison silently breaks on mixed formats).
    const sortTimestamp = (value) => {
      const parsed = value ? new Date(value).getTime() : NaN;
      return Number.isNaN(parsed) ? -Infinity : parsed;
    };
    tasks.sort((a, b) => {
      const aKey = sortTimestamp(effectiveDeadline(a) || a.completed_at || a.updated_at || a.created_at);
      const bKey = sortTimestamp(effectiveDeadline(b) || b.completed_at || b.updated_at || b.created_at);
      if (aKey !== bKey) return bKey - aKey;
      return Number(b.id) - Number(a.id);
    });
  } else {
    tasks.sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      const aDeadline = effectiveDeadline(a);
      const bDeadline = effectiveDeadline(b);
      if ((aDeadline === '') !== (bDeadline === '')) return aDeadline === '' ? 1 : -1;
      if (aDeadline !== bDeadline) return aDeadline < bDeadline ? -1 : 1;
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
      return 0;
    });
  }

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
  const lead = await User.findOne({ _id: leadId, role: 'planning_lead', status: 'active' }).lean();
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
    selectedPlanners = await User.find({
      _id: { $in: requestedAssignments.map(item => item.planner_id) },
      role: 'planner',
      status: 'active'
    }).lean();
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
  const initialAssigneeId = isLeadCreator ? requestedAssignments[0].planner_id : lead._id;

  const created = await withTransaction(async (session) => {
    const taskCode = await generateTaskCode(session);
    const taskId = await nextId('tasks', session);
    const [taskDoc] = await Task.create([{
      _id: taskId,
      task_code: taskCode,
      title,
      client_name: clientName,
      brand_name: text(body.brand_name),
      direct_client_or_agency: text(body.direct_client_or_agency),
      agency_name: text(body.agency_name),
      campaign_name: text(body.campaign_name || body.brand_name),
      campaign_type: text(body.campaign_type || ''),
      city: text(body.city),
      state: text(body.state || 'Tamil Nadu'),
      category: text(body.category || 'Campaign Plan'),
      deliverable: buildDeliverable(body),
      description: buildDescription(body),
      priority: text(body.priority || 'Medium') || 'Medium',
      status: initialStatus,
      assigned_by: req.user.id,
      assigned_to: initialAssigneeId,
      planning_lead_id: lead._id,
      start_date: campaignStartDate,
      due_date: submissionDeadline,
      campaign_start_date: campaignStartDate,
      campaign_duration: text(body.campaign_duration),
      campaign_budget: text(body.campaign_budget),
      display_cost_range: text(body.display_cost_range),
      target_areas: text(body.target_areas),
      target_audience_profile: text(body.target_audience_profile),
      site_preferences: text(body.site_preferences),
      ownership_type: text(body.ownership_type),
      location_type: text(body.location_type),
      size_preference: text(body.size_preference),
      additional_specifications: additionalSpecifications,
      plan_format: planFormat,
      submission_deadline: submissionDeadline,
      created_at: timestamp,
      updated_at: timestamp
    }], { session });

    if (isLeadCreator) {
      for (const assignment of requestedAssignments) {
        const assignmentId = await nextId('task_planner_assignments', session);
        await TaskPlannerAssignment.create([{
          _id: assignmentId,
          task_id: taskDoc._id,
          planner_id: assignment.planner_id,
          assigned_by: req.user.id,
          assigned_locations: assignment.assigned_locations,
          status: 'Pending Acceptance',
          created_at: timestamp,
          updated_at: timestamp
        }], { session });
      }
    }
    return taskDoc;
  });

  if (isLeadCreator) {
    const plannerById = new Map(selectedPlanners.map(item => [Number(item._id), item]));
    const assignmentSummary = requestedAssignments.map(item => {
      const plannerName = plannerById.get(Number(item.planner_id))?.name || `Planner #${item.planner_id}`;
      return item.assigned_locations ? `${plannerName}: ${item.assigned_locations}` : plannerName;
    });
    const remarks = `Planning Lead: ${lead.name}; Planners: ${assignmentSummary.join(' | ')}`;
    await addHistory(created._id, req.user.id, 'Task created and assigned to multiple Planners', null, 'Pending Acceptance', remarks);
    await addComment(created._id, req.user.id, `Task request created with Planning Lead ${lead.name}. Planner allocation: ${assignmentSummary.join(' | ')}.`);
    await notifyUsers(
      [lead._id],
      created._id,
      'New task assigned to Planning Lead',
      `${req.user.name} selected you as Planning Lead for ${taskDisplayName({ brand_name: text(body.brand_name), title })}.`,
      'task_assigned_to_lead',
      req.user.id
    );
    for (const assignment of requestedAssignments) {
      await notifyUsers(
        [assignment.planner_id],
        created._id,
        'New task assigned to Planner',
        `${req.user.name} assigned ${taskDisplayName({ brand_name: text(body.brand_name), title })} to you for acceptance.${assignment.assigned_locations ? ` Your locations: ${assignment.assigned_locations}` : ''}`,
        'task_assigned_to_planner',
        req.user.id
      );
    }
  } else {
    await addHistory(created._id, req.user.id, 'Task assigned to Planning Lead', null, 'Pending Lead Assignment', `Assigned to Planning Lead ${lead.name}`);
    await addComment(created._id, req.user.id, `Task request created and assigned to Planning Lead ${lead.name}.`);
    await notifyUsers(
      [lead._id],
      created._id,
      'New task assigned to Planning Lead',
      `${req.user.name} assigned ${taskDisplayName({ brand_name: text(body.brand_name), title })} to you.`,
      'task_assigned_to_lead',
      req.user.id
    );
  }

  res.status(201).json({ task: await fetchTask(created._id) });
}));

app.get('/api/tasks/:id', requireAuth, asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.id));
  if (!canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });
  const comments = await joinUserFields(
    await TaskComment.find({ task_id: task.id }).sort({ created_at: 1 }).lean(),
    'user_id', ['name', 'role']
  );
  const fileRows = await joinUserFields(
    await TaskFile.find({ task_id: task.id }).sort({ created_at: -1 }).lean(),
    'user_id', ['name']
  );
  const files = await Promise.all(fileRows.map(attachmentResponse));
  const history = await joinUserFields(
    await TaskStatusHistory.find({ task_id: task.id }).sort({ created_at: -1 }).lean(),
    'user_id', ['name']
  );
  const declines = await joinUserFields(
    await TaskDecline.find({ task_id: task.id }).sort({ created_at: -1 }).lean(),
    'planner_id', ['name']
  );
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

  // By the time we get here, multer has already fully received the request
  // body from the client (that leg is not visible to this timer). This timer
  // isolates just the server -> storage (Spaces/GridFS) leg, so slow uploads
  // can be diagnosed: small number here = bottleneck is the client's upload
  // bandwidth to this server; large number here = bottleneck is this server's
  // connection to the storage backend.
  const totalBytes = uploadedFiles.reduce((sum, file) => sum + (file.size || 0), 0);
  const storageUploadStartedAt = Date.now();

  // Upload all files to storage concurrently (rather than one at a time) so a
  // multi-file drag & drop doesn't wait on each file sequentially.
  const uploadOutcomes = await Promise.allSettled(uploadedFiles.map(async (file) => {
    if (STORAGE_TYPE === 'space') {
      const spaceKey = await uploadSpaceFile(file, req.user);
      return { file, storageProvider: 'space', filePath: spaceKey, gridfsId: null };
    }
    const gridfsId = await uploadGridFsFile(file);
    return { file, storageProvider: 'gridfs', filePath: String(gridfsId), gridfsId };
  }));

  const storageUploadMs = Date.now() - storageUploadStartedAt;
  console.log(
    `[file-upload] task=${req.params.id} files=${uploadedFiles.length} totalSize=${(totalBytes / 1024 / 1024).toFixed(1)}MB `
    + `storageType=${STORAGE_TYPE} serverToStorageMs=${storageUploadMs}`
  );

  const storedFiles = uploadOutcomes.filter(r => r.status === 'fulfilled').map(r => r.value);
  const failedUpload = uploadOutcomes.find(r => r.status === 'rejected');

  if (failedUpload) {
    await Promise.all(storedFiles.map(item => (
      item.storageProvider === 'space'
        ? removeSpaceFile(item.filePath, false)
        : removeGridFsFile(item.gridfsId, false)
    )));
    await Promise.all(uploadedFiles.map(file => removeLocalUpload(file.filename)));
    throw failedUpload.reason;
  }

  try {
    await withTransaction(async (session) => {
      for (const { file, storageProvider, filePath, gridfsId } of storedFiles) {
        const id = await nextId('task_files', session);
        await TaskFile.create([{
          _id: id,
          task_id: task.id,
          user_id: req.user.id,
          file_name: file.originalname,
          file_path: filePath,
          file_type: file.mimetype,
          file_size: file.size,
          storage_provider: storageProvider,
          gridfs_id: gridfsId,
          created_at: now()
        }], { session });
      }
    });
  } catch (error) {
    await Promise.all(storedFiles.map(item => (
      item.storageProvider === 'space'
        ? removeSpaceFile(item.filePath, false)
        : removeGridFsFile(item.gridfsId, false)
    )));
    throw error;
  } finally {
    await Promise.all(uploadedFiles.map(file => removeLocalUpload(file.filename)));
  }

  const fileNames = uploadedFiles.map(file => file.originalname);
  // Callers uploading one file at a time as part of a client-side batch (so
  // each file can show its own real progress/done/cancel state) pass
  // silent=true on every request but the last, and instead call
  // POST /api/tasks/:id/files/notify-batch once at the end so the whole
  // batch produces exactly one history entry / notification.
  if (req.body.silent !== 'true') {
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
  }
  res.status(201).json({
    message: fileNames.length === 1 ? 'File uploaded' : `${fileNames.length} files uploaded`,
    count: fileNames.length
  });
}));

app.post('/api/tasks/:id/files/notify-batch', requireAuth, asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.id));
  if (!canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });

  const count = Math.max(Number(req.body.count) || 0, 1);
  await addHistory(task.id, req.user.id, count === 1 ? 'File uploaded' : 'Files uploaded', task.status, task.status, `${count} file${count === 1 ? '' : 's'}`);
  await notifyUsers(
    taskParticipantIds(task),
    task.id,
    count === 1 ? 'File uploaded' : 'Files uploaded',
    `${req.user.name} uploaded ${count === 1 ? '1 file' : `${count} files`} for ${taskDisplayName(task)}.`,
    'file_uploaded',
    req.user.id
  );
  res.json({ message: 'Notified' });
}));

app.delete('/api/tasks/:taskId/files/:fileId', requireAuth, asyncHandler(async (req, res) => {
  const task = await fetchTask(Number(req.params.taskId));
  if (!canViewTask(req.user, task)) return res.status(404).json({ message: 'Task not found' });

  const file = await TaskFile.findOne({ _id: Number(req.params.fileId), task_id: task.id }).lean();
  if (!file) return res.status(404).json({ message: 'File not found' });

  await removeStoredFile(file);
  await TaskFile.deleteOne({ _id: file._id });
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
  const assignment = await TaskPlannerAssignment.findOne({ task_id: task.id, planner_id: req.user.id }).lean();
  if (!assignment) return res.status(404).json({ message: 'Planner assignment not found' });
  if (assignment.status !== 'Pending Acceptance') {
    return res.status(400).json({ message: 'This planner assignment cannot be accepted now' });
  }

  const remarks = req.body.remarks || 'Planner accepted their assigned portion.';
  const synced = await withTransaction(async (session) => {
    const timestamp = now();
    await TaskPlannerAssignment.updateOne(
      { _id: assignment._id },
      { $set: { status: 'Accepted', accepted_at: timestamp, declined_at: null, updated_at: timestamp } }
    ).session(session);
    return syncTaskFromPlannerAssignments(task.id, session);
  });
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
  const assignment = await TaskPlannerAssignment.findOne({ task_id: task.id, planner_id: req.user.id }).lean();
  if (!assignment) return res.status(404).json({ message: 'Planner assignment not found' });
  if (assignment.status !== 'Pending Acceptance') return res.status(400).json({ message: 'Only pending planner assignments can be declined' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ message: 'Decline reason is required' });

  const synced = await withTransaction(async (session) => {
    const timestamp = now();
    await TaskPlannerAssignment.updateOne(
      { _id: assignment._id },
      { $set: { status: 'Declined', declined_at: timestamp, updated_at: timestamp } }
    ).session(session);
    const declineId = await nextId('task_declines', session);
    await TaskDecline.create([{
      _id: declineId,
      task_id: task.id,
      planner_id: req.user.id,
      reason,
      created_at: timestamp
    }], { session });
    return syncTaskFromPlannerAssignments(task.id, session);
  });
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
    const assignment = await TaskPlannerAssignment.findOne({ task_id: task.id, planner_id: req.user.id }).lean();
    if (!assignment) return res.status(403).json({ message: 'This task is not assigned to you' });
    if (assignment.status === 'Pending Acceptance') return res.status(400).json({ message: 'Accept your assignment before updating its status' });

    const synced = await withTransaction(async (session) => {
      const timestamp = now();
      await TaskPlannerAssignment.updateOne(
        { _id: assignment._id },
        { $set: { status: nextStatus, completed_at: nextStatus === 'Completed' ? timestamp : null, updated_at: timestamp } }
      ).session(session);
      return syncTaskFromPlannerAssignments(task.id, session);
    });
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
    await withTransaction(async (session) => {
      await TaskPlannerAssignment.updateMany(
        { task_id: task.id },
        { $set: { status: 'Completed', completed_at: timestamp, updated_at: timestamp } }
      ).session(session);
      await syncTaskFromPlannerAssignments(task.id, session);
    });
  } else {
    const update = { status: nextStatus, updated_at: timestamp };
    if (nextStatus === 'Submitted for Review') update.submitted_at = timestamp;
    if (nextStatus === 'Completed') update.completed_at = timestamp;
    const updateOps = { $set: update };
    if (nextStatus === 'Rework Required') updateOps.$inc = { rework_count: 1 };
    await Task.updateOne({ _id: task.id }, updateOps);
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
  await Task.updateOne({ _id: task.id }, { $set: { conversion_status: nextStatus, updated_at: timestamp } });
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
  const newLead = await User.findOne({ _id: newLeadId, role: 'planning_lead', status: 'active' }).lean();
  if (!newLead) return res.status(400).json({ message: 'Selected Planning Lead is not active or does not exist' });
  if (Number(task.planning_lead_id) === newLeadId) return res.status(400).json({ message: 'This Planning Lead is already assigned to the task' });

  const previousLeadName = task.planning_lead_name || 'Unassigned';
  const previousAssignments = await fetchPlannerAssignments(task.id);
  const previousPlannerNames = previousAssignments.map(item => item.planner_name);
  const message = previousPlannerNames.length
    ? `Planning Lead changed from ${previousLeadName} to ${newLead.name}. Planner assignments cleared: ${previousPlannerNames.join(', ')}.`
    : `Planning Lead changed from ${previousLeadName} to ${newLead.name}.`;

  await withTransaction(async (session) => {
    await TaskPlannerAssignment.deleteMany({ task_id: task.id }).session(session);
    await Task.updateOne({ _id: task.id }, {
      $set: {
        planning_lead_id: newLeadId,
        assigned_to: newLeadId,
        status: 'Pending Lead Assignment',
        declined_at: null,
        accepted_at: null,
        completed_at: null,
        updated_at: now()
      }
    }).session(session);
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
  const selectedPlanners = await User.find({ _id: { $in: plannerIds }, role: 'planner', status: 'active' }).lean();
  if (selectedPlanners.length !== plannerIds.length) {
    return res.status(400).json({ message: 'One or more selected Planners are inactive or do not exist' });
  }

  const previousAssignments = await fetchPlannerAssignments(task.id);
  const previousIds = new Set(previousAssignments.map(item => Number(item.planner_id)));
  const nextIds = new Set(plannerIds.map(Number));
  const addedIds = plannerIds.filter(id => !previousIds.has(Number(id)));
  const removedAssignments = previousAssignments.filter(item => !nextIds.has(Number(item.planner_id)));
  const timestamp = now();

  await withTransaction(async (session) => {
    if (removedAssignments.length) {
      await TaskPlannerAssignment.deleteMany({
        task_id: task.id,
        planner_id: { $in: removedAssignments.map(item => item.planner_id) }
      }).session(session);
    }
    for (const assignment of requestedAssignments) {
      const existing = await TaskPlannerAssignment.findOne({ task_id: task.id, planner_id: assignment.planner_id }).session(session);
      if (existing) {
        const resetFromDecline = existing.status === 'Declined';
        existing.assigned_locations = assignment.assigned_locations;
        existing.assigned_by = req.user.id;
        existing.updated_at = timestamp;
        if (resetFromDecline) {
          existing.status = 'Pending Acceptance';
          existing.declined_at = null;
        }
        await existing.save({ session });
      } else {
        const id = await nextId('task_planner_assignments', session);
        await TaskPlannerAssignment.create([{
          _id: id,
          task_id: task.id,
          planner_id: assignment.planner_id,
          assigned_by: req.user.id,
          assigned_locations: assignment.assigned_locations,
          status: 'Pending Acceptance',
          created_at: timestamp,
          updated_at: timestamp
        }], { session });
      }
    }
    await Task.updateOne({ _id: task.id }, { $set: { assigned_to: requestedAssignments[0].planner_id, updated_at: timestamp } }).session(session);
    await syncTaskFromPlannerAssignments(task.id, session);
  });

  const plannerById = new Map(selectedPlanners.map(item => [Number(item._id), item]));
  const summaryParts = requestedAssignments.map(item => {
    const name = plannerById.get(Number(item.planner_id))?.name || `Planner #${item.planner_id}`;
    return item.assigned_locations ? `${name}: ${item.assigned_locations}` : name;
  });
  const updatedTask = await fetchTask(task.id);
  await addHistory(task.id, req.user.id, 'Planner allocation updated', task.status, updatedTask.status, summaryParts.join(' | '));
  await addComment(task.id, req.user.id, `Planner allocation updated: ${summaryParts.join(' | ')}.`);

  for (const assignment of requestedAssignments) {
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
  const planner = await User.findOne({ _id: newPlannerId, role: 'planner', status: 'active' }).lean();
  if (!planner) return res.status(400).json({ message: 'Selected planner is not active or does not exist' });

  const previousAssignments = await fetchPlannerAssignments(task.id);
  if (previousAssignments.length === 1 && Number(previousAssignments[0].planner_id) === newPlannerId) {
    return res.status(400).json({ message: 'This planner is already the only assigned Planner' });
  }

  const timestamp = now();
  await withTransaction(async (session) => {
    await TaskPlannerAssignment.deleteMany({ task_id: task.id }).session(session);
    const id = await nextId('task_planner_assignments', session);
    await TaskPlannerAssignment.create([{
      _id: id,
      task_id: task.id,
      planner_id: newPlannerId,
      assigned_by: req.user.id,
      assigned_locations: text(req.body.assigned_locations || task.target_areas),
      status: 'Pending Acceptance',
      created_at: timestamp,
      updated_at: timestamp
    }], { session });
    await Task.updateOne({ _id: task.id }, {
      $set: {
        assigned_to: newPlannerId,
        status: 'Pending Acceptance',
        declined_at: null,
        accepted_at: null,
        completed_at: null,
        updated_at: timestamp
      }
    }).session(session);
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
  const taskId = Number(req.params.id);
  const task = await Task.findById(taskId).lean();
  if (!task) return res.status(404).json({ message: 'Task not found' });
  const files = await TaskFile.find({ task_id: taskId }).lean();
  await withTransaction(async (session) => {
    await deleteTaskCascade(taskId, session);
  });
  await removeStoredFilesBestEffort(files);
  res.json({ message: 'Task deleted' });
}));

app.get('/api/reports/overview', requireAuth, asyncHandler(async (req, res) => {
  const user = req.user;
  const filter = await buildVisibilityFilter(user);
  const today = new Date().toISOString().slice(0, 10);

  const [statusCountsRaw, priorityCountsRaw, total] = await Promise.all([
    Task.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Task.aggregate([{ $match: filter }, { $group: { _id: '$priority', count: { $sum: 1 } } }]),
    Task.countDocuments(filter)
  ]);
  const statusCounts = statusCountsRaw.map(r => ({ status: r._id, count: r.count }));
  const priorityCounts = priorityCountsRaw.map(r => ({ priority: r._id, count: r.count }));

  const openFilter = { ...filter, status: { $nin: ['Completed', 'Cancelled', 'Declined'] } };
  const [overdue, dueToday, completed, conversionCountsRaw] = await Promise.all([
    Task.countDocuments({ ...openFilter, $expr: { $lt: [deadlineExpr(), today] } }),
    Task.countDocuments({ ...openFilter, $expr: { $eq: [deadlineExpr(), today] } }),
    Task.countDocuments({ ...filter, status: 'Completed' }),
    Task.aggregate([
      { $match: { ...filter, status: 'Completed' } },
      { $group: { _id: { $ifNull: ['$conversion_status', 'Pending'] }, count: { $sum: 1 } } }
    ])
  ]);
  const conversionMap = Object.fromEntries(conversionCountsRaw.map(row => [row._id, row.count]));
  const won = conversionMap.Won || 0;
  const loss = conversionMap.Loss || 0;
  const pendingConversion = conversionMap.Pending || 0;
  const conversionRate = completed > 0 ? Number(((won / completed) * 100).toFixed(1)) : 0;

  const plannerTaskFilter = {};
  if (user.role === 'manager') plannerTaskFilter.assigned_by = user.id;
  if (user.role === 'planning_lead') plannerTaskFilter.$or = [{ planning_lead_id: user.id }, { assigned_by: user.id }];

  const activePlanners = await User.find({ role: 'planner', status: 'active' }).select('name verticals').lean();
  const plannerIds = activePlanners.map(p => Number(p._id));
  const relevantAssignments = plannerIds.length
    ? await TaskPlannerAssignment.find({ planner_id: { $in: plannerIds } }).lean()
    : [];
  const relevantTaskIds = uniqueIds(relevantAssignments.map(a => a.task_id));
  const relevantTasks = relevantTaskIds.length
    ? await Task.find({ _id: { $in: relevantTaskIds }, ...plannerTaskFilter }).lean()
    : [];
  const relevantTaskMap = new Map(relevantTasks.map(t => [Number(t._id), t]));

  const workload = activePlanners.map(planner => {
    const withTasks = relevantAssignments
      .filter(a => Number(a.planner_id) === Number(planner._id) && relevantTaskMap.has(Number(a.task_id)))
      .map(a => ({ assignment: a, task: relevantTaskMap.get(Number(a.task_id)) }));
    const overdueCount = withTasks.filter(x => {
      if (['Completed', 'Declined'].includes(x.assignment.status)) return false;
      const deadline = effectiveDeadline(x.task);
      return deadline && deadline < today;
    }).length;
    return {
      id: planner._id,
      name: planner.name,
      verticals: planner.verticals,
      total: withTasks.length,
      active: withTasks.filter(x => !['Completed', 'Declined'].includes(x.assignment.status)).length,
      pending: withTasks.filter(x => x.assignment.status === 'Pending Acceptance').length,
      review: withTasks.filter(x => x.assignment.status === 'Waiting for Details').length,
      overdue: overdueCount,
      completed: withTasks.filter(x => x.assignment.status === 'Completed').length
    };
  }).sort((a, b) => (b.active - a.active) || (b.overdue - a.overdue) || (b.total - a.total));

  const plannerNameMap = new Map(activePlanners.map(p => [Number(p._id), p.name]));
  const workloadTasks = relevantAssignments
    .filter(a => !['Completed', 'Declined'].includes(a.status) && relevantTaskMap.has(Number(a.task_id)))
    .map(a => {
      const task = relevantTaskMap.get(Number(a.task_id));
      return {
        id: task._id,
        task_code: task.task_code,
        title: task.title,
        brand_name: task.brand_name,
        status: a.status,
        priority: task.priority,
        due_date: task.due_date,
        submission_deadline: task.submission_deadline,
        assigned_to: a.planner_id,
        assigned_locations: a.assigned_locations,
        planner_name: plannerNameMap.get(Number(a.planner_id)) || null
      };
    })
    .sort((a, b) => {
      const aDeadline = a.submission_deadline || a.due_date || '';
      const bDeadline = b.submission_deadline || b.due_date || '';
      if ((aDeadline === '') !== (bDeadline === '')) return aDeadline === '' ? 1 : -1;
      if (aDeadline !== bDeadline) return aDeadline < bDeadline ? -1 : 1;
      return priorityRank(a.priority) - priorityRank(b.priority);
    })
    .slice(0, 18);

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
  let taskFilter = {};
  if (req.user.role === 'manager') taskFilter = { assigned_by: req.user.id };
  if (req.user.role === 'planning_lead') {
    taskFilter = { $or: [{ planning_lead_id: req.user.id }, { assigned_to: req.user.id }, { assigned_by: req.user.id }] };
  }
  if (req.user.role === 'planner') {
    const ids = await TaskPlannerAssignment.find({ planner_id: req.user.id }).distinct('task_id');
    taskFilter = { $or: [{ _id: { $in: ids } }, { assigned_to: req.user.id }] };
  }

  const tasks = await Task.find(taskFilter).sort({ created_at: -1, _id: -1 }).lean();
  const taskIds = tasks.map(t => Number(t._id));
  const assignments = taskIds.length
    ? await TaskPlannerAssignment.find({ task_id: { $in: taskIds } }).sort({ _id: 1 }).lean()
    : [];
  const userIds = uniqueIds([
    ...tasks.map(t => t.assigned_by),
    ...tasks.map(t => t.assigned_to),
    ...assignments.map(a => a.planner_id)
  ]);
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select('name role').lean() : [];
  const userMap = new Map(users.map(u => [Number(u._id), u]));

  const assignmentsByTask = new Map();
  for (const a of assignments) {
    const key = Number(a.task_id);
    if (!assignmentsByTask.has(key)) assignmentsByTask.set(key, []);
    assignmentsByTask.get(key).push(a);
  }

  const reportRows = [];
  for (const task of tasks) {
    const taskAssignments = assignmentsByTask.get(Number(task._id)) || [];
    const assigner = userMap.get(Number(task.assigned_by));
    // LEFT JOIN semantics: emit one row even when the task has no planner assignment yet.
    const rowsForTask = taskAssignments.length ? taskAssignments : [null];

    for (const assignment of rowsForTask) {
      const rowPlannerId = assignment ? assignment.planner_id : task.assigned_to;
      const plannerUser = userMap.get(Number(rowPlannerId));
      const brandOrAgencyName = String(task.direct_client_or_agency || '').toLowerCase() === 'ad agency'
        ? (task.agency_name || task.brand_name || task.client_name || '')
        : (task.brand_name || task.client_name || task.agency_name || '');
      const planAssignedAt = assignment
        ? assignment.created_at
        : (plannerUser?.role === 'planner' ? task.created_at : null);
      const planCompletedAt = assignment
        ? assignment.completed_at
        : (plannerUser?.role === 'planner' && task.status === 'Completed' ? task.completed_at : null);

      reportRows.push({
        _rowPlannerId: rowPlannerId,
        request_received_at: task.created_at,
        task_code: task.task_code,
        brand_or_agency_name: brandOrAgencyName,
        customer_type: task.direct_client_or_agency || '',
        plan_required: task.plan_format || '',
        assigned_by_name: assigner?.name || '',
        planner_name: plannerUser?.role === 'planner' ? (plannerUser.name || '') : '',
        target_areas: assignment?.assigned_locations || task.target_areas || '',
        plan_assigned_at: planAssignedAt,
        plan_completed_at: planCompletedAt,
        assignment_status: assignment ? assignment.status : task.status,
        conversion_status: task.conversion_status || 'Pending'
      });
    }
  }

  // The task-level filter above casts a slightly wider net for planners (any task
  // they have ever been assigned to); narrow to just their own row here, matching
  // the original per-row SQL filter so a planner never sees another planner's row.
  const filteredRows = req.user.role === 'planner'
    ? reportRows.filter(row => Number(row._rowPlannerId) === Number(req.user.id))
    : reportRows;

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

  filteredRows.forEach((item, index) => {
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
  scheduleCronJobs();
  app.listen(PORT, () => {
    console.log(`ADINN Planning Task Manager API running on http://localhost:${PORT}`);
    console.log('Task attachments are stored in MongoDB GridFS (bucket: task_attachments)');
  });
}

start().catch((error) => {
  console.error('Failed to start ADINN Planning Task Manager API');
  console.error(error);
  process.exit(1);
});
