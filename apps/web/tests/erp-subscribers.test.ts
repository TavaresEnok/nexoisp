import test from "node:test";
import assert from "node:assert/strict";
import { subscriberDetailSchema, subscriberInput, subscriberCommand } from "../features/subscribers/model";
const id = "11111111-1111-4111-8111-111111111111";
test("cadastro aceita informação ausente e vários contratos sem fabricar plano ou telemetria", () => {
 const data = subscriberDetailSchema.parse({ id, name: "Titular", status: "active", created_at: "2026-10-18T12:00:00Z", email: null, contracts: [1,2].map((n) => ({ id: `11111111-1111-4111-8111-11111111111${n}`, subscriber_id: id, plan_id: id, plan_name: `Plano ${n}`, plan_version: n, price_cents: 9990, down_kbps: 100000, up_kbps: 50000, due_day: 10, start_date: "2026-10-01", status: "active" })) });
 assert.equal(data.contracts.length, 2); assert.equal(data.email, null); assert.equal("signal" in data, false); assert.equal(data.contracts[0].price_cents, 9990);
 const form = subscriberInput(data); assert.equal(form.email, "");
 const body = subscriberCommand({ ...form, name: "Outro titular", id: "ignored" } as typeof form);
 assert.equal(body.name, "Outro titular"); assert.equal("id" in body, false); assert.equal("contracts" in body, false);
});
