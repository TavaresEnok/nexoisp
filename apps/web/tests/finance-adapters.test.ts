import test from "node:test";
import assert from "node:assert/strict";
import { policySchema, invoiceSchema, projectInvoice } from "../features/finance/models";
test("política normaliza percentuais numeric do PostgreSQL antes de salvar novamente", () => {
 const policy = policySchema.parse({gateway:"none",demo_mode:true,billing_auto:false,auto_suspend:false,auto_resume_on_payment:false,trust_release_enabled:false,prorate_first_month:false,suspend_after_days:null,trust_release_days:3,trust_release_gap_days:30,late_fee_percent:"2.00",interest_monthly_percent:"1.25",suspension_mode:"reject",suspension_profile:null});
 assert.equal(policy.late_fee_percent,2);assert.equal(policy.interest_monthly_percent,1.25);assert.equal(policy.suspend_after_days,null);
});
test("fatura sem cobrança emitida aceita gateway nulo e preserva o status do servidor", () => {
 const id="11111111-1111-4111-8111-111111111111";
 const invoice=invoiceSchema.parse({id,contract_id:id,subscriber_id:id,subscriber_name:"Titular",plan_name:"Plano",amount_cents:7990,paid_cents:0,due_date:"2026-10-28",competence:"2026-10-01",status:"open",overdue:false,gateway:null,gateway_charge_id:null,fee_cents:0,discount_cents:0});
 const projected=projectInvoice(invoice);assert.equal(projected.amount,79.9);assert.equal(projected.status,"Em aberto");assert.equal(projected.method,"Sem cobrança emitida");assert.equal(projectInvoice({...invoice,overdue:true}).status,"Vencida");assert.equal(projectInvoice({...invoice,status:"paid",overdue:true}).status,"Paga");
});
