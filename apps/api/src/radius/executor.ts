import { randomBytes } from 'node:crypto';
import { HttpError, sha256 } from '../auth.js';
import { noScope, withScope, type Tx } from '../db.js';
import { begin, progress, reserve, result } from '../network/engine.js';
import { sendDisconnect, type DisconnectResult } from './coa.js';
import { checkRows, effectiveProfile, ipoeLeaseSeconds, replyRows, SESSION_GONE_CAUSES, type Row, type Vendor, type Wanted } from './vendor.js';

/**
 * RADIUS integrado: o NexoISP executa as operações de rede por conta própria, gravando no banco que o servidor RADIUS lê e
 * pedindo a desconexão ao concentrador pelo próprio protocolo. Usa a MESMA fila e as mesmas regras do agente local
 * (reserva, posse, versão da intenção, evidências), só que quem "é o agente" é este processo.
 */
export const INTERNAL_AGENT_VERSION = '99.0.0';        // entende todos os campos do envelope
export const INTERNAL_AGENT_NAME = 'RADIUS integrado';
const SYS = (tenantId: string) => ({ tenantId, operator: false });
const now = () => new Date().toISOString();

/** Chave que cifra as senhas PPPoE no banco. A mesma precisa estar no servidor RADIUS, que é o único que as lê. */
export function radiusKey(): string {
  const k = process.env.NEXO_RADIUS_KEY ?? '';
  if (!/^[A-Za-z0-9_-]{24,}$/.test(k)) throw new HttpError(503, 'o RADIUS integrado não está configurado neste servidor (NEXO_RADIUS_KEY ausente ou curta)', 'radius_unconfigured');
  return k;
}
export const radiusConfigured = () => /^[A-Za-z0-9_-]{24,}$/.test(process.env.NEXO_RADIUS_KEY ?? '');

/** Um executor interno por provedor, criado na primeira vez que ele cadastra um concentrador no RADIUS integrado. */
export async function ensureInternalAgent(c: Tx, tenantId: string): Promise<string> {
  const a = (await c.query('select id from agents where tenant_id = $1 and internal', [tenantId])).rows[0];
  if (a) return a.id;
  return (await c.query(
    `insert into agents (tenant_id, name, token_hash, version, internal, last_seen_at, sync_session_id, last_sync_at)
     values ($1,$2,$3,$4,true,now(),'interno',now()) returning id`,
    [tenantId, INTERNAL_AGENT_NAME, sha256(randomBytes(32).toString('hex')), INTERNAL_AGENT_VERSION])).rows[0].id;   // token aleatório descartado: ninguém se conecta como este agente
}

// ---------------------------------------------------------------- estado gravado
interface Account { policy: string; profile: string; prev_profile: string | null; by_profile: boolean; applied_version: number; updated_at: Date }
const readAccount = async (c: Tx, tenantId: string, username: string): Promise<Account | null> =>
  (await c.query('select policy, profile, prev_profile, by_profile, applied_version, updated_at from radius_account where tenant_id = $1 and username = $2', [tenantId, username])).rows[0] ?? null;

/** Conta + atributos na mesma transação: o servidor RADIUS nunca lê meia mudança. */
async function applyAccount(c: Tx, tenantId: string, username: string, w: Wanted, version: number, secret: string | undefined, check: Row[], reply: Row[]) {
  const cur = await readAccount(c, tenantId, username);
  const profile = effectiveProfile(w);
  if (!cur && secret === undefined) throw new Error('conta sem credencial no RADIUS e senha não fornecida');
  if (secret !== undefined) {
    await c.query(
      `insert into radius_account (tenant_id, username, secret_enc, policy, profile, prev_profile, by_profile, applied_version, updated_at)
       values ($1,$2,pgp_sym_encrypt($3,$4),$5,$6,null,$7,$8,now())
       on conflict (tenant_id, username) do update set secret_enc = excluded.secret_enc, policy = excluded.policy, by_profile = excluded.by_profile,
         prev_profile = case when radius_account.profile <> excluded.profile then radius_account.profile end,
         profile = excluded.profile, applied_version = excluded.applied_version, updated_at = now()`,
      [tenantId, username, secret, radiusKey(), w.policy, profile, w.policy === 'suspended' && !!w.blockProfile, version]);
  } else {
    await c.query(
      `update radius_account set policy = $3, by_profile = $5, prev_profile = case when profile <> $4 then profile end, profile = $4, applied_version = $6, updated_at = now()
       where tenant_id = $1 and username = $2`, [tenantId, username, w.policy, profile, w.policy === 'suspended' && !!w.blockProfile, version]);
  }
  for (const [table, rows] of [['radius_check', check], ['radius_reply', reply]] as const) {
    await c.query(`delete from ${table} where tenant_id = $1 and username = $2`, [tenantId, username]);
    for (const r of rows) await c.query(`insert into ${table} (tenant_id, username, attribute, op, value) values ($1,$2,$3,$4,$5)`, [tenantId, username, r.attribute, r.op, r.value]);
  }
}

