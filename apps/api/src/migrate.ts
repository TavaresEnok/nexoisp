import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from './env.js';

/** Aplica migrations com o papel dono do schema. A aplicação usa nexo_app (sem BYPASSRLS). */
export async function migrate(log: (m: string) => void = console.log) {
  const c = new pg.Client({ connectionString: env.dbOwner() });
  await c.connect();
  try {
    await c.query('select pg_advisory_lock(7411001)');
    const pw = env.appDbPassword().replace(/'/g, "''");
    const role = await c.query(`select 1 from pg_roles where rolname = 'nexo_app'`);
    await c.query(
      `${role.rowCount ? 'alter' : 'create'} role nexo_app login nosuperuser nobypassrls nocreatedb nocreaterole password '${pw}'`,
    );
    // papel do servidor RADIUS integrado: só alcança as tabelas radius_* (concedido na migration). Sem senha definida, fica sem login.
    const rpw = process.env.NEXO_RADIUS_DB_PASSWORD?.replace(/'/g, "''");
    const rrole = await c.query(`select 1 from pg_roles where rolname = 'nexo_radius'`);
    // sem a variável, um papel já existente não é tocado (o mesmo servidor de banco pode atender outra instância que o usa)
    if (!rrole.rowCount) await c.query('create role nexo_radius nologin nosuperuser nobypassrls nocreatedb nocreaterole');
    if (rpw) await c.query(`alter role nexo_radius login password '${rpw}'`);
    await c.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const dir = fileURLToPath(new URL('../migrations', import.meta.url));
    const done = new Set((await c.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      log(`migration ${f}`);
      await c.query('begin');
      try {
        await c.query(readFileSync(`${dir}/${f}`, 'utf8'));
        await c.query('insert into schema_migrations (name) values ($1)', [f]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
  } finally {
    await c.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  migrate().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
