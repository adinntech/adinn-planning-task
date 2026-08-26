// Automated storage housekeeping, run on a daily schedule inside this same
// server process (no separate worker/infra exists for this app).
//
//   1. Notification cleanup: archives (into notifications_archive) then
//      deletes READ notifications older than NOTIFICATION_RETENTION_DAYS.
//      Unread notifications are never touched, so nothing a user hasn't
//      seen yet disappears, and the frontend's date-sort/pagination over
//      the remaining notifications is unaffected -- it just has fewer old,
//      already-read rows to sort through.
//
//   2. Attachment cleanup: for TaskFile records on storage_provider 'space'
//      older than ATTACHMENT_RETENTION_DAYS, deletes the Spaces object and
//      the TaskFile record, and adds a task history entry noting the
//      removal so it isn't a silent disappearance. Only 'space' files are
//      targeted -- GridFS/local/supabase legacy records are left alone.
//      If the Spaces delete fails, the DB record is left in place so nothing
//      is lost track of.
//
// Both retention windows are configurable via env vars so they can be tuned
// without a code change: NOTIFICATION_RETENTION_DAYS (default 2),
// ATTACHMENT_RETENTION_DAYS (default 60).

const cron = require('node-cron');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { TaskFile, Notification, addHistory, mongoose } = require('./database');

const DO_SPACES_BUCKET = process.env.DO_SPACES_BUCKET || 'adinn-space';
const DO_SPACES_REGION = process.env.DO_SPACES_REGION || 'sgp1';
const DO_SPACES_ENDPOINT = process.env.DO_SPACES_ENDPOINT || 'https://sgp1.digitaloceanspaces.com';

const spacesClient = new S3Client({
  region: DO_SPACES_REGION,
  endpoint: DO_SPACES_ENDPOINT,
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET
  },
  forcePathStyle: false
});

const NOTIFICATION_RETENTION_DAYS = Number(process.env.NOTIFICATION_RETENTION_DAYS) || 2;
const ATTACHMENT_RETENTION_DAYS = Number(process.env.ATTACHMENT_RETENTION_DAYS) || 60;
const CRON_TIMEZONE = 'Asia/Kolkata';

async function cleanupOldNotifications() {
  const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const toRemove = await Notification.find({ is_read: true, created_at: { $lt: cutoff } }).lean();
  if (toRemove.length === 0) {
    console.log(`[cron] notification cleanup: nothing read + older than ${NOTIFICATION_RETENTION_DAYS}d`);
    return;
  }
  await mongoose.connection.collection('notifications_archive').insertMany(toRemove, { ordered: false });
  const ids = toRemove.map((doc) => doc._id);
  const result = await Notification.deleteMany({ _id: { $in: ids } });
  console.log(`[cron] notification cleanup: archived+deleted ${result.deletedCount} read notification(s) older than ${NOTIFICATION_RETENTION_DAYS}d`);
}

async function cleanupOldAttachments() {
  const cutoff = new Date(Date.now() - ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const candidates = await TaskFile.find({ storage_provider: 'space', created_at: { $lt: cutoff } }).lean();
  if (candidates.length === 0) {
    console.log(`[cron] attachment cleanup: nothing on Spaces older than ${ATTACHMENT_RETENTION_DAYS}d`);
    return;
  }

  let deleted = 0;
  for (const file of candidates) {
    try {
      await spacesClient.send(new DeleteObjectCommand({ Bucket: DO_SPACES_BUCKET, Key: file.file_path }));
    } catch (error) {
      console.error(`[cron] attachment cleanup: failed to delete Spaces object for file ${file._id} (task ${file.task_id}): ${error.message}`);
      continue;
    }
    await TaskFile.deleteOne({ _id: file._id });
    await addHistory(
      file.task_id,
      file.user_id,
      'File auto-removed',
      null,
      null,
      `"${file.file_name}" was automatically removed after ${ATTACHMENT_RETENTION_DAYS} days (storage policy)`
    );
    deleted += 1;
  }
  console.log(`[cron] attachment cleanup: removed ${deleted}/${candidates.length} file(s) older than ${ATTACHMENT_RETENTION_DAYS}d`);
}

function scheduleCronJobs() {
  cron.schedule('0 2 * * *', () => {
    cleanupOldNotifications().catch((error) => console.error('[cron] notification cleanup failed', error));
  }, { timezone: CRON_TIMEZONE });

  cron.schedule('5 2 * * *', () => {
    cleanupOldAttachments().catch((error) => console.error('[cron] attachment cleanup failed', error));
  }, { timezone: CRON_TIMEZONE });

  console.log(`[cron] scheduled: notification cleanup daily 02:00 ${CRON_TIMEZONE} (>${NOTIFICATION_RETENTION_DAYS}d read), attachment cleanup daily 02:05 ${CRON_TIMEZONE} (>${ATTACHMENT_RETENTION_DAYS}d on Spaces)`);
}

module.exports = { scheduleCronJobs, cleanupOldNotifications, cleanupOldAttachments };
