const { initDb, User, hashPassword, now, mongoose } = require('../src/database');

async function main() {
  await initDb();
  const timestamp = now();
  const oldManager = await User.findOne({ email: 'manager@adinn.co.in' });
  const bd = await User.findOne({ email: 'bd@adinn.co.in' });

  if (oldManager && !bd) {
    oldManager.name = 'Business Developer';
    oldManager.email = 'bd@adinn.co.in';
    oldManager.password_hash = hashPassword('BD@123');
    oldManager.role = 'manager';
    oldManager.department = 'Planning';
    oldManager.status = 'active';
    oldManager.updated_at = timestamp;
    await oldManager.save();
  }

  if (bd) {
    bd.name = 'Business Developer';
    bd.password_hash = hashPassword('BD@123');
    bd.role = 'manager';
    bd.department = 'Planning';
    bd.status = 'active';
    bd.updated_at = timestamp;
    await bd.save();
  }

  if (oldManager && bd) {
    oldManager.status = 'inactive';
    oldManager.updated_at = timestamp;
    await oldManager.save();
  }

  console.log('BD user verified. Login: bd@adinn.co.in / BD@123');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
