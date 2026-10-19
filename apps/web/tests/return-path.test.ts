import test from "node:test";
import assert from "node:assert/strict";
import { returnPath } from "../features/operations/return-path";
import type { Session } from "../features/session/model";

const user: Session = { id: "u", name: "Financeiro", email: "financeiro@example.invalid", role: "finance", perms: ["subscribers:read", "finance:read", "contracts:read"], modules: [], tenant: { id: "a", name: "Alfa", slug: "alfa" }, support: false, demo: false, mfa_enabled: false, mfa_pending: false };

test("retorno após o login aceita somente destino interno autorizado", () => {
  assert.equal(returnPath(user, { from: "/financeiro/faturas?situacao=Vencida" }), "/financeiro/faturas?situacao=Vencida");
  assert.equal(returnPath(user, { from: "/assinantes?ficha=abc" }), "/assinantes?ficha=abc");
  for (const from of ["//evil.example", "https://evil.example", "/\\evil.example", "/login", "/rede/equipamentos", 42])
    assert.equal(returnPath(user, { from }), null, String(from));
  assert.equal(returnPath(user, null), null);
});