interface OpenSession { id: number; session_id: string; framed_ip: string | null; started_at: Date; calling_station: string | null }
const openSessions = async (c: Tx, tenantId: string, username: string): Promise<OpenSession[]> =>
  (await c.query('select id, session_id, framed_ip, started_at, calling_station from radius_acct where tenant_id = $1 and username = $2 and stopped_at is null order by started_at', [tenantId, username])).rows;

/** A sessão em uso precisa cair para a intenção valer? Mesma regra do agente local. */
function mustDrop(p: any, acc: Account, s: OpenSession): boolean {
  const predates = new Date(s.started_at).getTime() < new Date(acc.updated_at).getTime();
  const sessionProfile = predates ? (acc.prev_profile ?? acc.profile) : acc.profile;      // negociado quando a sessão começou
  if (p.reconnect) return predates;
  if (p.policy === 'suspended') {
    if (p.suspension?.session !== 'disconnect') return false;
    const bp = p.suspension?.mode === 'profile' ? p.suspension.profile : null;
    return bp ? sessionProfile !== bp : true;
  }
  if (p.framed_ip && s.framed_ip && s.framed_ip !== p.framed_ip) return true;
  return sessionProfile !== p.profile;
}

const uptime = (from: Date) => {
  let s = Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400; const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60;
  return `${d ? `${d}d` : ''}${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s}s`;
};
const sessionView = (s: OpenSession | undefined, profile: string) =>
  s ? { online: true, ip: s.framed_ip, caller_id: s.calling_station, uptime: uptime(s.started_at), since: new Date(s.started_at).toISOString(), profile } : null;

