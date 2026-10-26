import { test } from "node:test";
import assert from "node:assert/strict";
import { paymentIntentKey, readPaymentIntent, sendPaymentIntent } from "../features/finance/payment-intent";
function storage(): Storage {
 const values = new Map<string,string>();
 return {get length(){return values.size}, clear(){values.clear()}, key(i){return [...values.keys()][i]??null}, getItem(k){return values.get(k)??null}, setItem(k,v){values.set(k,v)},removeItem(k){values.delete(k)}};
}
test("response lost after commit: persisted intent and original payload survive remount", async () => {
 const s=storage(), calls:unknown[]=[]; const body={amount_cents:2000}, form={amount:"20,00"};
 await assert.rejects(sendPaymentIntent(s,"key",body,form,async b=>{calls.push(b);throw new Error("response lost")},()=>"first"));
 assert.equal(readPaymentIntent(s,"key")?.intent_id,"first");
 await sendPaymentIntent(s,"key",{amount_cents:9999},{},async b=>{calls.push(b)},()=>"must-not-use");
 assert.deepEqual([...calls],[{amount_cents:2000,intent_id:"first"},{amount_cents:2000,intent_id:"first"}]);
 assert.equal(readPaymentIntent(s,"key"),null);
 await sendPaymentIntent(s,"key",body,form,async b=>{calls.push(b)},()=>"second");
 assert.deepEqual(calls[2],{amount_cents:2000,intent_id:"second"});
});
test("cannot send without durable storage",async()=>{
 const s=storage();s.setItem=()=>{throw Error("quota")};let sent=false;
 await assert.rejects(sendPaymentIntent(s,"key",{},{},async()=>{sent=true},()=>"id"));assert.equal(sent,false);
});
test("definite input rejection can be corrected; conflict and ambiguous failures preserve intent",async()=>{
 for(const status of [400,422,409,408,429,500,0]){
  const s=storage(); await assert.rejects(sendPaymentIntent(s,"key",{},{},async()=>{throw {status}},()=>"id"));
  assert.equal(Boolean(readPaymentIntent(s,"key")),![400,422].includes(status));
 }
});
test("storage is scoped to tenant, actor and invoice; malformed state fails closed",()=>{
 assert.notEqual(paymentIntentKey("t1","u","i"),paymentIntentKey("t2","u","i"));
 assert.notEqual(paymentIntentKey("t","u1","i"),paymentIntentKey("t","u2","i"));
 const s=storage();s.setItem("key","{}");assert.throws(()=>readPaymentIntent(s,"key"));
});
