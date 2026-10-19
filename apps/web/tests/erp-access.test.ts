import test from "node:test";
import assert from "node:assert/strict";
import { canAccessPath, canonicalErpPath } from "../features/operations/navigation";
import { sessionScope, type Session } from "../features/session/model";
const user: Session = { id: "u", name: "Financeiro", email: "financeiro@example.invalid", role: "finance", perms: ["subscribers:read", "finance:read", "contracts:read", "portal:self"], modules: [], tenant: { id: "a", name: "Alfa", slug: "alfa" }, support: false, demo: false, mfa_enabled: false, mfa_pending: false };
test("permissões e módulos protegem URLs diretas e mantêm os significados do Go", () => {
 assert.equal(canonicalErpPath("/operacoes"), "/rede/operacoes"); assert.equal(canonicalErpPath("/rede"), "/rede/equipamentos");
 assert.equal(canAccessPath(user, "/assinantes"), true); assert.equal(canAccessPath(user, "/financeiro/faturas"), true); assert.equal(canAccessPath(user, "/rede/equipamentos"), false); assert.equal(canAccessPath(user, "/provedores"), false);
 const tech = { ...user, role: "noc" as const, perms: ["network:read", "os:read"], modules: [] };
 assert.equal(canAccessPath(tech, "/rede/equipamentos"), true); assert.equal(canAccessPath(tech, "/ordens-de-servico"), false); assert.equal(canAccessPath({ ...tech, modules: ["field"] }, "/ordens-de-servico"), true);
});
test("MFA pendente restringe navegação; portal e plataforma exigem contextos próprios", () => {
 assert.equal(canAccessPath({ ...user, mfa_pending: true }, "/assinantes"), false); assert.equal(canAccessPath({ ...user, mfa_pending: true }, "/conta"), true);
 const subscriber = { ...user, role: "subscriber" as const, perms: ["portal:self"] };
 assert.equal(canAccessPath(subscriber, "/portal"), true); assert.equal(canAccessPath(subscriber, "/assinantes"), false);
 const operator = { ...user, role: "saas_operator" as const, tenant: null, perms: ["tenants:manage"] };
 assert.equal(canAccessPath(operator, "/provedores"), true); assert.equal(canAccessPath(operator, "/assinantes"), false); assert.equal(canAccessPath({ ...operator, support: true }, "/provedores"), false);
});
test("escopo de cache muda com identidade, provedor, suporte e permissões", () => {
 const key = sessionScope(user);
 assert.notEqual(key, sessionScope({ ...user, id: "another" })); assert.notEqual(key, sessionScope({ ...user, tenant: { id: "b", name: "Beta", slug: "beta" } })); assert.notEqual(key, sessionScope({ ...user, support: true })); assert.notEqual(key, sessionScope({ ...user, perms: ["subscribers:read"] }));
});