// ---------------------------------------------------------------- execução de uma operação
async function executeOne(tenantId: string, agentId: string, d: { attempt_id: string; envelope: string }, drop: typeof sendDisconnect) {
  const env = JSON.parse(d.envelope);
  const p = env.parameters;
  const b = await withScope(SYS(tenantId), (c) => begin(c, agentId, d.attempt_id));
  if (!b.go) return;
  const steps: { name: string; status: string; at: string; detail?: unknown }[] = [];
  const step = (name: string, status: string, detail?: unknown) => steps.push({ name, status, at: now(), ...(detail !== undefined ? { detail } : {}) });
  const finish = (outcome: 'SUCCEEDED' | 'FAILED', observed: any, error?: string) =>
    withScope(SYS(tenantId), async (c) => {
      const r = await result(c, agentId, d.attempt_id, { outcome, steps, observed, ...(error ? { error } : {}) });
      await c.query(
        `insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, result, detail) values ($1,'system','radius-integrado','operation.result','operation_attempt',$2,$3,$4)`,
        [tenantId, d.attempt_id, outcome === 'SUCCEEDED' ? 'ok' : 'failed', JSON.stringify({ status: r.status })]);
    });
  try {
    // 1. autorização (o que o RADIUS vai responder)
    const ctx = await withScope(SYS(tenantId), async (c) => {
      const dev = (await c.query(
        `select d.vendor, n.nas_ip::text as nas_ip, host(n.nas_ip) as nas_host, n.secret, n.coa_host, n.coa_port, pv.down_kbps, pv.up_kbps
         from devices d join radius_nas n on n.device_id = d.id join service_resources r on r.device_id = d.id
         join contracts k on k.id = r.contract_id join plan_versions pv on pv.id = k.plan_version_id where r.id = $1`, [env.resource_id])).rows[0];
      if (!dev) throw new Error('concentrador sem cadastro no RADIUS integrado');
      const w: Wanted = {
        policy: p.policy, profile: p.profile, blockProfile: p.policy === 'suspended' && p.suspension?.mode === 'profile' ? p.suspension.profile : null,
        rateLimit: p.rate_limit ?? null, addressPool: p.address_pool ?? null, framedIp: p.framed_ip ?? null, acctInterim: p.acct_interim ?? null,
        simultaneousUse: p.simultaneous_use ?? null, mac: p.mac ?? null, accessType: p.access_type ?? 'pppoe', downKbps: dev.down_kbps, upKbps: dev.up_kbps,
      };
      const before = await readAccount(c, tenantId, p.username);
      if (before && before.applied_version === env.desired_version && before.policy === p.policy) step('autorização no RADIUS', 'ok', 'já aplicada nesta versão');
      else {
        const reply = replyRows(dev.vendor as Vendor, w);
        await applyAccount(c, tenantId, p.username, w, env.desired_version, b.secret, checkRows(w), reply);
        step('autorização no RADIUS', 'ok', { policy: p.policy, profile: effectiveProfile(w), atributos: reply.map((r) => r.attribute) });
      }
      const everSeen = !!(await c.query('select 1 from radius_acct where tenant_id = $1 and username = $2 limit 1', [tenantId, p.username])).rowCount;
      return { dev, acc: (await readAccount(c, tenantId, p.username))!, sessions: await openSessions(c, tenantId, p.username), fresh: !before, everSeen };
    });
    await withScope(SYS(tenantId), (c) => progress(c, agentId, d.attempt_id, 'EXECUTING', steps));

    // 2. sessão em uso: pedir a desconexão ao concentrador (fora de transação)
    // IPoE: o concentrador não derruba concessão de DHCP pelo protocolo (o RouterOS responde "sessão inexistente" com a concessão
    // ainda valendo — medido no CHR 7.17). A mudança vale na próxima renovação, que o prazo curto da concessão garante.
    const ipoe = p.access_type === 'ipoe';
    const targets = ctx.fresh || ipoe ? [] : ctx.sessions.filter((s) => mustDrop(p, ctx.acc, s));
    const gone = (cause: number | null) => cause !== null && SESSION_GONE_CAUSES[ctx.dev.vendor as Vendor].includes(cause);
    const pending: OpenSession[] = [];
    for (const s of targets) {
      const r: DisconnectResult = await drop({ host: ctx.dev.coa_host || ctx.dev.nas_host, port: ctx.dev.coa_port, secret: ctx.dev.secret, username: p.username, sessionId: s.session_id, framedIp: s.framed_ip });
      if (r.outcome === 'ack') step('desconexão da sessão', 'ok', { sessao: s.session_id, resposta: 'aceita pelo concentrador' });
      else if (r.outcome === 'nak' && gone(r.errorCause)) {
        // o concentrador não tem mais essa sessão: o fim dela não chegou até nós; fecha o registro
        await withScope(SYS(tenantId), (c) => c.query(`update radius_acct set stopped_at = now(), updated_at = now(), terminate_cause = 'Lost-Service' where id = $1 and stopped_at is null`, [s.id]));
        step('desconexão da sessão', 'ok', { sessao: s.session_id, resposta: 'o concentrador não tem mais essa sessão' });
      } else { pending.push(s); step('desconexão da sessão', 'incerto', { sessao: s.session_id, resposta: r.outcome === 'nak' ? `recusada (causa ${r.errorCause ?? '?'})` : 'sem resposta do concentrador' }); }
    }
    // Conta de que nunca recebemos accounting (ex.: sessão anterior à passagem para o RADIUS integrado): não dá para saber se há
    // sessão. Quando a intenção exige derrubar, pergunta-se ao concentrador pelo nome do usuário.
    const wantsDrop = !!p.reconnect || (p.policy === 'suspended' && p.suspension?.session === 'disconnect');
    if (ipoe) step('desconexão da sessão', 'ok', `IPoE: vale na próxima renovação da concessão (até ${ipoeLeaseSeconds()} s)`);
    else if (!targets.length && wantsDrop && !ctx.fresh && !ctx.everSeen) {
      const r: DisconnectResult = await drop({ host: ctx.dev.coa_host || ctx.dev.nas_host, port: ctx.dev.coa_port, secret: ctx.dev.secret, username: p.username });
      if (r.outcome === 'ack') step('desconexão da sessão', 'ok', { resposta: 'aceita pelo concentrador (sessão sem registro de accounting)' });
      else if (r.outcome === 'nak' && gone(r.errorCause)) step('desconexão da sessão', 'ok', 'o concentrador não tem sessão desta conta');
      else { pending.push({ id: -1, session_id: '', framed_ip: null, started_at: new Date(), calling_station: null }); step('desconexão da sessão', 'incerto', { resposta: r.outcome === 'nak' ? `recusada (causa ${r.errorCause ?? '?'})` : 'sem resposta do concentrador' }); }
    } else if (!targets.length) step('desconexão da sessão', 'ok', 'nenhuma sessão a tratar');
    await withScope(SYS(tenantId), (c) => progress(c, agentId, d.attempt_id, 'VERIFYING', steps));

    // 3. verificação: conta na versão pedida e nenhuma sessão antiga sem desfecho
    const after = await withScope(SYS(tenantId), async (c) => ({ acc: (await readAccount(c, tenantId, p.username))!, sessions: await openSessions(c, tenantId, p.username) }));
    const still = after.sessions.filter((s) => !targets.some((t) => t.id === s.id));      // as que acabamos de derrubar podem levar um instante para registrar o fim
    const ok = after.acc.applied_version === env.desired_version && after.acc.policy === p.policy && pending.length === 0;
    step('verificação', ok ? 'ok' : 'falha', { policy: after.acc.policy, profile: after.acc.profile, applied_version: after.acc.applied_version, sessoes_sem_desfecho: pending.length });
    const observed = { policy: after.acc.policy as 'active' | 'suspended', profile: after.acc.profile, session: sessionView(still[still.length - 1], after.acc.profile), at: now() };
    await finish(ok ? 'SUCCEEDED' : 'FAILED', observed, ok ? undefined : 'o concentrador não confirmou a desconexão da sessão');
  } catch (e) {
    step('execução', 'falha', String((e as Error).message).slice(0, 300));
    await finish('FAILED', undefined, String((e as Error).message).slice(0, 300)).catch(() => {});
  }
}

