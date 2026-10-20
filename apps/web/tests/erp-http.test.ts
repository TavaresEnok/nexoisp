import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient, ApiError } from "../data/erp/http";

test("comandos usam cookie e CSRF sem expor token e preservam contagem paginada", async () => {
 const calls: { path: string; options: RequestInit }[] = [];
 const client = createApiClient(async (path, options) => { calls.push({ path: String(path), options: options! }); const body = String(path) === "/api/me" ? { id: "u", csrf_token: "valor-da-sessao" } : [{ id: "a" }]; return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "X-Total-Count": "73" } }); });
 const page = await client.request("/subscribers?limit=8&offset=8");
 assert.equal(page.total, 73); assert.equal(calls[0].options.credentials, "same-origin"); assert.equal((calls[0].options.headers as Record<string,string>)["Authorization"], undefined);
 await client.request("/subscribers", { body: { name: "Titular" } });
 assert.equal(calls[1].path, "/api/me");
 assert.equal(calls[2].options.method, "POST"); assert.equal((calls[2].options.headers as Record<string,string>)["X-Nexo-CSRF"], "valor-da-sessao"); assert.deepEqual(JSON.parse(calls[2].options.body as string), { name: "Titular" });
 await client.request("/subscribers", { body: { name: "Outro" } });
 assert.equal(calls.length, 4, "o valor CSRF fica em memória após a primeira leitura");
});
test("CSRF vem do login, renova após troca de sessão e é descartado no logout", async () => {
 const calls: { path: string; csrf?: string }[] = []; let session = "a"; let rejected = 0;
 const client = createApiClient(async (path, options) => {
  const csrf = (options?.headers as Record<string, string>)["X-Nexo-CSRF"]; calls.push({ path: String(path), csrf });
  if (path === "/api/auth/login") return new Response(JSON.stringify({ csrf_token: "csrf-a" }));
  if (path === "/api/me") return new Response(JSON.stringify({ csrf_token: `csrf-${session}` }));
  if (csrf !== `csrf-${session}`) { rejected++; return new Response(JSON.stringify({ error: "requisição sem proteção CSRF" }), { status: 403 }); }
  return new Response(JSON.stringify({ ok: true }));
 });
 await client.request("/auth/login", { body: { email: "a", password: "b" } });
 assert.equal(calls[0].csrf, undefined);
 await client.request("/tickets", { body: {} });
 assert.equal(calls.at(-1)!.csrf, "csrf-a");
 session = "b";
 await client.request("/tickets", { body: {} });
 assert.equal(rejected, 1); assert.equal(calls.at(-1)!.csrf, "csrf-b");
 await client.request("/auth/logout", { method: "POST" });
 session = "c";
 await client.request("/tickets", { body: {} });
 assert.equal(rejected, 1, "após logout o próximo comando busca o valor da nova sessão");
});
test("CSRF recusado de novo após renovar não entra em repetição", async () => {
 let commands = 0;
 const client = createApiClient(async (path) => path === "/api/me" ? new Response(JSON.stringify({ csrf_token: "antigo" })) : (commands++, new Response(JSON.stringify({ error: "requisição sem proteção CSRF" }), { status: 403 })));
 await assert.rejects(client.request("/tickets", { body: {} }), error => error instanceof ApiError && error.status === 403);
 assert.equal(commands, 2);
});
test("401 em consulta e download invalida sessão; login incorreto permanece no formulário", async () => {
 let expired = 0; const client = createApiClient(async () => new Response(JSON.stringify({ error: "sessão expirada" }), { status: 401 }), () => expired++);
 await assert.rejects(client.request("/auth/login", { body: {} }), error => error instanceof ApiError && error.status === 401);
 assert.equal(expired, 0); await assert.rejects(client.request("/subscribers")); await assert.rejects(client.download("/documents/a/download")); assert.equal(expired, 2);
});
test("falha de rede propaga erro e não substitui dados por demonstração", async () => {
 const client = createApiClient(async () => { throw new TypeError("offline"); });
 await assert.rejects(client.request("/subscribers"), error => error instanceof ApiError && error.status === 0);
 await assert.rejects(client.request("https://foreign.invalid"), /Caminho de API inválido/);
 await assert.rejects(client.request("//foreign.invalid"), /Caminho de API inválido/);
});
