// Archives then deletes stale notifications, in one of two modes:
//
//   Cap mode (--keep, recommended): for each user, keeps only their most
//   recent N notifications (matches what GET /api/notifications can ever
//   return, since that route has no pagination past its limit=500 cap) and
//   archives+deletes the rest, regardless of read/unread state — anything
//   beyond the cap is already unreachable through the UI.
//
//   Date mode (default): archives+deletes read notifications older than a
//   cutoff (default 30 days). Unread notifications are never touched.
//
// Usage:
//   node scripts/cleanup-notifications.js --keep=500 --dry-run   (preview cap mode)
//   node scripts/cleanup-notifications.js --keep=500              (run cap mode)
//   node scripts/cleanup-notifications.js --dry-run               (preview date mode, 30 days)
//   node scripts/cleanup-notifications.js --days=60                (date mode, custom cutoff)
//
// This script does nothing on its own — it only runs when invoked manually.

const { initDb, Notification, mongoose } = require('../src/database');

function parseArgs(argv) {
  const args = { dryRun: false, days: 30, keep: null };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--days=')) args.days = Number(arg.split('=')[1]) || 30;
    else if (arg.startsWith('--keep=')) args.keep = Number(arg.split('=')[1]) || 0;
  }
  return args;
}

async function findExcessPerUser(keep) {
  const userIds = await Notification.distinct('user_id');
  const excess = [];
  for (const userId of userIds) {
    const overflow = await Notification.find({ user_id: userId })
      .sort({ created_at: -1 })
      .skip(keep)
      .lean();
    excess.push(...overflow);
  }
  return excess;
}

async function archiveAndDelete(toRemove) {
  await mongoose.connection.collection('notifications_archive').insertMany(toRemove, { ordered: false });
  const ids = toRemove.map((doc) => doc._id);
  const result = await Notification.deleteMany({ _id: { $in: ids } });
  console.log(`Archived ${toRemove.length} notification(s) into 'notifications_archive'.`);
  console.log(`Deleted ${result.deletedCount} notification(s) from 'notifications'.`);
}

async function main() {
  const { dryRun, days, keep } = parseArgs(process.argv.slice(2));
  await initDb();

  let toRemove;
  if (keep !== null) {
    toRemove = await findExcessPerUser(keep);
    console.log(`Found ${toRemove.length} notification(s) beyond the latest ${keep} per user.`);
  } else {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    toRemove = await Notification.find({ is_read: true, created_at: { $lt: cutoff } }).lean();
    console.log(`Found ${toRemove.length} read notification(s) older than ${days} day(s) (before ${cutoff}).`);
  }

  if (toRemove.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (dryRun) {
    console.log('Dry run: no changes made. Re-run without --dry-run to archive and delete these.');
    return;
  }

  await archiveAndDelete(toRemove);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