// ---------------------------------------------------------------- sincronização do que o RADIUS observou
const watermark = new Map<string, Date>();     // por provedor: até onde já copiamos. Vazio (processo recém-iniciado) = passada completa.

/**
 * Leva sessões, consumo e estado "online" das tabelas do RADIUS para as mesmas tabelas que o agente local alimenta.
 * INCREMENTAL: depois da primeira passada só toca nas contas que tiveram accounting ou mudança de autorização desde a última vez.
 * (Regravar todas as contas a cada ciclo, como na primeira versão, vira escrita constante com dezenas de milhares de assinantes.)
 */
/** Janela do consumo por hora (horas). */
export const usageHourlyHours = () => Math.min(24 * 31, Math.max(24, Number(process.env.NEXO_USAGE_HOURLY_HOURS) || 48));

export async function syncAccounting(tenantId: string, opts: { full?: boolean } = {}): Promise<{ accounts: number; sessions: number; full: boolean }> {
  const since = opts.full ? null : watermark.get(tenantId) ?? null;
  return withScope(SYS(tenantId), async (c) => {
    const next = (await c.query(`select now() - interval '5 seconds' as t`)).rows[0].t as Date;     // folga para o que está sendo gravado agora
    const changed = `(select username from radius_account where $1::timestamptz is null or updated_at > $1
                      union select username from radius_acct where $1::timestamptz is not null and seen_at > $1)`;
    const acc = await c.query(
      `update service_resources r set observed_policy = a.policy, observed_profile = a.profile, observed_at = now(),
              observed_session = (select jsonb_build_object('online', true, 'ip', x.framed_ip, 'caller_id', x.calling_station, 'since', x.started_at, 'profile', a.profile)
                                  from radius_acct x where x.tenant_id = r.tenant_id and x.username = r.pppoe_username and x.stopped_at is null order by x.started_at desc limit 1)
       from radius_account a, devices d
       where a.tenant_id = r.tenant_id and a.username = r.pppoe_username and d.id = r.device_id and d.driver = 'radius' and r.desired_version > 0
         and r.pppoe_username in ${changed}`, [since]);
    // Consumo diário: a diferença entre o contador novo e o que já estava gravado em service_sessions vai para o dia (fuso do provedor)
    // em que ela apareceu. Roda ANTES de atualizar as sessões. Sessão nova entra no dia da última atualização, para a primeira passada
    // não jogar o histórico em "hoje". Duas instruções simples, com junção pelo índice única (resource_id, session_key).
    const tzSql = `coalesce((select timezone from tenant_settings where tenant_id = $2), 'America/Sao_Paulo')`;
    const fresh = `(($1::timestamptz is null and (x.stopped_at is null or x.updated_at > now() - interval '2 days')) or x.seen_at > $1)`;
    // Uma leitura das diferenças (materializada uma vez) alimenta o diário e a hora; sem junção da CTE com ela mesma.
    await c.query(
      `with d as materialized (
         select x.tenant_id, r.id as resource_id, case when s.session_key is null then least(x.updated_at, now()) else now() end as at,
                greatest(0, x.bytes_in - coalesce(s.bytes_in, 0)) as bytes_in, greatest(0, x.bytes_out - coalesce(s.bytes_out, 0)) as bytes_out
         from radius_acct x join service_resources r on r.tenant_id = x.tenant_id and r.pppoe_username = x.username
         join devices d on d.id = r.device_id and d.driver = 'radius'
         left join service_sessions s on s.resource_id = r.id and s.session_key = left(x.unique_id, 80)
         where ${fresh} and (x.bytes_in > coalesce(s.bytes_in, 0) or x.bytes_out > coalesce(s.bytes_out, 0))),
       daily as (
         insert into usage_daily (tenant_id, resource_id, day, bytes_in, bytes_out)
         select tenant_id, resource_id, (at at time zone ${tzSql})::date, sum(bytes_in), sum(bytes_out) from d group by 1, 2, 3
         on conflict (resource_id, day) do update set bytes_in = usage_daily.bytes_in + excluded.bytes_in, bytes_out = usage_daily.bytes_out + excluded.bytes_out
         returning 1)
       insert into usage_hourly (tenant_id, resource_id, hour, bytes_in, bytes_out)
       select tenant_id, resource_id, date_trunc('hour', at), sum(bytes_in), sum(bytes_out) from d
       where at > now() - make_interval(hours => $3::int) group by 1, 2, 3
       on conflict (resource_id, hour) do update set bytes_in = usage_hourly.bytes_in + excluded.bytes_in, bytes_out = usage_hourly.bytes_out + excluded.bytes_out`,
      [since, tenantId, usageHourlyHours()]);
    const ses = await c.query(
      `insert into service_sessions (tenant_id, resource_id, session_key, started_at, stopped_at, ip, mac, nas_ip, bytes_in, bytes_out, seconds, terminate_cause)
       select x.tenant_id, r.id, left(x.unique_id, 80), x.started_at, x.stopped_at, x.framed_ip, x.calling_station, host(x.nas_ip), x.bytes_in, x.bytes_out, x.session_seconds, x.terminate_cause
       from radius_acct x join service_resources r on r.tenant_id = x.tenant_id and r.pppoe_username = x.username
       join devices d on d.id = r.device_id and d.driver = 'radius'
       where ${fresh}
       on conflict (resource_id, session_key) do update set stopped_at = excluded.stopped_at, ip = excluded.ip, mac = excluded.mac, nas_ip = excluded.nas_ip,
         bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out, seconds = excluded.seconds, terminate_cause = excluded.terminate_cause, reported_at = now()`, [since]);
    await c.query(
      `insert into usage_monthly (tenant_id, resource_id, month, bytes_in, bytes_out, session_seconds, sessions)
       select x.tenant_id, r.id, date_trunc('month', x.started_at at time zone 'UTC')::date, sum(x.bytes_in), sum(x.bytes_out), sum(x.session_seconds), count(*)
       from radius_acct x join service_resources r on r.tenant_id = x.tenant_id and r.pppoe_username = x.username
       join devices d on d.id = r.device_id and d.driver = 'radius'
       where x.started_at >= date_trunc('month', now() at time zone 'UTC') - interval '1 month'
         and ($1::timestamptz is null or x.username in (select username from radius_acct where seen_at > $1))
       group by 1, 2, 3
       on conflict (resource_id, month) do update set bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out,
         session_seconds = excluded.session_seconds, sessions = excluded.sessions, reported_at = now()`, [since]);
    // "verificação" do equipamento = último pacote que ele nos mandou
    await c.query(
      `update radius_nas n set last_packet_at = greatest(n.last_packet_at, v.last)
       from (select nas_ip, max(at) as last from (select nas_ip, seen_at as at from radius_acct where seen_at > coalesce($1, now() - interval '1 day')
                                                  union all select nas_ip, at from radius_postauth where at > coalesce($1, now() - interval '1 day')) z group by nas_ip) v
       where v.nas_ip = n.nas_ip`, [since]);
    await c.query(
      `update devices d set last_check_at = now(), last_check = jsonb_build_object('ok', n.last_packet_at > now() - interval '15 minutes',
              'detail', case when n.last_packet_at is null then 'nenhum pacote recebido deste concentrador ainda'
                             else 'último pacote recebido em ' || to_char(n.last_packet_at at time zone 'UTC', 'DD/MM HH24:MI') || ' UTC' end)
       from radius_nas n where n.device_id = d.id`);
    watermark.set(tenantId, next);
    return { accounts: acc.rowCount ?? 0, sessions: ses.rowCount ?? 0, full: since === null };
  });
}

