import type { FastifyInstance, InjectOptions } from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { afterAll } from 'vitest';
import { buildApp } from '../src/app.js';

let app: FastifyInstance | undefined;
let starting: Promise<FastifyInstance> | undefined;
const relayKey = randomBytes(32);
const relayHeader = 'x-nexo-test-context';
const signRelay = (value: string) => createHmac('sha256', relayKey).update(value).digest('hex');

/** D1: o mesmo teste pode atravessar o proxy sem perder suas fixtures locais.
 * O backend de teste fica no processo do Vitest: alterações de env e simuladores
 * continuam visíveis. O contexto assinado reproduz apenas opções do inject.
 */
async function injectHTTP(options: InjectOptions) {
  const base = process.env.NEXO_TEST_BASE_URL!;
  const target = new URL(String(options.url ?? options.path ?? '/'), base);
  if (target.origin !== new URL(base).origin) throw new Error('teste tentou sair da origem do proxy');
  const context = Buffer.from(JSON.stringify({ remoteAddress: options.remoteAddress,
    forwardedProto: options.headers?.['x-forwarded-proto'] })).toString('base64url');
  const headers: Record<string, any> = { ...options.headers, [relayHeader]: `${context}.${signRelay(context)}` };
  let payload = options.payload;
  if (payload != null && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
    payload = JSON.stringify(payload);
    headers['content-type'] ??= 'application/json';
  }
  const data = payload == null ? undefined : Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  if (data) headers['content-length'] = String(data.length);
  return new Promise<any>((resolve, reject) => {
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target,
      { method: String(options.method ?? 'GET'), headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const rawPayload = Buffer.concat(chunks), body = rawPayload.toString('utf8');
          resolve({ statusCode: response.statusCode, headers: response.headers, body, payload: body, rawPayload,
            json: () => JSON.parse(body) });
        });
      });
    request.on('error', reject);
    request.setTimeout(30_000, () => request.destroy(new Error('timeout do proxy de teste')));
    request.end(data);
  });
}

export async function getApp(): Promise<FastifyInstance> {
  if (app) return app;
  starting ??= (async () => {
    const server = await buildApp();
    if (process.env.NEXO_TEST_BASE_URL) {
      server.addHook('onRequest', async (req) => {
        const header = req.headers[relayHeader];
        if (!header) return;
        const [context, signature = ''] = String(header).split('.');
        const expected = Buffer.from(signRelay(context));
        const actual = Buffer.from(signature);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('contexto de teste inválido');
        const data = JSON.parse(Buffer.from(context, 'base64url').toString('utf8'));
        delete req.headers[relayHeader];
        if (data.remoteAddress) Object.defineProperty(req, 'ip', { value: data.remoteAddress });
        if (data.forwardedProto !== undefined) req.headers['x-forwarded-proto'] = data.forwardedProto;
      });
      await server.listen({ host: '127.0.0.1', port: Number(process.env.NEXO_TEST_UPSTREAM_PORT ?? 18181) });
      server.inject = injectHTTP as FastifyInstance['inject'];
    }
    app = server;
    return server;
  })();
  return starting;
}

afterAll(async () => {
  if (process.env.NEXO_TEST_BASE_URL && app) await app.close();
});

export async function login(email: string): Promise<string> {
  const r = await (await getApp()).inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234' } });
  if (r.statusCode !== 200) throw new Error(`login falhou: ${r.body}`);
  return r.json().token;
}
export async function call(token: string | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const r = await (await getApp()).inject({ method: method as any, url, payload: payload as any,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  let body: any;
  try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
}

// ---- agente de teste (protocolo real da API de agentes, sem mTLS no ambiente de teste) ----
import { buildAgentApp } from '../src/agent-api.js';
let agentApp: FastifyInstance | undefined;
export async function agentCall(token: string, path: string, body: unknown = {}) {
  agentApp ??= (await buildAgentApp())!;
  const r = await agentApp.inject({ method: 'POST', url: `/agent/v1/${path}`, payload: body as any, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() };
}
/** Cria agente + NAS de demonstração, sincroniza e devolve um executor mínimo que conclui operações. */
export async function testAgent(admin: string, session = `sess-${Date.now()}`) {
  const a = (await call(admin, 'POST', '/api/agents', { name: `agente-${session}` })).body;
  const dev = (await call(admin, 'POST', '/api/devices', { name: `nas-${session}`, driver: 'demo', agent_id: a.id })).body;
  await agentCall(a.token, 'hello', { session_id: session, version: 'teste' });
  await agentCall(a.token, 'sync-done', { session_id: session, observations: [] });
  const poll = async () => (await agentCall(a.token, 'poll', { session_id: session })).body.operation;
  /** Executa a próxima operação da fila como o agente faria; devolve o envelope ou null. */
  const runNext = async () => {
    const d = await poll();
    if (!d) return null;
    const env = JSON.parse(d.envelope);
    const b = (await agentCall(a.token, `attempts/${d.attempt_id}/begin`)).body;
    if (b.go) await agentCall(a.token, `attempts/${d.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [],
      observed: { policy: env.parameters.policy, profile: env.parameters.profile, session: null, at: new Date().toISOString() } });
    return { ...env, go: b.go };
  };
  return { token: a.token as string, deviceId: dev.id as string, poll, runNext };
}

/** Contrato vigente ainda sem conta PPPoE (a ordem dos arquivos de teste não é garantida). */
export async function freeContract(admin: string, accept: (k: any) => boolean = () => true) {
  for (const k of (await call(admin, 'GET', '/api/contracts?status=active')).body)
    if (accept(k) && !(await call(admin, 'GET', `/api/contracts/${k.id}/service`)).body.resource) return k;
  throw new Error('nenhum contrato livre para o teste');
}
