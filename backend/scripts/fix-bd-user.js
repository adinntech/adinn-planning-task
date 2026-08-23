const { initDb, query, one, hashPassword, now, pool } = require('../src/database');

async function main() {
  await initDb();
  const timestamp = now();
  const oldManager = await one('SELECT * FROM users WHERE email = $1', ['manager@adinn.co.in']);
  const bd = await one('SELECT * FROM users WHERE email = $1', ['bd@adinn.co.in']);

  if (oldManager && !bd) {
    await query(
      `UPDATE users SET name = $1, email = $2, password_hash = $3, role = 'manager', department = 'Planning', status = 'active', updated_at = $4 WHERE id = $5`,
      ['Business Developer', 'bd@adinn.co.in', hashPassword('BD@123'), timestamp, oldManager.id]
    );
  }

  if (bd) {
    await query(
      `UPDATE users SET name = 'Business Developer', password_hash = $1, role = 'manager', department = 'Planning', status = 'active', updated_at = $2 WHERE id = $3`,
      [hashPassword('BD@123'), timestamp, bd.id]
    );
  }

  if (oldManager && bd) {
    await query('UPDATE users SET status = $1, updated_at = $2 WHERE id = $3', ['inactive', timestamp, oldManager.id]);
  }

  console.log('BD user verified. Login: bd@adinn.co.in / BD@123');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
