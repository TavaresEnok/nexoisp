import { closePool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { seedDemo } from '../src/seed.js';

export default async function setup() {
  if (!process.env.DATABASE_URL_APP?.endsWith('/nexo_test')) throw new Error('testes exigem o banco nexo_test (use ./nexo test)');
  await migrate(() => {});
  await seedDemo(() => {});
  await closePool();
}
