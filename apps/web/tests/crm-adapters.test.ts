import test from "node:test";
import assert from "node:assert/strict";
import { ticketSchema, projectTicket } from "../features/crm/models";
test("protocolo usa o estado real e não inventa prazo, espera ou incidente",()=>{
 const id="11111111-1111-4111-8111-111111111111";
 const ticket=ticketSchema.parse({id,number:123,subscriber_id:id,subscriber_name:"Titular",contract_id:null,subject:"Contato",category:"technical",priority:"high",status:"waiting",origin:"portal",assignee_id:null,assignee_name:null,created_at:"2026-10-19T10:00:00Z",updated_at:"2026-10-19T10:00:00Z",closed_at:null,sla_due_at:null,sla_breached_at:null,type_id:null,classification_id:null,root_cause_id:null});
 const view=projectTicket(ticket);assert.equal(view.status,"Aguardando o assinante");assert.equal(view.channel,"Portal do assinante");assert.equal(view.agent,"Não atribuído");assert.equal(view.sla,"Sem prazo definido");assert.equal("wait" in view,false);assert.equal(projectTicket({...ticket,sla_due_at:"2026-10-20T10:00:00Z"}).sla,"Prazo registrado");assert.equal(projectTicket({...ticket,sla_breached_at:"2026-10-21T10:00:00Z"}).sla,"Estourado");
});
