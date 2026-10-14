import { createSocket, type Socket } from 'node:dgram';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { buildDisconnect, parseReply, sendDisconnect, type DisconnectResult } from '../src/radius/coa.js';
import { purgeRadius, runHostedOnce, syncAccounting } from '../src/radius/executor.js';
import { checkRows, replyRows, setupCommands } from '../src/radius/vendor.js';
import { newPeerKeys, renderServerConf } from '../src/radius/vpn-shared.js';
import { noScope } from '../src/db.js';
import { call, login } from './helpers.js';
import { createHash } from 'node:crypto';

// RADIUS integrado: o NexoISP grava o que o servidor RADIUS responde e pede a desconexão pelo próprio protocolo, sem agente no provedor.
process.env.NEXO_RADIUS_KEY ??= 'chave-de-teste-do-radius-integrado-0001';
process.env.NEXO_RADIUS_PUBLIC_HOST ??= 'radius.exemplo.invalido';
let admin: string, beta: string, tenantId: string, planId: string, owner: pg.Client;
const tag = String(Date.now()).slice(-6);
const oct = () => 1 + Math.floor(Math.random() * 250);
const ip = () => `198.18.${oct()}.${oct()}`;
const sql = (q: string, p: unknown[] = []) => withScope({ tenantId, operator: false }, async (c) => (await c.query(q, p)).rows);
const drops: any[] = [];
let dropAnswer: DisconnectResult = { outcome: 'ack' };
const drop = async (o: any) => { drops.push(o); return dropAnswer; };
const run = () => runHostedOnce({ tenantId, drop: drop as any });

