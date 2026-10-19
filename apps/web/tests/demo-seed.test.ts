import test from "node:test";
import assert from "node:assert/strict";
import seed from "../lib/db/demo-seed.json";
import { demoSeedSchema } from "../lib/db/demo-seed-schema";

test("seed reproduz os 82 registros públicos sem credenciais de banco ou autenticação", () => {
  const parsed = demoSeedSchema.parse(seed);
  assert.equal(parsed.records.length, 82);
  assert.equal(parsed.scope, "public-demo");
  assert.doesNotMatch(JSON.stringify(parsed), /postgres(?:ql)?:\/\/|accessToken|refreshToken|session_token|passwordHash/);
});
test("seed recusa escopo privado, snapshot ausente e IDs duplicados", () => {
  assert.equal(demoSeedSchema.safeParse({ ...seed, scope: "another-user" }).success, false);
  assert.equal(demoSeedSchema.safeParse({ ...seed, records: seed.records.filter(row => row.kind !== "snapshot") }).success, false);
  assert.equal(demoSeedSchema.safeParse({ ...seed, records: [...seed.records, seed.records[0]] }).success, false);
});
test("seed e consulta compartilham validação dos campos do payload", () => {
  const invalid = structuredClone(seed);
  const invoice = invalid.records.find(row => row.kind === "invoice")!;
  invoice.payload = { ...invoice.payload, amount: "149,90" } as unknown as typeof invoice.payload;
  assert.equal(demoSeedSchema.safeParse(invalid).success, false);
});
test("seed recusa cobranças, chamados e ordens sem assinante correspondente", () => {
  for (const kind of ["invoice", "ticket", "order"]) {
    const invalid = structuredClone(seed);
    const row = invalid.records.find(record => record.kind === kind)!;
    assert.ok(row);
    row.payload = { ...row.payload, subscriberId: "nonexistent" } as typeof row.payload;
    assert.equal(demoSeedSchema.safeParse(invalid).success, false);
  }
});
