// Migrates task attachments stored in MongoDB GridFS (bucket: task_attachments)
// to DigitalOcean Spaces, so the task_attachments.chunks collection can
// eventually be emptied out.
//
// For every TaskFile with storage_provider: 'gridfs':
//   1. Stream the file out of GridFS.
//   2. Upload it to Spaces under the same key layout as new uploads
//      (see uploadSpaceFile() in src/server.js).
//   3. Verify the uploaded object's size matches what was streamed.
//   4. Flip the TaskFile record to storage_provider: 'space' with the new
//      file_path -- but leave gridfs_id in place as a pointer to the
//      original, untouched GridFS file.
//
// This script NEVER deletes anything from GridFS. That is a deliberate,
// separate step (see delete-migrated-gridfs-files.js) so the migration can be
// verified before any original data is removed. If anything fails partway
// (a bad connection, an interrupted run), already-migrated records are simply
// skipped on the next run, and any GridFS data for records not yet flipped to
// 'space' is untouched.
//
// Usage:
//   node scripts/migrate-gridfs-to-space.js                 (dry run: list only, no changes)
//   node scripts/migrate-gridfs-to-space.js --migrate        (actually migrate everything)
//   node scripts/migrate-gridfs-to-space.js --migrate --limit=20     (migrate only the first 20, for a test run)
//   node scripts/migrate-gridfs-to-space.js --migrate --task-id=123  (migrate only files for one task)
//
// This script does nothing on its own -- it only runs when invoked manually.

const path = require('path');
const { S3Client, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { initDb, TaskFile, User, mongoose } = require('../src/database');

const DO_SPACES_BUCKET = process.env.DO_SPACES_BUCKET || 'adinn-space';
const DO_SPACES_REGION = process.env.DO_SPACES_REGION || 'sgp1';
const DO_SPACES_ENDPOINT = process.env.DO_SPACES_ENDPOINT || 'https://sgp1.digitaloceanspaces.com';
const CONCURRENCY = 3;

const spacesClient = new S3Client({
  region: DO_SPACES_REGION,
  endpoint: DO_SPACES_ENDPOINT,
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET
  },
  forcePathStyle: false
});

function parseArgs(argv) {
  const args = { migrate: false, limit: null, taskId: null };
  for (const arg of argv) {
    if (arg === '--migrate') args.migrate = true;
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.split('=')[1]) || null;
    else if (arg.startsWith('--task-id=')) args.taskId = Number(arg.split('=')[1]);
  }
  return args;
}

function safeName(originalName) {
  return path.basename(originalName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function uploaderFolder(user) {
  const safeUploaderName = String(user?.name || 'user')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'user';
  return `${safeUploaderName}-${user?._id ?? 'unknown'}`;
}

function buildKey(fileDoc, user) {
  return `Adinn-planning-task-attachments/${uploaderFolder(user)}/${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName(fileDoc.file_name)}`;
}

async function runPool(items, worker, concurrency) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = { status: 'ok', value: await worker(items[current], current) };
      } catch (error) {
        results[current] = { status: 'error', error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

async function migrateOne(fileDoc, usersById, bucket) {
  const objectId = fileDoc.gridfs_id;
  const downloadStream = bucket.openDownloadStream(objectId);
  let bytes = 0;
  downloadStream.on('data', (chunk) => { bytes += chunk.length; });

  const user = usersById.get(fileDoc.user_id);
  const key = buildKey(fileDoc, user);

  const upload = new Upload({
    client: spacesClient,
    params: {
      Bucket: DO_SPACES_BUCKET,
      Key: key,
      Body: downloadStream,
      ContentType: fileDoc.file_type || 'application/octet-stream',
      ACL: 'public-read'
    },
    queueSize: 4,
    partSize: 10 * 1024 * 1024
  });
  await upload.done();

  const head = await spacesClient.send(new HeadObjectCommand({ Bucket: DO_SPACES_BUCKET, Key: key }));
  const sizeMismatch = head.ContentLength !== bytes
    || (fileDoc.file_size && head.ContentLength !== fileDoc.file_size);
  if (sizeMismatch) {
    await spacesClient.send(new DeleteObjectCommand({ Bucket: DO_SPACES_BUCKET, Key: key })).catch(() => {});
    throw new Error(
      `size mismatch (streamed ${bytes}, uploaded ${head.ContentLength}, expected ${fileDoc.file_size}) -- left original GridFS file untouched, deleted the bad Spaces copy`
    );
  }

  await TaskFile.updateOne(
    { _id: fileDoc._id, storage_provider: 'gridfs' },
    { $set: { storage_provider: 'space', file_path: key } }
  );

  return { key, bytes };
}

async function main() {
  const { migrate, limit, taskId } = parseArgs(process.argv.slice(2));
  await initDb();

  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'task_attachments' });

  const query = { storage_provider: 'gridfs' };
  if (taskId) query.task_id = taskId;

  let candidates = await TaskFile.find(query).lean();
  const missingGridfsId = candidates.filter((f) => !f.gridfs_id);
  candidates = candidates.filter((f) => f.gridfs_id);
  if (limit) candidates = candidates.slice(0, limit);

  console.log(`Found ${candidates.length + missingGridfsId.length} TaskFile record(s) with storage_provider: 'gridfs'.`);
  if (missingGridfsId.length) {
    console.log(`  ${missingGridfsId.length} of them have no gridfs_id (already broken/unavailable) -- skipping, nothing to migrate.`);
  }
  console.log(`${candidates.length} file(s) queued for migration${limit ? ` (limited to ${limit})` : ''}${taskId ? ` for task ${taskId}` : ''}.`);

  if (candidates.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const totalBytes = candidates.reduce((sum, f) => sum + (f.file_size || 0), 0);
  console.log(`Total size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB.`);

  if (!migrate) {
    candidates.slice(0, 20).forEach((f) => {
      console.log(`  - task=${f.task_id} file="${f.file_name}" (${((f.file_size || 0) / 1024).toFixed(0)} KB) gridfs_id=${f.gridfs_id}`);
    });
    if (candidates.length > 20) console.log(`  ... and ${candidates.length - 20} more.`);
    console.log('Dry run only: no changes made. Re-run with --migrate to actually copy these to Spaces.');
    return;
  }

  const userIds = [...new Set(candidates.map((f) => f.user_id))];
  const users = await User.find({ _id: { $in: userIds } }).select('name').lean();
  const usersById = new Map(users.map((u) => [u._id, u]));

  let done = 0;
  const results = await runPool(candidates, async (fileDoc) => {
    const result = await migrateOne(fileDoc, usersById, bucket);
    done += 1;
    console.log(`[${done}/${candidates.length}] migrated task=${fileDoc.task_id} file="${fileDoc.file_name}" -> ${result.key}`);
    return result;
  }, CONCURRENCY);

  const succeeded = results.filter((r) => r.status === 'ok');
  const failed = results.filter((r) => r.status === 'error');

  console.log('');
  console.log(`Migrated: ${succeeded.length}/${candidates.length}`);
  if (failed.length) {
    console.log(`Failed: ${failed.length} (original GridFS files for these were left untouched)`);
    failed.forEach((r, i) => {
      const fileDoc = candidates[results.indexOf(r)];
      console.log(`  - task=${fileDoc?.task_id} file="${fileDoc?.file_name}": ${r.error.message}`);
    });
  }
  console.log('');
  console.log('GridFS originals were NOT deleted. Once you have verified the migrated');
  console.log('files open correctly in the app, run delete-migrated-gridfs-files.js to');
  console.log('free up task_attachments.chunks.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