async function device(vendor: string, extra: object = {}) {
  const r = await call(admin, 'POST', '/api/radius/devices', { name: `conc-${vendor}-${tag}-${Math.random().toString(36).slice(2, 5)}`, vendor, nas_ip: ip(), ...extra });
  expect(r.status).toBe(200);
  return r.body;
}
async function account(deviceId: string, n: string, plan = planId) {
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Radius ${n} ${tag}` })).body;
  const contractId = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan, due_day: 10 })).body.id;
  const username = `rd${n}${tag}`;
  const s = await call(admin, 'POST', `/api/contracts/${contractId}/service`, { device_id: deviceId, pppoe_username: username, pppoe_password: `Senha-${n}-${tag}` });
  expect(s.status).toBe(200);
  return { contractId, resourceId: s.body.resource_id as string, username, password: s.body.generated_password ?? `Senha-${n}-${tag}` };
}
const lastOp = async (contractId: string) => (await call(admin, 'GET', `/api/contracts/${contractId}/service`)).body.operations[0];
const rows = async (table: string, username: string) => Object.fromEntries((await sql(`select attribute, value from ${table} where username = $1 order by id`, [username])).map((r) => [r.attribute, r.value]));
/** Sessão aberta no accounting, como o servidor RADIUS gravaria (a aplicação não tem permissão de inserir aqui). */
const openSession = (username: string, minutesAgo: number, framedIp = '100.64.9.9') =>
  owner.query(`insert into radius_acct (tenant_id, unique_id, session_id, username, nas_ip, started_at, updated_at, framed_ip, calling_station, bytes_in, bytes_out, session_seconds)
               values ($1,$2,$3,$4,'198.18.0.1', now() - make_interval(mins => $5), now(), $6, '02:4E:58:00:00:AA', 1000, 5000, $5 * 60) returning id, session_id`,
    [tenantId, `u-${username}-${Math.random()}`, `s-${Math.random().toString(36).slice(2, 10)}`, username, minutesAgo, framedIp]).then((r) => r.rows[0]);

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  planId = (await call(admin, 'POST', '/api/plans', { name: `Plano radius ${tag}`, price_cents: 9990, down_kbps: 100000, up_kbps: 50000, profile_name: `rd${tag}` })).body.id;
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await owner.connect();
});
afterAll(async () => { await owner.end(); });

describe('atributos por fabricante', () => {
  const w = { policy: 'active' as const, profile: 'plano-100', downKbps: 100000, upKbps: 50000, rateLimit: '50M/100M', addressPool: 'pool-a', framedIp: '100.64.0.7', acctInterim: 300 };
  it('MikroTik, Huawei, Cisco e genérico recebem cada um os seus; conferência é igual para todos', () => {
    const m = replyRows('mikrotik', w);
    expect(m).toEqual(expect.arrayContaining([{ attribute: 'Mikrotik-Group', op: ':=', value: 'plano-100' }, { attribute: 'Mikrotik-Rate-Limit', op: ':=', value: '50M/100M' },
      { attribute: 'Framed-Pool', op: ':=', value: 'pool-a' }, { attribute: 'Framed-IP-Address', op: ':=', value: '100.64.0.7' }, { attribute: 'Acct-Interim-Interval', op: ':=', value: '300' }]));
    const h = Object.fromEntries(replyRows('huawei', w).map((r) => [r.attribute, r.value]));
    expect(h).toMatchObject({ 'Huawei-Input-Average-Rate': '50000000', 'Huawei-Output-Average-Rate': '100000000', 'Framed-Pool': 'pool-a' });   // bit/s, do plano
    expect(h).not.toHaveProperty('Mikrotik-Group');
    const c = replyRows('cisco', w).filter((r) => r.attribute === 'Cisco-AVPair');
    expect(c.map((r) => r.value)).toEqual(['ip:sub-qos-policy-in=plano-100', 'ip:sub-qos-policy-out=plano-100', 'ip:addr-pool=pool-a']);
    expect(c.every((r) => r.op === '+=')).toBe(true);                               // atributo repetido: soma, não substitui
    expect(replyRows('generic', w).find((r) => r.attribute === 'Filter-Id')?.value).toBe('plano-100');
    // suspensa por perfil: vale o perfil de bloqueio, sem a velocidade nem o pool do plano
    const blocked = { ...w, policy: 'suspended' as const, blockProfile: 'bloqueio' };
    expect(Object.fromEntries(replyRows('mikrotik', blocked).map((r) => [r.attribute, r.value]))).toMatchObject({ 'Mikrotik-Group': 'bloqueio' });
    expect(replyRows('mikrotik', blocked).some((r) => ['Mikrotik-Rate-Limit', 'Framed-Pool'].includes(r.attribute))).toBe(false);
    expect(Object.fromEntries(replyRows('huawei', blocked).map((r) => [r.attribute, r.value]))).toMatchObject({ 'Huawei-Qos-Profile-Name': 'bloqueio' });
    expect(checkRows(blocked)).toEqual([]);                                         // continua autenticando
    expect(checkRows({ ...w, policy: 'suspended', mac: '02:4E:58:00:00:02', simultaneousUse: 1 })).toEqual([
      { attribute: 'Auth-Type', op: ':=', value: 'Reject' }, { attribute: 'Calling-Station-Id', op: '==', value: '02:4E:58:00:00:02' }, { attribute: 'Simultaneous-Use', op: ':=', value: '1' }]);
    for (const v of ['mikrotik', 'huawei', 'cisco', 'generic'] as const)
      expect(setupCommands(v, { host: '203.0.113.9', authPort: 1812, acctPort: 1813, coaPort: 3799, secret: 'SEG' })).toMatch(/203\.0\.113\.9[\s\S]*SEG|SEG[\s\S]*203\.0\.113\.9/);
  });
});

describe('desconexão pelo protocolo (RFC 5176)', () => {
  let nas: Socket, port: number, mode: 'ack' | 'nak' | 'mudo' | 'forjado' = 'ack';
  const seen: Buffer[] = [];
  const SECRET = 'segredo-do-concentrador';
  beforeAll(async () => {
    nas = createSocket('udp4');
    nas.on('message', (msg, r) => {
      seen.push(msg);
      if (mode === 'mudo') return;
      const attrs = mode === 'nak' ? Buffer.from([101, 6, 0, 0, 0x01, 0xf7]) : Buffer.alloc(0);      // Error-Cause 503
      const head = Buffer.alloc(4); head[0] = mode === 'nak' ? 42 : 41; head[1] = msg[1]; head.writeUInt16BE(20 + attrs.length, 2);
      const auth = createHash('md5').update(Buffer.concat([head, msg.subarray(4, 20), attrs, Buffer.from(mode === 'forjado' ? 'outro-segredo' : SECRET)])).digest();
      nas.send(Buffer.concat([head, auth, attrs]), r.port, r.address);
    });
    await new Promise<void>((r) => nas.bind(0, '127.0.0.1', r));
    port = nas.address().port;
  });
  afterAll(() => nas.close());
  const go = () => sendDisconnect({ host: '127.0.0.1', port, secret: SECRET, username: 'cliente01', sessionId: 'abc123', framedIp: '100.64.0.7' }, 300, 2);

  it('pedido bem formado e assinado; ACK, NAK com causa, silêncio e resposta forjada', async () => {
    expect(await go()).toEqual({ outcome: 'ack' });
    const p = seen[0];
    expect(p[0]).toBe(40);
    expect(p.readUInt16BE(2)).toBe(p.length);
    expect(p.subarray(4, 20).equals(createHash('md5').update(Buffer.concat([p.subarray(0, 4), Buffer.alloc(16), p.subarray(20), Buffer.from(SECRET)])).digest())).toBe(true);
    expect(p.subarray(20).includes(Buffer.from('cliente01'))).toBe(true);
    expect(p.subarray(20).includes(Buffer.from([8, 6, 100, 64, 0, 7]))).toBe(true);                // Framed-IP-Address
    mode = 'nak'; expect(await go()).toEqual({ outcome: 'nak', errorCause: 503 });
    mode = 'mudo'; expect(await go()).toEqual({ outcome: 'timeout' });
    mode = 'forjado'; expect(await go()).toEqual({ outcome: 'timeout' });                          // autenticador errado é ignorado
    mode = 'ack';
    const req = buildDisconnect(SECRET, 7, { username: 'x' });
    expect(parseReply(SECRET, req, Buffer.from([41, 8, 0, 20, ...Buffer.alloc(16)]))).toBeNull();   // id de outro pedido
  });
});

describe('concentrador no RADIUS integrado', () => {
  it('cadastro gera o segredo uma vez, entrega as instruções e não aceita endereço repetido nem vaza para outro provedor', async () => {
    expect((await call(await login('atendimento@alfa.demo'), 'POST', '/api/radius/devices', { name: 'x y', vendor: 'mikrotik', nas_ip: ip() })).status).toBe(403);
    expect((await call(admin, 'POST', '/api/radius/devices', { name: `ruim ${tag}`, vendor: 'juniper', nas_ip: ip() })).status).toBe(400);
    expect((await call(admin, 'POST', '/api/radius/devices', { name: `ruim ${tag}`, vendor: 'mikrotik', nas_ip: 'não é ip' })).status).toBe(400);
    const d = await device('mikrotik');
    expect(d.secret.length).toBeGreaterThanOrEqual(20);
    expect(d.setup.commands).toContain(d.secret);
    expect(d.setup.commands).toContain('radius.exemplo.invalido');
    expect(d.setup).toMatchObject({ validated: true, auth_port: 1812, acct_port: 1813, coa_port: 3799 });
    const again = (await call(admin, 'GET', `/api/radius/devices/${d.id}/setup`)).body;
    expect(JSON.stringify(again)).not.toContain(d.secret);
    expect(again.setup.commands).toContain('<SEGREDO>');
    const lista = (await call(admin, 'GET', '/api/devices')).body.find((x: any) => x.id === d.id);
    expect(lista).toMatchObject({ driver: 'radius', vendor: 'mikrotik', nas_ip: d.nas_ip, agent_name: 'RADIUS integrado' });
    expect(JSON.stringify(lista)).not.toContain(d.secret);
    // o mesmo endereço em outro provedor: recusado, sem dizer de quem é
    const dup = await call(beta, 'POST', '/api/radius/devices', { name: `dup ${tag}`, vendor: 'mikrotik', nas_ip: d.nas_ip });
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).not.toMatch(/alfa|Alfa/);
    expect((await call(beta, 'GET', `/api/radius/devices/${d.id}/setup`)).status).toBe(404);
    // Huawei e Cisco saem marcados como não validados
    expect((await device('huawei')).setup.validated).toBe(false);
    const rot = (await call(admin, 'POST', `/api/radius/devices/${d.id}/secret`)).body;
    expect(rot.secret).not.toBe(d.secret);
  });

  it('provisionar grava a conta com a senha cifrada e os atributos do fabricante; a operação conclui sem agente', async () => {
    const d = await device('mikrotik');
    const a = await account(d.id, 'a');
    expect(await run()).toBeGreaterThanOrEqual(1);
    expect((await lastOp(a.contractId)).status).toBe('SUCCEEDED');
    const acc = (await sql(`select policy, profile, applied_version, position($2::bytea in secret_enc) > 0 as clear from radius_account where username = $1`, [a.username, Buffer.from(a.password)]))[0];
    expect(acc).toMatchObject({ policy: 'active', profile: `rd${tag}`, clear: false });           // no banco a senha não aparece em claro
    // a aplicação não tem permissão para abrir a senha; quem abre é o papel do servidor RADIUS, com a chave
    await expect(sql(`select pgp_sym_decrypt(secret_enc, $2) from radius_account where username = $1`, [a.username, process.env.NEXO_RADIUS_KEY])).rejects.toThrow(/permission denied/);
    const opened = (await owner.query(`select pgp_sym_decrypt(secret_enc, $2) as p from radius_account where username = $1`, [a.username, process.env.NEXO_RADIUS_KEY])).rows[0].p;
    expect(opened).toBe(a.password);
    expect(await rows('radius_reply', a.username)).toMatchObject({ 'Mikrotik-Group': `rd${tag}` });
    expect(await rows('radius_check', a.username)).toEqual({});
    expect((await call(admin, 'GET', `/api/contracts/${a.contractId}/states`)).body.access).toMatchObject({ state: 'active', applied: true });

    // Huawei: velocidade do plano em bit/s, sem atributo de MikroTik
    const h = await device('huawei');
    const b = await account(h.id, 'b');
    await run();
    expect(await rows('radius_reply', b.username)).toEqual({ 'Huawei-Input-Average-Rate': '50000000', 'Huawei-Output-Average-Rate': '100000000' });
    // mesmo login em outro provedor não colide
    expect((await sql(`select count(*)::int as n from radius_account where username = $1`, [a.username]))[0].n).toBe(1);
  });

  it('suspender nega a autenticação e derruba a sessão pelo protocolo; sem resposta do concentrador não é dado como concluído', async () => {
    const d = await device('mikrotik');
    const a = await account(d.id, 'c');
    await run();
    const s = await openSession(a.username, 30);
    drops.length = 0; dropAnswer = { outcome: 'ack' };
    await call(admin, 'POST', `/api/resources/${a.resourceId}/suspend`, { reason: 'teste' });
    await run();
    expect((await lastOp(a.contractId)).status).toBe('SUCCEEDED');
    expect(await rows('radius_check', a.username)).toEqual({ 'Auth-Type': 'Reject' });
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ host: d.nas_ip, port: 3799, username: a.username, sessionId: s.session_id, framedIp: '100.64.9.9' });
    expect(drops[0].secret).toBe(d.secret);

    // reativar com o concentrador mudo: a conta é liberada, mas não há sessão antiga a derrubar (a de antes continua registrada como aberta e é do perfil certo)
    await call(admin, 'POST', `/api/resources/${a.resourceId}/resume`, { reason: 'teste' });
    await run();
    expect((await lastOp(a.contractId)).status).toBe('SUCCEEDED');
    expect(await rows('radius_check', a.username)).toEqual({});

    // desconexão pedida com o concentrador sem responder: não conclui e volta para nova tentativa
    drops.length = 0; dropAnswer = { outcome: 'timeout' };
    await call(admin, 'POST', `/api/resources/${a.resourceId}/disconnect`, { reason: 'teste de timeout' });
    await run();
    const op = await lastOp(a.contractId);
    expect(op.status).not.toBe('SUCCEEDED');
    expect(drops).toHaveLength(1);
    // o concentrador diz que a sessão não existe mais: o registro é fechado e a operação conclui
    dropAnswer = { outcome: 'nak', errorCause: 503 };
    await sql(`update operations set next_attempt_at = now() where id = $1`, [op.id]);
    await run();
    expect((await lastOp(a.contractId)).status).toBe('SUCCEEDED');
    expect((await sql(`select stopped_at, terminate_cause from radius_acct where id = $1`, [s.id]))[0]).toMatchObject({ terminate_cause: 'Lost-Service' });
    dropAnswer = { outcome: 'ack' };
  });

  it('a causa de "sessão inexistente" é a do fabricante: 406 vale para MikroTik, não para os outros', async () => {
    for (const [vendor, concludes] of [['mikrotik', true], ['huawei', false]] as const) {
      const d = await device(vendor);
      const a = await account(d.id, vendor === 'mikrotik' ? 'm6' : 'h6');
      await run();
      const s = await openSession(a.username, 10);
      dropAnswer = { outcome: 'nak', errorCause: 406 };
      await call(admin, 'POST', `/api/resources/${a.resourceId}/disconnect`, { reason: 'teste da causa 406' });
      await run();
      expect((await lastOp(a.contractId)).status === 'SUCCEEDED').toBe(concludes);
      expect(((await sql('select stopped_at from radius_acct where id = $1', [s.id]))[0].stopped_at !== null)).toBe(concludes);
    }
    dropAnswer = { outcome: 'ack' };
  });

  it('conta de que nunca chegou accounting: a desconexão é pedida pelo nome do usuário', async () => {
    const d = await device('mikrotik');
    const a = await account(d.id, 'n');
    await run();
    drops.length = 0; dropAnswer = { outcome: 'ack' };
    await call(admin, 'POST', `/api/resources/${a.resourceId}/disconnect`, { reason: 'sessão anterior à conversão' });
    await run();
    expect((await lastOp(a.contractId)).status).toBe('SUCCEEDED');
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ username: a.username });
    expect(drops[0].sessionId).toBeUndefined();
    // depois que o accounting da conta existe (mesmo encerrado), vale o accounting: sem sessão aberta, nada é enviado
    const s = await openSession(a.username, 5);
    await owner.query(`update radius_acct set stopped_at = now() where id = $1`, [s.id]);
    drops.length = 0;
    await call(admin, 'POST', `/api/resources/${a.resourceId}/disconnect`, { reason: 'sem sessão' });
    await run();
    expect((await lastOp(a.contractId)).status).toBe('SUCCEEDED');
    expect(drops).toHaveLength(0);
  });

  it('sessões, consumo, online e log de autenticação vêm do accounting do próprio sistema', async () => {
    const d = await device('mikrotik');
    const a = await account(d.id, 'd');
    await run();
    await openSession(a.username, 90, '100.64.7.7');
    await owner.query(`insert into radius_postauth (tenant_id, username, reply, calling_station, nas_ip) values ($1,$2,'Access-Accept','02:4E:58:00:00:AA',$3), ($1,$2,'Access-Reject','02:4E:58:00:00:BB',$3)`, [tenantId, a.username, d.nas_ip]);
    await syncAccounting(tenantId);
    // sessão relatada por agente local traz 'since' como número (época): a lista de online não pode quebrar por isso
    await sql(`update service_resources set observed_session = '{"online": true, "ip": "100.64.1.1", "since": 1791910000.5, "uptime": "5m"}'::jsonb, observed_at = now() where id = $1`, [a.resourceId]);
    expect((await call(admin, 'GET', `/api/network/online?q=${a.username}`)).body.rows[0]).toMatchObject({ uptime: '5m' });
    await syncAccounting(tenantId, { full: true });
    const online = (await call(admin, 'GET', `/api/network/online?q=${a.username}`)).body.rows;
    expect(online).toHaveLength(1);
    expect(online[0]).toMatchObject({ login: a.username, ip: '100.64.7.7', mac: '02:4E:58:00:00:AA' });
    expect(online[0].uptime).toMatch(/^1h30m\d+s$/);                       // calculado na leitura, a partir do início da sessão
    const ses = (await call(admin, 'GET', `/api/contracts/${a.contractId}/sessions`)).body;
    expect(ses.rows[0]).toMatchObject({ ip: '100.64.7.7', bytes_in: 1000, bytes_out: 5000 });
    expect((await call(admin, 'GET', `/api/contracts/${a.contractId}/usage`)).body.months?.[0] ?? (await call(admin, 'GET', `/api/contracts/${a.contractId}/usage`)).body[0]).toBeTruthy();
    const log = (await call(admin, 'GET', `/api/contracts/${a.contractId}/radius-log`)).body;
    expect(log.integrated).toBe(true);
    expect(log.rows.map((r: any) => r.reply)).toEqual(['Access-Reject', 'Access-Accept']);
    expect((await call(beta, 'GET', `/api/contracts/${a.contractId}/radius-log`)).body.rows).toEqual([]);
    expect((await call(admin, 'GET', '/api/devices')).body.find((x: any) => x.id === d.id).last_check.ok).toBe(true);
  });

  it('sincronização incremental: só regrava a conta que teve accounting; limpeza apaga só o que passou do prazo', async () => {
    const d = await device('mikrotik');
    const a = await account(d.id, 'i1');
    const b = await account(d.id, 'i2');
    await run();
    await new Promise((r) => setTimeout(r, 5300));                       // a marca tem 5 s de folga: o que mudou há menos que isso é relido
    await syncAccounting(tenantId, { full: true });
    expect(await syncAccounting(tenantId)).toMatchObject({ accounts: 0, sessions: 0, full: false });
    await openSession(a.username, 3, '100.64.8.8');                       // chega accounting só da primeira conta
    await new Promise((r) => setTimeout(r, 300));
    const r = await syncAccounting(tenantId);
    expect(r).toMatchObject({ accounts: 1, sessions: 1, full: false });
    expect((await call(admin, 'GET', `/api/network/online?q=${a.username}`)).body.rows).toHaveLength(1);
    expect((await call(admin, 'GET', `/api/network/online?q=${b.username}`)).body.rows).toHaveLength(0);

    // limpeza: tentativa de 40 dias sai (prazo 30), a de ontem fica; sessão encerrada há 500 dias sai (prazo 400), a aberta nunca
    await owner.query(`insert into radius_postauth (tenant_id, username, reply, at) values ($1,$2,'Access-Accept', now() - interval '40 days'), ($1,$2,'Access-Accept', now() - interval '1 day')`, [tenantId, a.username]);
    await owner.query(`insert into radius_acct (tenant_id, unique_id, session_id, username, started_at, updated_at, stopped_at) values ($1,$2,'velha',$3, now() - interval '501 days', now() - interval '500 days', now() - interval '500 days')`, [tenantId, `velha-${tag}`, a.username]);
    const p = await purgeRadius(tenantId);
    expect(p.postauth).toBeGreaterThanOrEqual(1);
    expect(p.acct).toBeGreaterThanOrEqual(1);
    expect((await sql(`select count(*)::int as n from radius_postauth where username = $1`, [a.username]))[0].n).toBe(1);
    expect((await sql(`select count(*)::int as n from radius_acct where username = $1 and stopped_at is null`, [a.username]))[0].n).toBe(1);
    expect((await sql(`select count(*)::int as n from radius_acct where unique_id = $1`, [`velha-${tag}`]))[0].n).toBe(0);
  });

  it('consumo diário: soma só a diferença entre leituras, agrega por semana e ano; outro provedor não vê', async () => {
    const d = await device('mikrotik');
    const a = await account(d.id, 'cd');
    await run();
    const s = await openSession(a.username, 30, '100.64.6.6');            // 1000 enviados, 5000 recebidos
    await syncAccounting(tenantId);
    let day = (await call(admin, 'GET', `/api/contracts/${a.contractId}/usage-series?by=day`)).body;
    expect(day).toHaveLength(1);
    expect(day[0]).toMatchObject({ bytes_in: 1000, bytes_out: 5000 });
    // a mesma leitura de novo não soma outra vez
    await owner.query(`update radius_acct set updated_at = now() where id = $1`, [s.id]);
    await new Promise((r) => setTimeout(r, 300));
    await syncAccounting(tenantId);
    day = (await call(admin, 'GET', `/api/contracts/${a.contractId}/usage-series?by=day`)).body;
    expect(day[0]).toMatchObject({ bytes_in: 1000, bytes_out: 5000 });
    // o contador cresce: entra só a diferença (2000 / 4000)
    await owner.query(`update radius_acct set bytes_in = 3000, bytes_out = 9000, updated_at = now() where id = $1`, [s.id]);
    await new Promise((r) => setTimeout(r, 300));
    await syncAccounting(tenantId);
    day = (await call(admin, 'GET', `/api/contracts/${a.contractId}/usage-series?by=day`)).body;
    expect(day[0]).toMatchObject({ bytes_in: 3000, bytes_out: 9000 });
    // dias anteriores entram na semana e no ano
    await sql(`insert into usage_daily (tenant_id, resource_id, day, bytes_in, bytes_out)
               select tenant_id, id, current_date - 400, 1, 2 from service_resources where id = $1`, [a.resourceId]);
    await sql(`insert into usage_daily (tenant_id, resource_id, day, bytes_in, bytes_out)
               select tenant_id, id, current_date - 3, 10, 20 from service_resources where id = $1`, [a.resourceId]);
    const week = (await call(admin, 'GET', `/api/contracts/${a.contractId}/usage-series?by=week`)).body;
    const total = (rows: any[]) => rows.reduce((s, r) => s + r.bytes_out, 0);
    expect(total(week)).toBe(9020);                                        // hoje + há 3 dias; o de 400 dias fica fora das 26 semanas
    expect(week.every((r: any) => new Date(`${r.period}T00:00:00Z`).getUTCDay() === 1)).toBe(true);   // semana começa na segunda
    const year = (await call(admin, 'GET', `/api/contracts/${a.contractId}/usage-series?by=year`)).body;
    expect(year.every((r: any) => r.period.endsWith('-01-01'))).toBe(true);
    expect(total(year)).toBeLessThanOrEqual(9022);
    expect((await call(beta, 'GET', `/api/contracts/${a.contractId}/usage-series`)).body).toEqual([]);   // outro provedor não vê
  });

  it('IPoE: o usuário é o MAC, autoriza sem senha, suspender nega; hotspot usa usuário e senha; agente local recusa IPoE', async () => {
    const d = await device('mikrotik');
    const sub = (await call(admin, 'POST', '/api/subscribers', { name: `IPoE ${tag}` })).body;
    const k = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: planId, due_day: 10 })).body.id;
    expect((await call(admin, 'POST', `/api/contracts/${k}/service`, { device_id: d.id, access_type: 'ipoe', mac: '02:4e:58' })).status).toBe(400);
    const mac = `02-4e-58-${tag.slice(-2).padStart(2, '0')}-0a-0b`;
    const s = await call(admin, 'POST', `/api/contracts/${k}/service`, { device_id: d.id, access_type: 'ipoe', mac });
    expect(s.status).toBe(200);
    expect(s.body.generated_password).toBeNull();                         // não há senha para o assinante
    await run();
    const user = mac.toUpperCase().replace(/-/g, ':');
    expect(await rows('radius_check', user)).toMatchObject({ 'Auth-Type': 'Accept' });
    expect(await rows('radius_reply', user)).toMatchObject({ 'Mikrotik-Address-List': expect.any(String), 'Session-Timeout': '600' });
    expect(await rows('radius_reply', user)).not.toHaveProperty('Mikrotik-Group');
    expect((await call(admin, 'GET', `/api/contracts/${k}/service`)).body.resource).toMatchObject({ access_type: 'ipoe', pppoe_username: user });
    await openSession(user, 1, '10.99.9.10');                               // concessão em curso
    const before = drops.length;
    await call(admin, 'POST', `/api/resources/${s.body.resource_id}/suspend`, { reason: 'teste' });
    await run();
    expect(await rows('radius_check', user)).toMatchObject({ 'Auth-Type': 'Reject' });
    expect(drops.length).toBe(before);                                      // não pede desconexão de concessão DHCP
    const op = (await call(admin, 'GET', `/api/contracts/${k}/service`)).body.operations[0];
    expect(op.status).toBe('SUCCEEDED');
    expect(JSON.stringify(op.result ?? op.steps ?? op)).toMatch(/renovação da concessão/);
    // hotspot: igual ao PPPoE na autorização (senha conferida), só muda onde o assinante digita
    const k2 = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: planId, due_day: 10 })).body.id;
    const h = await call(admin, 'POST', `/api/contracts/${k2}/service`, { device_id: d.id, access_type: 'hotspot', pppoe_username: `hs${tag}` });
    expect(h.body.generated_password).toBeTruthy();
    await run();
    expect(await rows('radius_check', `hs${tag}`)).not.toHaveProperty('Auth-Type');
    expect(await rows('radius_reply', `hs${tag}`)).toMatchObject({ 'Mikrotik-Address-List': expect.any(String) });
    expect(await rows('radius_reply', `hs${tag}`)).not.toHaveProperty('Session-Timeout');
    // concentrador com agente local não entende IPoE
    const ag = (await call(admin, 'POST', '/api/agents', { name: `ag-ipoe-${tag}` })).body;
    const dl = (await call(admin, 'POST', '/api/devices', { name: `nas-ipoe-${tag}`, driver: 'demo', agent_id: ag.id })).body;
    const k3 = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: planId, due_day: 10 })).body.id;
    expect((await call(admin, 'POST', `/api/contracts/${k3}/service`, { device_id: dl.id, access_type: 'ipoe', mac: '02:4E:58:99:99:99' })).status).toBe(409);
  });

  it('equipamento que usava agente local passa ao RADIUS integrado levando as contas', async () => {
    const ag = (await call(admin, 'POST', '/api/agents', { name: `agente-conv-${tag}` })).body;
    const old = (await call(admin, 'POST', '/api/devices', { name: `nas-conv-${tag}`, driver: 'demo', agent_id: ag.id })).body;
    const a = await account(old.id, 'e');
    // a operação pendente do agente antigo impede a conversão até ser resolvida
    expect((await call(admin, 'POST', `/api/devices/${old.id}/convert-to-integrated`, { vendor: 'mikrotik', nas_ip: ip() })).status).toBe(409);
    await sql(`update operations set status = 'SUPERSEDED', finished_at = now() where device_id = $1 and status = 'PENDING'`, [old.id]);
    const conv = await call(admin, 'POST', `/api/devices/${old.id}/convert-to-integrated`, { vendor: 'mikrotik', nas_ip: ip() });
    expect(conv.status).toBe(200);
    expect(conv.body).toMatchObject({ accounts_requested: 1, accounts_without_secret: 0 });
    expect(conv.body.setup.commands).toContain(conv.body.secret);
    await run();
    expect((await lastOp(a.contractId)).status).toBe('SUCCEEDED');
    expect(await rows('radius_reply', a.username)).toMatchObject({ 'Mikrotik-Group': `rd${tag}` });
    expect((await call(admin, 'POST', `/api/devices/${old.id}/convert-to-integrated`, { vendor: 'mikrotik', nas_ip: ip() })).status).toBe(400);   // já é integrado
  });
});

describe('túnel integrado', () => {
  const SERVER_PUB = newPeerKeys().publicKey;
  it('sem o serviço do túnel no ar o cadastro por túnel é recusado; com ele, o concentrador recebe endereço e chaves próprios', async () => {
    await owner.query('delete from vpn_settings');
    expect((await call(admin, 'GET', '/api/radius/status')).body.vpn.enabled).toBe(false);
    expect((await call(admin, 'POST', '/api/radius/devices', { name: `tun0 ${tag}`, vendor: 'mikrotik', connection: 'vpn' })).status).toBe(503);
    await withScope(noScope, (c) => c.query('select vpn_set_server_key($1)', [SERVER_PUB]));       // o que o serviço do túnel faz ao subir
    expect((await call(admin, 'GET', '/api/radius/status')).body.vpn.enabled).toBe(true);
    expect((await call(admin, 'POST', '/api/radius/devices', { name: `tun-direto ${tag}`, vendor: 'mikrotik', connection: 'direct' })).status).toBe(400);   // direto exige o endereço
    expect((await call(admin, 'POST', '/api/radius/devices', { name: `tun-hw ${tag}`, vendor: 'huawei', connection: 'vpn' })).status).toBe(400);       // sem WireGuard

    const d = (await call(admin, 'POST', '/api/radius/devices', { name: `tun1 ${tag}`, vendor: 'mikrotik', connection: 'vpn' })).body;
    expect(d.nas_ip).toMatch(/^10\.250\.\d+\.\d+$/);
    expect(d.setup).toMatchObject({ connection: 'vpn', server_host: '10.250.0.1', auth_port: 1812, acct_port: 1813 });
    const cmd: string = d.setup.commands;
    const priv = cmd.match(/private-key="([A-Za-z0-9+/]{43}=)"/)![1];
    expect(cmd).toContain(`public-key="${SERVER_PUB}"`);
    expect(cmd).toContain(`address=${d.nas_ip}/32 network=10.250.0.1`);
    expect(cmd).toContain(`/radius add service=ppp,hotspot,dhcp address=10.250.0.1 secret="${d.secret}"`);
    expect(cmd).toContain(`src-address=${d.nas_ip}`);
    expect(cmd).toContain('allowed-address=10.250.0.1/32');
    // a chave privada não fica no sistema: só a pública do par, e as instruções reexibidas trazem marcadores
    const peer = (await sql('select public_key, host(tunnel_ip) as ip from vpn_peers where device_id = $1', [d.id]))[0];
    expect(peer.ip).toBe(d.nas_ip);
    expect(peer.public_key).not.toBe(priv);
    const again = (await call(admin, 'GET', `/api/radius/devices/${d.id}/setup`)).body;
    expect(JSON.stringify(again)).not.toContain(priv);
    expect(again.setup.commands).toContain('<CHAVE PRIVADA DO TÚNEL>');
    // o concentrador é reconhecido pelo endereço do túnel
    expect((await sql('select host(nas_ip) as ip from radius_nas where device_id = $1', [d.id]))[0].ip).toBe(d.nas_ip);
    expect((await call(admin, 'GET', '/api/devices')).body.find((x: any) => x.id === d.id).tunnel).toMatchObject({ ip: d.nas_ip, handshake_at: null });

    // cada concentrador tem o seu endereço; um direto pode ser passado para o túnel depois
    const d2 = (await call(admin, 'POST', '/api/radius/devices', { name: `tun2 ${tag}`, vendor: 'generic', connection: 'vpn' })).body;
    expect(d2.nas_ip).not.toBe(d.nas_ip);
    expect(d2.setup.commands).toContain('Túnel WireGuard');
    const direto = await device('mikrotik');
    const t = await call(admin, 'POST', `/api/radius/devices/${direto.id}/tunnel`);
    expect(t.status).toBe(200);
    expect(t.body.nas_ip).toMatch(/^10\.250\./);
    expect((await sql('select host(nas_ip) as ip, coa_port from radius_nas where device_id = $1', [direto.id]))[0]).toEqual({ ip: t.body.nas_ip, coa_port: 3799 });
    // o serviço do túnel enxerga os pares de todos os provedores só pela função própria; outro provedor não vê o par
    const all = await withScope(noScope, async (c) => (await c.query('select * from vpn_peers_all()')).rows);
    expect(all.some((p: any) => p.tunnel_ip === d.nas_ip)).toBe(true);
    expect((await call(beta, 'GET', `/api/radius/devices/${d.id}/setup`)).status).toBe(404);
    expect(renderServerConf('PRIV', [{ public_key: 'PUB1', tunnel_ip: '10.250.0.2' }])).toBe('[Interface]\nPrivateKey = PRIV\nListenPort = 51820\n\n[Peer]\nPublicKey = PUB1\nAllowedIPs = 10.250.0.2/32\n');
  });

  it('a desconexão sai pelo serviço do túnel quando ele está configurado', async () => {
    const relay = createSocket('udp4');
    const got: Buffer[] = [];
    relay.on('message', (msg, r) => {
      got.push(msg);
      const req = msg.subarray(6);
      const head = Buffer.from([41, req[1], 0, 20]);
      relay.send(Buffer.concat([head, createHash('md5').update(Buffer.concat([head, req.subarray(4, 20), Buffer.from('seg-do-tunel')])).digest()]), r.port, r.address);
    });
    await new Promise<void>((r) => relay.bind(0, '127.0.0.1', r));
    process.env.NEXO_RADIUS_COA_RELAY = `127.0.0.1:${relay.address().port}`;
    try {
      expect(await sendDisconnect({ host: '10.250.0.7', port: 3799, secret: 'seg-do-tunel', username: 'cliente01' }, 300, 2)).toEqual({ outcome: 'ack' });
      expect([...got[0].subarray(0, 6)]).toEqual([10, 250, 0, 7, 0x0e, 0xd7]);       // destino real: 10.250.0.7:3799
      expect(got[0][6]).toBe(40);                                                    // seguido do Disconnect-Request intacto
    } finally { delete process.env.NEXO_RADIUS_COA_RELAY; relay.close(); }
  });
});

