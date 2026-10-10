/** Utilitários de instalação. Uso: node apps/api/dist/cli.js create-operator <email> "<nome>"  (senha em NEXO_NEW_PASSWORD) */
import { hashPassword } from './auth.js';
import { closePool, withScope } from './db.js';
import pg from 'pg';
import { env } from './env.js';
import { migrate } from './migrate.js';
import { decryptSecret, encryptSecret, needsRotation } from './network/crypto.js';

const [cmd, email, name] = process.argv.slice(2);
if (cmd === 'migrate') {
  await migrate();
} else if (cmd === 'create-operator') {
  const pw = process.env.NEXO_NEW_PASSWORD ?? '';
  if (!email || !name || pw.length < 12) {
    console.error('uso: NEXO_NEW_PASSWORD=<senha com 12+ caracteres> cli.js create-operator <email> "<nome>"');
    process.exit(1);
  }
  await withScope({ tenantId: null, operator: true }, (c) =>
    c.query(`insert into users (email, name, password_hash, role) values ($1,$2,$3,'saas_operator')
             on conflict (lower(email)) do update set password_hash = excluded.password_hash, active = true`, [email, name, hashPassword(pw)]));
  console.log(`operador ${email} criado/atualizado`);
  await closePool();
} else if (cmd === 'rotate-secrets') {
  // Rotação de NEXO_SECRET_KEY: defina a chave nova em NEXO_SECRET_KEY e a antiga em NEXO_SECRET_KEY_PREVIOUS, rode este comando
  // e, com "0 pendente(s)", remova NEXO_SECRET_KEY_PREVIOUS. Usa o papel dono (manutenção), em uma única transação.
  const c = new pg.Client({ connectionString: env.dbOwner() });
  await c.connect();
  await c.query('begin');
  let done = 0, pending = 0;
  for (const [table, col] of [['service_resources', 'secret_enc'], ['users', 'mfa_secret_enc']] as const) {
    for (const r of (await c.query(`select id, ${col} as v from ${table} where ${col} is not null for update`)).rows) {
      if (!needsRotation(r.v)) continue;
      await c.query(`update ${table} set ${col} = $2 where id = $1`, [r.id, encryptSecret(decryptSecret(r.v))]);
      done++;
    }
    pending += (await c.query(`select ${col} as v from ${table} where ${col} is not null`)).rows.filter((r) => needsRotation(r.v)).length;
  }
  await c.query(`insert into audit_events (actor_type, actor_id, action, detail) values ('system','cli','secrets.rotate',$1)`, [JSON.stringify({ reencrypted: done })]);
  await c.query('commit');
  await c.end();
  console.log(`segredos recifrados com a chave atual: ${done}; ${pending} pendente(s)`);
} else {
  console.error('comandos: rotate-secrets | migrate | create-operator <email> "<nome>"');
  process.exit(1);
}
