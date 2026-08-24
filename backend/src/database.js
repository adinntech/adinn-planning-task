const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

function now() {
  return new Date().toISOString();
}

const connectionString = process.env.MONGODB_URI;

if (!connectionString) {
  console.warn('MONGODB_URI is not set. Add a MongoDB Atlas connection string in backend/.env before starting the backend.');
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

const jsonTransform = (_doc, ret) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  return ret;
};

const schemaOptions = {
  id: false,
  toJSON: { transform: jsonTransform },
  toObject: { transform: jsonTransform }
};

// ---------------------------------------------------------------------------
// Counters (replaces SERIAL auto-increment primary keys)
// ---------------------------------------------------------------------------

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

async function nextId(name, session = null) {
  const options = { upsert: true, new: true, setDefaultsOnInsert: true };
  if (session) options.session = session;
  const counter = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    options
  );
  return counter.seq;
}

async function nextTaskCode(session) {
  const d = new Date();
  const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const counterId = `task-code:${stamp}`;
  const counter = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true, session }
  );
  return `PLN-${stamp}-${String(counter.seq).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const userSchema = new mongoose.Schema({
  _id: { type: Number },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password_hash: { type: String, required: true },
  role: { type: String, required: true, enum: ['admin', 'manager', 'planning_lead', 'planner'] },
  department: { type: String, default: 'Planning' },
  phone: { type: String, default: '' },
  verticals: { type: String, default: '' },
  status: { type: String, required: true, enum: ['active', 'inactive'], default: 'active' },
  created_at: { type: String, required: true },
  updated_at: { type: String, required: true }
}, schemaOptions);
const User = mongoose.model('User', userSchema);

const taskSchema = new mongoose.Schema({
  _id: { type: Number },
  task_code: { type: String, required: true, unique: true },
  title: { type: String, default: 'Planning Request' },
  client_name: { type: String, default: '' },
  brand_name: { type: String, default: '' },
  direct_client_or_agency: { type: String, default: '' },
  agency_name: { type: String, default: '' },
  campaign_name: { type: String, default: '' },
  campaign_type: { type: String, default: '' },
  city: { type: String, default: '' },
  state: { type: String, default: '' },
  category: { type: String, default: '' },
  deliverable: { type: String, default: '' },
  description: { type: String, default: '' },
  priority: { type: String, required: true, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
  status: { type: String, required: true, default: 'Pending Acceptance' },
  assigned_by: { type: Number, ref: 'User', required: true },
  assigned_to: { type: Number, ref: 'User', required: true },
  planning_lead_id: { type: Number, ref: 'User', default: null },
  start_date: { type: String, default: '' },
  due_date: { type: String, default: '' },
  campaign_start_date: { type: String, default: '' },
  campaign_duration: { type: String, default: '' },
  campaign_budget: { type: String, default: '' },
  display_cost_range: { type: String, default: '' },
  target_areas: { type: String, default: '' },
  target_audience_profile: { type: String, default: '' },
  site_preferences: { type: String, default: '' },
  ownership_type: { type: String, default: '' },
  location_type: { type: String, default: '' },
  size_preference: { type: String, default: '' },
  additional_specifications: { type: String, default: '' },
  plan_format: { type: String, default: '' },
  submission_deadline: { type: String, default: '' },
  accepted_at: { type: String, default: null },
  declined_at: { type: String, default: null },
  submitted_at: { type: String, default: null },
  completed_at: { type: String, default: null },
  conversion_status: { type: String, required: true, default: 'Pending' },
  rework_count: { type: Number, default: 0 },
  created_at: { type: String, required: true },
  updated_at: { type: String, required: true }
}, schemaOptions);
taskSchema.index({ status: 1 });
taskSchema.index({ assigned_by: 1 });
taskSchema.index({ assigned_to: 1 });
taskSchema.index({ submission_deadline: 1 });
const Task = mongoose.model('Task', taskSchema);

const taskPlannerAssignmentSchema = new mongoose.Schema({
  _id: { type: Number },
  task_id: { type: Number, ref: 'Task', required: true },
  planner_id: { type: Number, ref: 'User', required: true },
  assigned_by: { type: Number, ref: 'User', required: true },
  assigned_locations: { type: String, default: '' },
  status: { type: String, required: true, default: 'Pending Acceptance' },
  accepted_at: { type: String, default: null },
  declined_at: { type: String, default: null },
  completed_at: { type: String, default: null },
  created_at: { type: String, required: true },
  updated_at: { type: String, required: true }
}, schemaOptions);
taskPlannerAssignmentSchema.index({ task_id: 1, planner_id: 1 }, { unique: true });
taskPlannerAssignmentSchema.index({ planner_id: 1 });
taskPlannerAssignmentSchema.index({ status: 1 });
const TaskPlannerAssignment = mongoose.model('TaskPlannerAssignment', taskPlannerAssignmentSchema);

const taskCommentSchema = new mongoose.Schema({
  _id: { type: Number },
  task_id: { type: Number, ref: 'Task', required: true },
  user_id: { type: Number, ref: 'User', required: true },
  comment: { type: String, required: true },
  created_at: { type: String, required: true }
}, schemaOptions);
taskCommentSchema.index({ task_id: 1 });
const TaskComment = mongoose.model('TaskComment', taskCommentSchema);

const taskFileSchema = new mongoose.Schema({
  _id: { type: Number },
  task_id: { type: Number, ref: 'Task', required: true },
  user_id: { type: Number, ref: 'User', required: true },
  file_name: { type: String, required: true },
  file_path: { type: String, required: true },
  file_type: { type: String, default: '' },
  file_size: { type: Number, default: 0 },
  storage_provider: { type: String, required: true, default: 'local' },
  gridfs_id: { type: mongoose.Schema.Types.ObjectId, default: null },
  created_at: { type: String, required: true }
}, schemaOptions);
taskFileSchema.index({ task_id: 1 });
const TaskFile = mongoose.model('TaskFile', taskFileSchema);

const taskStatusHistorySchema = new mongoose.Schema({
  _id: { type: Number },
  task_id: { type: Number, ref: 'Task', required: true },
  user_id: { type: Number, ref: 'User', required: true },
  action: { type: String, required: true },
  old_status: { type: String, default: null },
  new_status: { type: String, default: null },
  remarks: { type: String, default: '' },
  created_at: { type: String, required: true }
}, schemaOptions);
taskStatusHistorySchema.index({ task_id: 1 });
const TaskStatusHistory = mongoose.model('TaskStatusHistory', taskStatusHistorySchema);

const taskDeclineSchema = new mongoose.Schema({
  _id: { type: Number },
  task_id: { type: Number, ref: 'Task', required: true },
  planner_id: { type: Number, ref: 'User', required: true },
  reason: { type: String, required: true },
  created_at: { type: String, required: true }
}, schemaOptions);
taskDeclineSchema.index({ task_id: 1 });
const TaskDecline = mongoose.model('TaskDecline', taskDeclineSchema);

const notificationSchema = new mongoose.Schema({
  _id: { type: Number },
  user_id: { type: Number, ref: 'User', required: true },
  task_id: { type: Number, ref: 'Task', default: null },
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, required: true, default: 'task_update' },
  is_read: { type: Boolean, required: true, default: false },
  created_at: { type: String, required: true }
}, schemaOptions);
notificationSchema.index({ user_id: 1 });
notificationSchema.index({ user_id: 1, is_read: 1 });
notificationSchema.index({ task_id: 1 });
const Notification = mongoose.model('Notification', notificationSchema);

// ---------------------------------------------------------------------------
// Transaction helper (replaces the pg withTransaction wrapper)
// ---------------------------------------------------------------------------

async function withTransaction(callback) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await callback(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Shared write helpers used across the app
// ---------------------------------------------------------------------------

async function addHistory(taskId, userId, action, oldStatus, newStatus, remarks = '') {
  const id = await nextId('task_status_history');
  await TaskStatusHistory.create({
    _id: id,
    task_id: taskId,
    user_id: userId,
    action,
    old_status: oldStatus,
    new_status: newStatus,
    remarks,
    created_at: now()
  });
}

async function generateTaskCode(session) {
  return nextTaskCode(session);
}

// ---------------------------------------------------------------------------
// Startup: connect, sync indexes, seed default users
// ---------------------------------------------------------------------------

async function insertUser({ name, email, password, role, department = 'Planning', phone = '', verticals = '' }) {
  const timestamp = now();
  const id = await nextId('users');
  const created = await User.create({
    _id: id,
    name,
    email: email.toLowerCase(),
    password_hash: hashPassword(password),
    role,
    department,
    phone,
    verticals,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp
  });
  return created._id;
}

async function ensureDefaultUser({ name, email, password, role, department = 'Planning', phone = '', verticals = '' }) {
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    // Never reactivate or overwrite an existing account during application startup.
    // Account status changes must remain under explicit Admin control.
    return existing._id;
  }
  return insertUser({ name, email, password, role, department, phone, verticals });
}

async function migrateDefaultBDUser() {
  const timestamp = now();
  const bdEmail = 'bd@adinn.co.in';
  const oldManagerEmail = 'manager@adinn.co.in';
  const bdUser = await User.findOne({ email: bdEmail });
  const oldManager = await User.findOne({ email: oldManagerEmail });

  if (bdUser) {
    // The migration has already been completed. Preserve the account exactly as
    // the Admin left it, including an inactive status.
    return bdUser._id;
  }

  if (oldManager) {
    oldManager.name = 'Business Developer';
    oldManager.email = bdEmail;
    oldManager.password_hash = hashPassword('BD@123');
    oldManager.role = 'manager';
    oldManager.department = 'Planning';
    oldManager.updated_at = timestamp;
    await oldManager.save();
    return oldManager._id;
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
    throw new Error('MONGODB_URI is missing. Create a MongoDB Atlas database and add MONGODB_URI in backend/.env or Render environment variables.');
  }
  await mongoose.connect(connectionString);
  await Promise.all([
    User.syncIndexes(),
    Task.syncIndexes(),
    TaskPlannerAssignment.syncIndexes(),
    TaskComment.syncIndexes(),
    TaskFile.syncIndexes(),
    TaskStatusHistory.syncIndexes(),
    TaskDecline.syncIndexes(),
    Notification.syncIndexes()
  ]);
  await seedDefaultUsers();
}

module.exports = {
  mongoose,
  initDb,
  now,
  hashPassword,
  addHistory,
  generateTaskCode,
  withTransaction,
  nextId,
  Counter,
  User,
  Task,
  TaskPlannerAssignment,
  TaskComment,
  TaskFile,
  TaskStatusHistory,
  TaskDecline,
  Notification
};
