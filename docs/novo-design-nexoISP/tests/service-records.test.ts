import test from "node:test";
import assert from "node:assert/strict";
import { getSubscriberServiceRecords } from "../lib/service-records";
import { buildWorkOrderPrintDocument } from "../lib/work-order-print";
import type { Subscriber, WorkOrder, WorkspaceData } from "../lib/types";

const subscriber = { id: "a", code: "DEMO-1", name: "Pessoa de Teste", address: "Rua Fictícia, 1", neighborhood: "Centro", phone: "(00) 00000-0000", plan: "Fibra", speed: 400, nas: "NAS demonstração", pop: "Centro", connection: "Online", onu: "DEMO12345678" } as Subscriber;
const order: WorkOrder = { id: "o1", subscriberId: "a", code: 123, name: subscriber.name, type: "Reparo óptico", technician: "Técnica de Teste", time: "09:30", duration: 60, status: "Agendada", neighborhood: "Centro", notes: "Conteúdo interno reservado à equipe" };
const data = { snapshot: { asOf: "2026-10-17T12:00:00Z" }, invoices: [], nodes: [], orders: [order, { ...order, id: "o2", subscriberId: "b", notes: "Registro de outro assinante" }], tickets: [{ id: "t1", code: 456, subscriberId: "a", subject: "Oscilação da conexão", opened: "2026-10-17", status: "Em atendimento", agent: "Operador", category: "Conexão", channel: "Telefone", priority: "Alta" }, { id: "t2", subscriberId: "b", opened: "2026-10-17", status: "Aberto" }], activities: [{ id: "a1", subscriberId: "a", title: "Evento de teste", description: "Registro já disponível", time: "09:00" }, { id: "a2", subscriberId: "b", title: "Outro titular" }] } as unknown as WorkspaceData;

test("a consulta de serviço isola chamados, OS e registros pelo assinante", () => {
  const records = getSubscriberServiceRecords(subscriber, data);
  assert.equal(records.tickets.length, 1);
  assert.equal(records.orders.length, 1);
  assert.equal(records.records.length, 2);
  assert.equal(records.records[0].reference, "OS #123");
  assert.equal(records.records[1].source, "Evento do assinante");
  assert.equal("ticketId" in records.orders[0], false);
  assert.equal("author" in records.records[0], false);
});

test("busca ignora acentuação, espaços externos e combina situação sem alterar totais", () => {
  const records = getSubscriberServiceRecords(subscriber, data, "  OSCILACAO  ", "Em atendimento");
  assert.equal(records.tickets.length, 1);
  assert.equal(records.orders.length, 0);
  assert.equal(records.profile.orders.length, 1);
  assert.equal(records.recordCount, 2);
  assert.equal(getSubscriberServiceRecords(subscriber, data, "tecnica").orders.length, 1);
  assert.equal(getSubscriberServiceRecords(subscriber, data, "123").records.length, 1);
  assert.equal(getSubscriberServiceRecords(subscriber, data, "inexistente").records.length, 0);
  assert.equal(getSubscriberServiceRecords(subscriber, data, "", "Resolvido").tickets.length, 0);
});

test("a impressão usa dados da OS sem incluir notas internas, senhas ou vínculos presumidos", () => {
  const html = buildWorkOrderPrintDocument(order, subscriber, "Provedor de teste", data.snapshot.asOf);
  assert.match(html, /OS #123/);
  assert.match(html, /Pessoa de Teste/);
  assert.match(html, /Reparo óptico/);
  assert.match(html, /FICHA DEMONSTRATIVA/);
  assert.match(html, /Vínculo específico não informado/);
  assert.match(html, /Observações internas não integram esta ficha/);
  assert.doesNotMatch(html, /Conteúdo interno reservado/);
  assert.doesNotMatch(html, /<script|senha|password/i);
});

test("a ficha escapa conteúdo HTML de todos os campos e rejeita outro assinante", () => {
  const payload = '<img src=x onerror="alert(1)">';
  const html = buildWorkOrderPrintDocument({ ...order, type: payload }, { ...subscriber, name: payload }, payload, data.snapshot.asOf);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.throws(() => buildWorkOrderPrintDocument(order, { ...subscriber, id: "b" }, "Teste", data.snapshot.asOf), /não corresponde/);
  assert.match(buildWorkOrderPrintDocument(order, undefined, "Teste", data.snapshot.asOf), /Não disponível/);
});
