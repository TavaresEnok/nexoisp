import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCoordinate,
  publicViabilityPath,
  publicViabilitySchema,
  viabilityResultSchema,
  whatsappLink,
} from "../features/viability/models";
import { sessionRestricted, type Session } from "../features/session/model";
import { canAccessPath } from "../features/operations/navigation";

test("coordenadas aceitam vírgula decimal e recusam faixa ou formato inválido", () => {
  assert.equal(parseCoordinate("-3,7319", "latitude"), -3.7319);
  assert.equal(parseCoordinate(" -38.526700 ", "longitude"), -38.5267);
  for (const raw of ["", "91", "-90.0001", "abc", "1e3", "--3", "3.7.1"])
    assert.equal(parseCoordinate(raw, "latitude"), null, raw);
  assert.equal(parseCoordinate("-180", "longitude"), -180);
  assert.equal(parseCoordinate("180.5", "longitude"), null);
});

test("WhatsApp e caminho público não aceitam valores fora do formato", () => {
  assert.equal(whatsappLink("+55 (85) 99999-0000"), "https://wa.me/5585999990000");
  assert.equal(whatsappLink("123"), null);
  assert.equal(whatsappLink(null), null);
  assert.equal(publicViabilityPath("provedor/../x"), "/public/viabilidade/provedor%2F..%2Fx");
});

test("respostas públicas só carregam marca, contato e o booleano de cobertura", () => {
  const page = publicViabilitySchema.parse({ name: "Alfa", logo: null, message: null, phone: null, whatsapp: null, lead_capture: true, tenant_id: "oculto" });
  assert.equal(Object.hasOwn(page, "tenant_id"), false);
  const result = viabilityResultSchema.parse({ covered: true, lead_capture: false, phone: null, whatsapp: null, distance: 12 });
  assert.deepEqual(Object.keys(result).sort(), ["covered", "lead_capture", "phone", "whatsapp"]);
  assert.throws(() => viabilityResultSchema.parse({ covered: "sim", lead_capture: false, phone: null, whatsapp: null }));
});

test("senha provisória restringe a sessão à própria conta", () => {
  const user: Session = { id: "u", name: "Equipe", email: "equipe@example.invalid", role: "attendant", perms: ["subscribers:read"], modules: [], tenant: { id: "a", name: "Alfa", slug: "alfa" }, support: false, demo: false, mfa_enabled: true, mfa_pending: false, password_change_required: true };
  assert.equal(sessionRestricted(user), true);
  assert.equal(canAccessPath(user, "/assinantes"), false);
  assert.equal(canAccessPath(user, "/conta"), true);
  assert.equal(sessionRestricted({ ...user, password_change_required: false }), false);
  assert.equal(canAccessPath({ ...user, password_change_required: false }, "/assinantes"), true);
});
