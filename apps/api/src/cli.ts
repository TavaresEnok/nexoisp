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
} else if (cmd === 'preflight') {
  // Conferência antes de entrar em produção. FALHA impede a entrada; AVISO é uma decisão que alguém precisa ter tomado.
  // Não altera nada. Sai com código 1 se houver falha.
  const { existsSync, readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const c = new pg.Client({ connectionString: env.dbOwner() });
  await c.connect();
  const n = async (sql: string) => Number((await c.query(sql)).rows[0].n);
  const out: [string, string, string][] = [];
  const fail = (ok: boolean, what: string, how: string) => out.push([ok ? 'ok   ' : 'FALHA', what, ok ? '' : how]);
  const warn = (ok: boolean, what: string, how: string) => out.push([ok ? 'ok   ' : 'AVISO', what, ok ? '' : how]);
  const e = process.env;
  fail(e.NEXO_DEMO_MODE !== '1', 'modo demonstração desligado', 'NEXO_DEMO_MODE=1 cria contas e integrações simuladas');
  fail(e.NEXO_REQUIRE_ADMIN_MFA === '1', 'verificação em duas etapas obrigatória para administradores', 'defina NEXO_REQUIRE_ADMIN_MFA=1');
  fail(e.NEXO_COOKIE_SECURE === '1', 'cookie de sessão só por HTTPS', 'defina NEXO_COOKIE_SECURE=1');
  fail(!!e.NEXO_SECRET_KEY && !!e.NEXO_OP_SIGNING_KEY, 'chaves de cifra e de assinatura definidas', 'NEXO_SECRET_KEY e NEXO_OP_SIGNING_KEY são obrigatórias');
  warn(!e.NEXO_SECRET_KEY_PREVIOUS, 'nenhuma rotação de chave em andamento', 'NEXO_SECRET_KEY_PREVIOUS ainda definida: conclua a rotação');
  const tls = e.NEXO_AGENT_TLS_DIR ?? '';
  fail(!!tls && ['ca.crt', 'server.crt', 'server.key'].every((f) => existsSync(`${tls}/${f}`)), 'certificados da API de agentes presentes', `faltam ca.crt, server.crt ou server.key em ${tls || 'NEXO_AGENT_TLS_DIR'}`);
  warn(!!e.NEXO_ALERT_WEBHOOK_URL, 'alerta de rede por webhook configurado', 'sem NEXO_ALERT_WEBHOOK_URL os alertas ficam só no log e no painel');
  const files = readdirSync(fileURLToPath(new URL('../migrations', import.meta.url))).filter((f) => f.endsWith('.sql')).length;
  fail(await n('select count(*) as n from schema_migrations') === files, 'migrations aplicadas', 'há migration pendente: rode cli.js migrate');
  fail(await n(`select count(*) as n from users where email ilike '%.demo'`) === 0, 'nenhuma conta de demonstração', 'existem usuários @*.demo: este banco recebeu dados sintéticos');
  fail(await n(`select count(*) as n from devices where driver in ('demo','olt_demo')`) === 0, 'nenhum equipamento simulado', 'há equipamento com driver de demonstração');
  fail(await n(`select count(*) as n from tenant_settings where gateway = 'demo'`) === 0, 'nenhum provedor com gateway de demonstração', 'gateway "demo" não movimenta dinheiro');
  fail(await n(`select count(*) as n from users where role = 'saas_operator' and active`) > 0, 'existe operador do SaaS', 'crie com cli.js create-operator');
  warn(await n(`select count(*) as n from users where role in ('saas_operator','admin') and active and not mfa_enabled`) === 0, 'todos os administradores já ativaram a verificação em duas etapas', 'há administrador que ainda não entrou para ativar (ele fica bloqueado até ativar)');
  warn(await n(`select count(*) as n from tenants t where t.status = 'active' and not exists (select 1 from tenant_settings s where s.tenant_id = t.id and s.gateway <> 'none')`) === 0, 'todo provedor tem gateway de pagamento', 'provedor sem gateway: o NexoISP não emite cobrança para ele (aceitável só se a cobrança continuar no sistema anterior)');
  warn(await n(`select count(*) as n from tenant_settings where auto_suspend`) === 0, 'suspensão automática desligada', 'há provedor com suspensão automática ligada: confirme que a política foi aprovada por ele');
  warn(await n(`select count(*) as n from tenants where 'olt' = any(modules)`) === 0, 'módulo de OLT desligado', 'driver Huawei não homologado em equipamento real está liberado para algum provedor');
  warn(await n(`select count(*) as n from agents where status = 'active' and (last_seen_at is null or last_seen_at < now() - interval '2 minutes')`) === 0, 'agentes ativos estão conectados', 'há agente cadastrado que não está se comunicando');
  warn(await n(`select count(*) as n from agents where status = 'active' and cert_fingerprint is null`) === 0, 'certificado de cada agente já fixado', 'há agente que ainda não apresentou certificado');
  fail(await n(`select count(*) as n from operations where status = 'UNCERTAIN'`) === 0, 'nenhuma operação de rede com resultado incerto', 'resolva as operações incertas antes do corte');
  await c.end();
  for (const [st, what, how] of out) console.log(`${st}  ${what}${how ? `\n       -> ${how}` : ''}`);
  const fails = out.filter((o) => o[0] === 'FALHA').length, warns = out.filter((o) => o[0] === 'AVISO').length;
  console.log(`\n${fails} falha(s), ${warns} aviso(s). ${fails ? 'NÃO entre em produção com falhas.' : 'Sem falhas de configuração; isto não substitui a homologação no equipamento nem o ensaio do ciclo completo.'}`);
  process.exit(fails ? 1 : 0);
} else {
  console.error('comandos: preflight | rotate-secrets | migrate | create-operator <email> "<nome>"');
  process.exit(1);
}
