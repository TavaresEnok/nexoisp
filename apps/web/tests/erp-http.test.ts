import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient, ApiError } from "../data/erp/http";

test("contexto aceito envia CSRF e precondição; troca não repete intenção", async () => {
 let context = "a", commands = 0, invalidations = 0;
 const client = createApiClient(async (path, options) => {
  const headers = options?.headers as Record<string, string>;
  if (path === "/api/me") return new Response(JSON.stringify({ session_context: context, csrf_token: `csrf-${context}` }), { headers: { "X-Nexo-Context": context } });
  commands++;
  assert.equal(headers["X-Nexo-Context"], context);
  assert.equal(headers["X-Nexo-CSRF"], `csrf-${context}`);
  return new Response(JSON.stringify({ ok: true }), { headers: { "X-Nexo-Context": context } });
 }, () => invalidations++);
 await assert.rejects(client.request("/tickets", { body: {} }), ApiError);
 (await client.session()).accept();
 await client.request("/tickets", { body: {} });
 context = "b";
 await assert.rejects(client.request("/tickets", { body: {} }), ApiError);
 await assert.rejects(client.request("/tickets", { body: {} }), ApiError);
 assert.equal(commands, 1); assert.ok(invalidations >= 1);
 (await client.session()).accept();
 await client.request("/tickets", { body: {} });
 assert.equal(commands, 2);
});

test("mudança após pré-checagem, leitura em background e 401 invalidam sem retry", async () => {
 let current = "a", calls = 0, invalidations = 0, mode = "normal";
 const client = createApiClient(async (path) => {
  if (path === "/api/me") return new Response(JSON.stringify({ session_context: current, csrf_token: "csrf" }), { headers: { "X-Nexo-Context": current } });
  calls++;
  if (mode === "401") return new Response('{}', { status: 401 });
  if (mode === "race") current = "b";
  return new Response('{}', { status: mode === "race" ? 409 : 200, headers: { "X-Nexo-Context": current } });
 }, () => invalidations++);
 (await client.session()).accept(); mode = "race";
 await assert.rejects(client.request("/tickets", { body: {} }), ApiError);
 assert.equal(calls, 1);
 (await client.session()).accept(); current = "c"; mode = "normal";
 await assert.rejects(client.request("/me"), ApiError);
 (await client.session()).accept(); mode = "401";
 await assert.rejects(client.request("/tickets"), ApiError);
 assert.equal(invalidations, 3);
});

test("falha de rede e caminhos inválidos não selecionam dados fictícios", async () => {
 const client = createApiClient(async () => { throw new TypeError("offline"); });
 await assert.rejects(client.request("/health"), error => error instanceof ApiError && error.status === 0);
 await assert.rejects(client.request("https://foreign.invalid"), /Caminho de API inválido/);
});

test("contagem paginada e CSRF recusado preservam sem retry", async () => {
 let writes = 0;
 const client = createApiClient(async (path, options) => {
  if (path === "/api/me") return new Response(JSON.stringify({ session_context: "a", csrf_token: "csrf" }), { headers: { "X-Nexo-Context": "a" } });
  assert.equal(options?.credentials, "same-origin");
  if (options?.method === "POST") { writes++; return new Response(JSON.stringify({ error: "requisição sem proteção CSRF" }), { status: 403 }); }
  return new Response('[]', { headers: { "X-Nexo-Context": "a", "X-Total-Count": "73" } });
 });
 (await client.session()).accept();
 assert.equal((await client.request('/subscribers')).total, 73);
 await assert.rejects(client.request('/subscribers', { body: {} }), ApiError);
 assert.equal(writes, 1);
});

test("resposta antiga em voo não invalida prova recém aceita", async () => {
 let release!: (response: Response) => void, invalidations = 0, context = "a";
 const client = createApiClient(async (path) => {
  if (path === "/api/me") return new Response(JSON.stringify({ session_context: context, csrf_token: "csrf" }), { headers: { "X-Nexo-Context": context } });
  if (path === "/api/today") return new Promise<Response>(resolve => { release = resolve; });
  return new Response('{}', { headers: { "X-Nexo-Context": context } });
 }, () => invalidations++);
 (await client.session()).accept();
 const pending = client.request('/today');
 context = 'b';
 client.beginSessionTransition();
 (await client.session()).accept();
 release(new Response('{}', { status: 401 }));
 await assert.rejects(pending, ApiError);
 await client.request('/tickets');
 assert.equal(invalidations, 0);
});

test("transição isola respostas antigas enquanto /me está pendente e mantém 401 corrente fechado", async () => {
 let releaseOld!: (response: Response) => void, releaseMe!: (response: Response) => void;
 let context = "a", delayMe = false, revoked = false, invalidations = 0;
 const client = createApiClient(async (path) => {
  if (path === "/api/me") {
   if (delayMe) return new Promise<Response>(resolve => { releaseMe = resolve; });
   return new Response(JSON.stringify({ session_context: context, csrf_token: "csrf" }), { headers: { "X-Nexo-Context": context } });
  }
  if (path === "/api/today") return new Promise<Response>(resolve => { releaseOld = resolve; });
  return new Response('{}', revoked ? { status: 401 } : { headers: { "X-Nexo-Context": context } });
 }, () => invalidations++);
 (await client.session()).accept();
 const old = client.request('/today');
 client.beginSessionTransition();
 context = 'b'; delayMe = true;
 const candidate = client.session();
 releaseOld(new Response('{}', { status: 409, headers: { "X-Nexo-Context": 'b' } }));
 await assert.rejects(old, ApiError);
 await assert.rejects(client.request('/tickets'), ApiError);
 assert.equal(invalidations, 0);
 releaseMe(new Response(JSON.stringify({ session_context: 'b', csrf_token: 'csrf' }), { headers: { "X-Nexo-Context": 'b' } }));
 (await candidate).accept();
 await client.request('/tickets');
 revoked = true;
 await assert.rejects(client.request('/tickets'), ApiError);
 assert.equal(invalidations, 1);
});
