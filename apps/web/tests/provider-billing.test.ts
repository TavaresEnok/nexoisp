import test from "node:test";
import assert from "node:assert/strict";
import { readProviderIntent, sendProviderIntent, providerIntentTerminal, providerIntentKey, type ProviderIntent, type ProviderBillingData } from "../features/finance/provider-billing-model";
import { issuanceBody, operationBody } from "../features/finance/provider-billing-forms";

const invoice = "10000000-0000-4000-8000-000000000001";
const connection = "10000000-0000-4000-8000-000000000002";
const intention = "10000000-0000-4000-8000-000000000003";
const journal = "10000000-0000-4000-8000-000000000004";
function storage(): Storage {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, clear: () => map.clear(), key: (i) => [...map.keys()][i] ?? null, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
}
const candidate: ProviderIntent = { invoice_id: invoice, connection_id: connection, intent_id: intention, kind: "issue", body: { invoice_id: invoice, options: { product: "pix_cob" } } };
test("provider intent survives accepted preparation and lost response; replay freezes original destination and body", async () => {
  const s = storage(), sent: unknown[] = [];
  await assert.rejects(sendProviderIntent(s, "key", candidate, async (path, body) => { sent.push({ path, body }); throw Error("response lost after commit"); }));
  await sendProviderIntent(s, "key", { ...candidate, connection_id: invoice, body: { different: true } }, async (path, body) => { sent.push({ path, body }); });
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(readProviderIntent(s, "key", invoice)?.intent_id, intention);
  const data = { issuances: [{ financial_connection_id: connection, intent_id: intention, state: "uncertain" }], operations: [] } as unknown as ProviderBillingData;
  assert.equal(providerIntentTerminal(candidate, data), false);
  data.issuances[0].state = "issued";
  assert.equal(providerIntentTerminal(candidate, data), true);
  s.removeItem("key");
  const next = { ...candidate, intent_id: journal };
  await sendProviderIntent(s, "key", next, async () => {});
  assert.equal(readProviderIntent(s, "key", invoice)?.intent_id, journal);
});
test("unavailable/malformed storage and wrong invoice stop a request; conflicts preserve pending intention", async () => {
  const s = storage(); let calls = 0;
  s.setItem("key", JSON.stringify({ ...candidate, invoice_id: connection }));
  await assert.rejects(sendProviderIntent(s, "key", candidate, async () => { calls++; }));
  assert.equal(calls, 0);
  s.clear(); s.setItem = () => { throw Error("quota"); };
  await assert.rejects(sendProviderIntent(s, "key", candidate, async () => { calls++; }));
  assert.equal(calls, 0);
  for (const status of [400, 422, 409, 500]) {
    const s = storage();
    await assert.rejects(sendProviderIntent(s, "key", candidate, async () => { throw { status }; }));
    assert.equal(Boolean(readProviderIntent(s, "key", invoice)), status === 409 || status === 500);
  }
  assert.notEqual(providerIntentKey("a", "u", invoice, true), providerIntentKey("b", "u", invoice, true));
});
test("compatible product payloads keep Cob/CobV/Bolix semantics and omit client-owned amounts/dates", () => {
  const data = { accounts: [{ id: connection, products: ["pix_cob", "pix_cobv", "bolix"] }] } as unknown as ProviderBillingData;
  const common = { name: "Synthetic", document: "12345678000190", street: "Street", city: "Fortaleza", state: "ce", zip: "60000000", email: "synthetic@example.invalid", number: "1", neighborhood: "Synthetic" };
  const cob = issuanceBody(invoice, { ...common, choice: `${connection}:pix_cob`, expiration: "3600" }, data);
  assert.deepEqual(cob, { invoice_id: invoice, options: { product: "pix_cob", expiration_seconds: 3600 } });
  const cobv = issuanceBody(invoice, { ...common, choice: `${connection}:pix_cobv`, valid_days: "30" }, data);
  assert.deepEqual((cobv.options as Record<string, unknown>).debtor, { nome: "Synthetic", cnpj: common.document, logradouro: "Street", cidade: "Fortaleza", uf: "CE", cep: "60000000" });
  const bolix = issuanceBody(invoice, { ...common, choice: `${connection}:bolix` }, data);
  assert.deepEqual(((bolix.options as Record<string, unknown>).customer as Record<string, unknown>).juridical_person, { corporate_name: "Synthetic", cnpj: common.document });
  assert.equal("issued_on" in (bolix.options as Record<string, unknown>), false);
  assert.throws(() => issuanceBody(invoice, { ...common, choice: `${invoice}:bolix` }, data));
});
test("partial refunds respect server reservation projection; rejected or confirmed journal unlocks a new legitimate intention", () => {
  const data = { refund_payments: [{ id: invoice, refundable_cents: 2000 }], operations: [{ intent_id: intention, issuance_id: journal, state: "prepared" }] } as unknown as ProviderBillingData;
  const values = { payment: invoice, amount: "20,00", reason: "Synthetic refund reason" };
  assert.equal(operationBody(values, true, data).amount_cents, 2000);
  assert.throws(() => operationBody({ ...values, amount: "20,01" }, true, data));
  const refund = { ...candidate, kind: "refund" as const, issuance_id: journal };
  assert.equal(providerIntentTerminal(refund, data), false);
  data.operations[0].state = "rejected";
  assert.equal(providerIntentTerminal(refund, data), true);
});

test("resolution and replacement persist their own intentions after lost ACK without reusing initial issuance", async () => {
  for (const kind of ["resolve", "reissue"] as const) {
    const s = storage();
    const intent = { ...candidate, kind, issuance_id: journal, body: { reason: "Authenticated synthetic review" } };
    const sent: unknown[] = [];
    await assert.rejects(sendProviderIntent(s, "key", intent, async (path, body) => { sent.push({path,body}); throw Error("lost ACK"); }));
    await sendProviderIntent(s,"key",{...intent,intent_id:invoice,body:{reason:"Changed"}},async(path,body)=>{sent.push({path,body});});
    assert.deepEqual(sent[0], sent[1]);
    assert.equal((sent[0] as {path:string}).path, `/financial-connections/${connection}/issuance/${journal}/${kind}`);
    const data = {issuances:[],operations:[],resolutions:[{intent_id:intention,issuance_id:journal,kind,status:"removed"}]} as unknown as ProviderBillingData;
    assert.equal(providerIntentTerminal(intent,data),kind === "resolve");
    data.issuances = [{intent_id:intention, financial_connection_id:connection,state:"prepared"}] as ProviderBillingData["issuances"];
    if (kind === "reissue") { assert.equal(providerIntentTerminal(intent,data),false); data.issuances[0].state="issued";assert.equal(providerIntentTerminal(intent,data),true); }
  }
});
