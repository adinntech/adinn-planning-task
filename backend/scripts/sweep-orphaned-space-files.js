// Finds DigitalOcean Spaces objects under task-attachments/ that have no
// matching TaskFile record in MongoDB (storage_provider: 'space') -- true
// orphans, e.g. left behind if a delete failed silently after a task/user was
// removed. Never touches objects that ARE referenced by a TaskFile record, so
// legitimate task attachments -- and the tasks/comments/history around them,
// which live in entirely separate collections this script never reads -- are
// always left alone.
//
// Usage:
//   node scripts/sweep-orphaned-space-files.js                  (list orphans only, no changes)
//   node scripts/sweep-orphaned-space-files.js --delete          (delete the orphans found)
//   node scripts/sweep-orphaned-space-files.js --min-age-hours=48 --delete
//
// Objects newer than --min-age-hours (default 24) are skipped even if they
// look orphaned, since a Spaces upload can briefly exist a few seconds before
// its TaskFile DB record is committed.
//
// This script does nothing on its own -- it only runs when invoked manually.

const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { initDb, TaskFile, mongoose } = require('../src/database');

const DO_SPACES_BUCKET = process.env.DO_SPACES_BUCKET || 'adinn-space';
const DO_SPACES_REGION = process.env.DO_SPACES_REGION || 'sgp1';
const DO_SPACES_ENDPOINT = process.env.DO_SPACES_ENDPOINT || 'https://sgp1.digitaloceanspaces.com';
const PREFIX = 'task-attachments/';

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
  const args = { delete: false, minAgeHours: 24 };
  for (const arg of argv) {
    if (arg === '--delete') args.delete = true;
    else if (arg.startsWith('--min-age-hours=')) args.minAgeHours = Number(arg.split('=')[1]) || 24;
  }
  return args;
}

async function listAllSpaceObjects() {
  const objects = [];
  let continuationToken;
  do {
    const response = await spacesClient.send(new ListObjectsV2Command({
      Bucket: DO_SPACES_BUCKET,
      Prefix: PREFIX,
      ContinuationToken: continuationToken
    }));
    objects.push(...(response.Contents || []));
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

async function deleteObjects(keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await spacesClient.send(new DeleteObjectsCommand({
      Bucket: DO_SPACES_BUCKET,
      Delete: { Objects: batch.map((Key) => ({ Key })) }
    }));
  }
}

async function main() {
  const { delete: shouldDelete, minAgeHours } = parseArgs(process.argv.slice(2));
  await initDb();

  const [spaceObjects, referencedFiles] = await Promise.all([
    listAllSpaceObjects(),
    TaskFile.find({ storage_provider: 'space' }).select('file_path').lean()
  ]);

  const referencedKeys = new Set(referencedFiles.map((f) => f.file_path));
  const cutoff = Date.now() - minAgeHours * 60 * 60 * 1000;

  const orphans = spaceObjects.filter((obj) => (
    !referencedKeys.has(obj.Key) && new Date(obj.LastModified).getTime() < cutoff
  ));

  console.log(`Scanned ${spaceObjects.length} object(s) under '${PREFIX}' in bucket '${DO_SPACES_BUCKET}'.`);
  console.log(`Referenced by TaskFile records: ${referencedKeys.size}.`);
  console.log(`Orphaned (unreferenced + older than ${minAgeHours}h): ${orphans.length}.`);

  if (orphans.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  orphans.slice(0, 20).forEach((obj) => {
    console.log(`  - ${obj.Key} (${obj.Size} bytes, last modified ${obj.LastModified.toISOString()})`);
  });
  if (orphans.length > 20) console.log(`  ... and ${orphans.length - 20} more.`);

  if (!shouldDelete) {
    console.log('List only: no changes made. Re-run with --delete to remove these objects.');
    return;
  }

  await deleteObjects(orphans.map((obj) => obj.Key));
  console.log(`Deleted ${orphans.length} orphaned object(s) from Spaces.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