/**
 * Limpeza em lotes do que só cresce: tentativas de autenticação e sessões encerradas antigas. Os prazos vêm do ambiente;
 * o de sessões fica acima de 1 ano por padrão (guarda do registro de conexão exigida do provedor).
 */
export async function purgeRadius(tenantId: string, batch = 5000): Promise<{ postauth: number; acct: number; sessions: number }> {
  const days = (name: string, def: number, min: number) => Math.max(min, Number(process.env[name]) || def);
  return withScope(SYS(tenantId), async (c) => {
    // retenção do provedor (se definida) ou o padrão da instalação
    const s = (await c.query('select retention_auth_log_days as a, retention_sessions_days as s, retention_notice_log_days as n from tenant_settings where tenant_id = $1', [tenantId])).rows[0] ?? {};
    const logDays = s.a ?? days('NEXO_RADIUS_LOG_DAYS', 30, 1), keepDays = s.s ?? days('NEXO_SESSION_KEEP_DAYS', 400, 30);
    const noticeDays = s.n ?? days('NEXO_NOTICE_LOG_DAYS', 400, 30);
    await c.query(`delete from notice_log where ctid in (select ctid from notice_log where tenant_id = $1 and status in ('sent','failed','skipped_no_consent','uncertain','test')
                   and created_at < now() - make_interval(days => $2::int) limit $3)`, [tenantId, noticeDays, batch]);
    const del = async (table: string, col: string, d: number) => (await c.query(
      `delete from ${table} where ctid in (select ctid from ${table} where tenant_id = $1 and ${col} < now() - make_interval(days => $2::int) limit $3)`, [tenantId, d, batch])).rowCount ?? 0;
    const usageDays = days('NEXO_USAGE_DAILY_DAYS', 800, 400);   // cobre "por ano" com folga
    await c.query(`delete from usage_hourly where ctid in (select ctid from usage_hourly where tenant_id = $1 and hour < now() - make_interval(hours => $2::int) limit $3)`, [tenantId, usageHourlyHours(), batch * 4]);
    await c.query(`delete from usage_daily where ctid in (select ctid from usage_daily where tenant_id = $1 and day < (now() - make_interval(days => $2::int))::date limit $3)`, [tenantId, usageDays, batch]);
    return { postauth: await del('radius_postauth', 'at', logDays), acct: await del('radius_acct', 'stopped_at', keepDays), sessions: await del('service_sessions', 'stopped_at', keepDays) };
  });
}

