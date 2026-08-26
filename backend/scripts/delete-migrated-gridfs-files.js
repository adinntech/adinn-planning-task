// Deletes the original MongoDB GridFS files (bucket: task_attachments) for
// TaskFile records that have already been migrated to DigitalOcean Spaces by
// migrate-gridfs-to-space.js.
//
// A migrated record looks like: storage_provider: 'space' but gridfs_id is
// still set (migrate-gridfs-to-space.js deliberately leaves it as a pointer
// to the old file instead of deleting it right away). This script is the
// deliberate second step that actually frees up task_attachments.chunks.
//
// Safety: for every candidate, this script first confirms the Spaces object
// named in file_path actually exists (HEAD request) before touching GridFS.
// If the Spaces copy is missing for any reason, that record is skipped and
// reported instead of deleting its only remaining copy.
//
// Usage:
//   node scripts/delete-migrated-gridfs-files.js              (dry run: list only, no changes)
//   node scripts/delete-migrated-gridfs-files.js --confirm     (actually delete GridFS originals)
//
// This script does nothing on its own -- it only runs when invoked manually.

const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { initDb, TaskFile, mongoose } = require('../src/database');

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

function parseArgs(argv) {
  return { confirm: argv.includes('--confirm') };
}

async function spaceObjectExists(key) {
  try {
    const head = await spacesClient.send(new HeadObjectCommand({ Bucket: DO_SPACES_BUCKET, Key: key }));
    return { exists: true, size: head.ContentLength };
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404 || error.name === 'NotFound') return { exists: false };
    throw error;
  }
}

async function main() {
  const { confirm } = parseArgs(process.argv.slice(2));
  await initDb();

  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'task_attachments' });

  const candidates = await TaskFile.find({ storage_provider: 'space', gridfs_id: { $ne: null } }).lean();
  console.log(`Found ${candidates.length} migrated record(s) still holding a GridFS original.`);

  if (candidates.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const verified = [];
  const missingInSpace = [];
  for (const fileDoc of candidates) {
    const check = await spaceObjectExists(fileDoc.file_path);
    if (check.exists) verified.push({ fileDoc, size: check.size });
    else missingInSpace.push(fileDoc);
  }

  console.log(`Verified in Spaces: ${verified.length}`);
  if (missingInSpace.length) {
    console.log(`Skipping ${missingInSpace.length} record(s) whose Spaces object is missing (their GridFS original is their only copy -- left alone):`);
    missingInSpace.forEach((f) => console.log(`  - task=${f.task_id} file="${f.file_name}" file_path=${f.file_path}`));
  }

  if (verified.length === 0) {
    console.log('Nothing safe to delete.');
    return;
  }

  if (!confirm) {
    verified.slice(0, 20).forEach(({ fileDoc, size }) => {
      console.log(`  - task=${fileDoc.task_id} file="${fileDoc.file_name}" gridfs_id=${fileDoc.gridfs_id} (Spaces copy: ${size} bytes)`);
    });
    if (verified.length > 20) console.log(`  ... and ${verified.length - 20} more.`);
    console.log('Dry run only: no changes made. Re-run with --confirm to delete these GridFS originals.');
    return;
  }

  let deleted = 0;
  for (const { fileDoc } of verified) {
    try {
      await bucket.delete(fileDoc.gridfs_id);
    } catch (error) {
      // Already gone is fine; anything else, report and move on without
      // clearing gridfs_id so it can be investigated.
      if (!String(error.message).includes('File not found')) {
        console.error(`  ! failed to delete GridFS file for task=${fileDoc.task_id} file="${fileDoc.file_name}": ${error.message}`);
        continue;
      }
    }
    await TaskFile.updateOne({ _id: fileDoc._id }, { $set: { gridfs_id: null } });
    deleted += 1;
  }

  console.log(`Deleted ${deleted}/${verified.length} GridFS original(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
