import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient, ApiError } from "../data/erp/http";

test("comandos usam cookie e CSRF sem expor token e preservam contagem paginada", async () => {
 const calls: { path: string; options: RequestInit }[] = [];
 const client = createApiClient(async (path, options) => { calls.push({ path: String(path), options: options! }); return new Response(JSON.stringify([{ id: "a" }]), { headers: { "Content-Type": "application/json", "X-Total-Count": "73" } }); });
 const page = await client.request("/subscribers?limit=8&offset=8");
 assert.equal(page.total, 73); assert.equal(calls[0].options.credentials, "same-origin"); assert.equal((calls[0].options.headers as Record<string,string>)["Authorization"], undefined);
 await client.request("/subscribers", { body: { name: "Titular" } });
 assert.equal(calls[1].options.method, "POST"); assert.equal((calls[1].options.headers as Record<string,string>)["X-Nexo-CSRF"], "1"); assert.deepEqual(JSON.parse(calls[1].options.body as string), { name: "Titular" });
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