// ---------------------------------------------------------------- laço
/** Executa o que estiver na fila dos provedores com RADIUS integrado. Seguro com mais de uma réplica (a reserva usa SKIP LOCKED). */
export async function runHostedOnce(opts: { tenantId?: string; drop?: typeof sendDisconnect; sync?: boolean } = {}): Promise<number> {
  if (!radiusConfigured()) return 0;
  const all = (await withScope(noScope, async (c) => (await c.query('select tenant_id, agent_id from radius_internal_agents()')).rows));
  let n = 0;
  for (const a of all.filter((x) => !opts.tenantId || x.tenant_id === opts.tenantId)) {
    await withScope(SYS(a.tenant_id), (c) => c.query('update agents set last_seen_at = now() where id = $1', [a.agent_id]));
    for (let i = 0; i < 200; i++) {
      const d = await withScope(SYS(a.tenant_id), (c) => reserve(c, a.agent_id));
      if (!d) break;
      await executeOne(a.tenant_id, a.agent_id, d, opts.drop ?? sendDisconnect);
      n++;
    }
    if (opts.sync) await syncAccounting(a.tenant_id);
  }
  return n;
}

/** Laço em segundo plano: operações a cada 2 s; sessões, consumo e estado online a cada 15 s. */
export function startHostedRadius(log: (m: string) => void) {
  if (!radiusConfigured()) { log('RADIUS integrado desligado: defina NEXO_RADIUS_KEY para habilitar'); return () => {}; }
  let busy = false, tick = 0;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await runHostedOnce({ sync: tick++ % 7 === 0 }); } catch (e) { log(`RADIUS integrado: ${(e as Error).message}`); } finally { busy = false; }
  }, 2000);
  t.unref();
  return () => clearInterval(t);
}
