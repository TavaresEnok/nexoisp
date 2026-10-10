import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance | undefined;
export async function getApp() {
  return (app ??= await buildApp());
}
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
