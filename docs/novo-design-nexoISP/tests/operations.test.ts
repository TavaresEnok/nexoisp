import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspace, executeCommand, operationalMetrics, assertReferences } from "../lib/operations/domain";
import { commandSchema, workspaceStateSchema, type WorkspaceState } from "../lib/operations/schema";

let sequence = 0;
const context = { actorId: "operator-from-server", createId: () => `test-${++sequence}` };
const run = (state: WorkspaceState, command: unknown) => executeCommand(state, command, context);
const base = () => run(createWorkspace("2026-10-17T12:00:00.000Z"), { type: "plan.create", input: { name: "Fibra 400 Mega", speed: 400, price: 11990 } });
const input = (planId: string) => ({ name: "Pessoa Fictícia", document: "DEMO-TEST-001", email: "teste@example.com", phone: "(00) 00000-0000", address: "Rua Demonstrativa, 100", neighborhood: "Centro", pop: "Centro", planId, dueDay: 10 });
const registered = () => { const state = base(); return run(state, { type: "subscriber.create", input: input(state.plans[0].id) }); };
const connected = () => { let state = registered(); const id = state.operations[0].id; state = run(state, { type: "operation.verify", id }); return run(state, { type: "operation.confirm", id, evidence: "Sessão sintética validada no cenário de teste." }); };
const addTicket = (state: WorkspaceState) => run(state, { type: "ticket.create", input: { subscriberId: state.subscribers[0].id, subject: "Sem conexão demonstrativa", category: "Conexão", channel: "Telefone demonstrativo", priority: "Alta" } });
const addOrder = (state: WorkspaceState, startAt = state.clock) => run(state, { type: "order.create", input: { subscriberId: state.subscribers[0].id, type: "Instalação demonstrativa", technician: "Técnico de teste", startAt, duration: 60 } });

test("workspace começa vazio, sem identidade ou permissão simulada", () => {
  const state = createWorkspace("2026-10-17T12:00:00.000Z");
  assert.equal(state.subscribers.length, 0);
  assert.equal("role" in state, false);
  assert.equal("userId" in state, false);
  assert.deepEqual(workspaceStateSchema.parse(JSON.parse(JSON.stringify(state))), state);
});
test("cadastro cria assinante, contrato, fatura e operação em uma alteração imutável", () => {
  const state = base(); const next = run(state, { type: "subscriber.create", input: input(state.plans[0].id) });
  assert.equal(state.subscribers.length, 0);
  assert.equal(next.subscribers.length, 1);
  assert.equal(next.contracts[0].subscriberId, next.subscribers[0].id);
  assert.equal(next.invoices[0].contractId, next.contracts[0].id);
  assert.equal(next.invoices[0].due, "2026-11-10");
  assert.equal(next.invoices[0].amount, 11990);
  assert.equal(next.operations[0].contractId, next.contracts[0].id);
  assert.equal(next.contracts[0].observed, "Sem leitura");
  assert.equal(next.events[0].actorId, context.actorId);
});
test("vencimento hoje não é deslocado e dezembro avança para janeiro", () => {
  let state = base(); state = run(state, { type: "subscriber.create", input: { ...input(state.plans[0].id), dueDay: 17 } });
  assert.equal(state.invoices[0].due, "2026-10-17");
  const december = base(); december.clock = "2026-12-31T12:00:00.000Z";
  assert.equal(run(december, { type: "subscriber.create", input: input(december.plans[0].id) }).invoices[0].due, "2027-01-10");
});
test("duplicidade de identificador é rejeitada sem mutar o estado", () => {
  const state = registered(); const before = structuredClone(state);
  assert.throws(() => run(state, { type: "subscriber.create", input: { ...input(state.plans[0].id), document: "demo-test-001" } }), /Já existe/);
  assert.deepEqual(state, before);
});
test("plano inexistente ou indisponível impede cadastro", () => {
  const state = base();
  assert.throws(() => run(state, { type: "subscriber.create", input: input("other-workspace-plan") }), /não encontrado/);
  const inactive = run(state, { type: "plan.availability", id: state.plans[0].id, active: false });
  assert.throws(() => run(inactive, { type: "subscriber.create", input: input(state.plans[0].id) }), /não está disponível/);
});
test("entrada rejeita documento real, valores fracionários, vencimento inválido e comandos desconhecidos", () => {
  const state = base();
  for (const bad of [{ document: "12345678900" }, { dueDay: 31 }, { email: "inválido" }]) assert.throws(() => run(state, { type: "subscriber.create", input: { ...input(state.plans[0].id), ...bad } }));
  assert.throws(() => run(state, { type: "plan.create", input: { name: "Plano teste", speed: 100, price: 119.9 } }));
  assert.throws(() => run(state, { type: "preferences", role: "Administrador" }));
  assert.throws(() => run(state, { type: "clock.advance", actorId: "forged" }));
});
test("edição e notas preservam contrato e não substituem autoria do servidor", () => {
  const state = registered(); const original = structuredClone(state.contracts[0]);
  const { name, email, phone, address, neighborhood, pop } = input(state.plans[0].id);
  let next = run(state, { type: "subscriber.edit", id: state.subscribers[0].id, input: { name: `${name} Alterada`, email, phone, address, neighborhood, pop } });
  next = run(next, { type: "subscriber.note", id: state.subscribers[0].id, text: "Observação interna de teste" });
  assert.deepEqual(next.contracts[0], original);
  assert.equal(next.subscribers[0].notes[0].actorId, context.actorId);
  assert.equal(next.subscribers[0].notes[0].visibility, "Interna");
});
test("revisão cria versão sem reprecificar contratos e faturas antigos", () => {
  const state = registered(); const next = run(state, { type: "plan.revise", id: state.plans[0].id, input: { name: "Fibra 400 Mega", speed: 400, price: 12990 } });
  assert.equal(next.plans[0].active, false);
  assert.equal(next.plans[1].version, 2);
  assert.equal(next.plans[1].catalogId, state.plans[0].catalogId);
  assert.deepEqual(next.contracts, state.contracts);
  assert.deepEqual(next.invoices, state.invoices);
  assert.throws(() => run(next, { type: "plan.availability", id: state.plans[0].id, active: true }), /histórica/);
  assert.throws(() => run(next, { type: "plan.revise", id: state.plans[0].id, input: { name: "Fibra 400 Mega", speed: 400, price: 13990 } }), /mais recente/);
});
test("baixa usa valor emitido, atualiza indicadores e impede segunda baixa", () => {
  const state = registered(); const next = run(state, { type: "invoice.pay", id: state.invoices[0].id, method: "Pix demonstrativo" });
  assert.equal(operationalMetrics(next).received, 11990);
  assert.equal(next.contracts[0].observed, "Sem leitura");
  assert.equal(state.invoices[0].paidAt, null);
  assert.throws(() => run(next, { type: "invoice.pay", id: state.invoices[0].id, method: "Pix demonstrativo" }), /já foi paga/);
  assert.equal(commandSchema.safeParse({ type: "invoice.pay", id: state.invoices[0].id, method: "Pix demonstrativo", amount: 1 }).success, false);
});
test("pagamento solicita reativação mas não inventa conexão observada", () => {
  let state = connected(); state = run(state, { type: "contract.access", id: state.contracts[0].id, desired: "Suspenso", reason: "Suspensão demonstrativa autorizada" });
  const suspension = state.operations.at(-1)!;
  state = run(state, { type: "operation.verify", id: suspension.id });
  state = run(state, { type: "operation.confirm", id: suspension.id, evidence: "Acesso suspenso confirmado na simulação." });
  state = run(state, { type: "invoice.pay", id: state.invoices[0].id, method: "Dinheiro demonstrativo" });
  assert.equal(state.contracts[0].desired, "Liberado");
  assert.equal(state.contracts[0].observed, "Desconectado");
  assert.equal(state.operations.at(-1)!.kind, "Reativação");
  assert.equal(state.operations.at(-1)!.status, "Pendente");
});
test("outra fatura vencida impede reativação automática", () => {
  let state = connected(); state.contracts[0].desired = "Suspenso"; state.contracts[0].observed = "Desconectado";
  state.invoices.push({ ...state.invoices[0], id: "overdue", due: "2026-10-10", competence: "2026-10" });
  state = run(state, { type: "invoice.pay", id: state.invoices[0].id, method: "Boleto demonstrativo" });
  assert.equal(state.contracts[0].desired, "Suspenso");
  assert.equal(operationalMetrics(state).overdue, 11990);
  assert.throws(() => run(state, { type: "contract.access", id: state.contracts[0].id, desired: "Liberado", reason: "Reativação demonstrativa solicitada" }), /vencidas/);
});
test("confirmação exige verificação e evidência, com alvo e estado observados separados", () => {
  const state = registered(); const id = state.operations[0].id;
  assert.throws(() => run(state, { type: "operation.confirm", id, evidence: "Evidência demonstrativa de teste" }), /Inicie a verificação/);
  const verifying = run(state, { type: "operation.verify", id });
  assert.throws(() => run(verifying, { type: "operation.confirm", id, evidence: "curta" }));
  assert.equal(verifying.contracts[0].observed, "Sem leitura");
  const next = run(verifying, { type: "operation.confirm", id, evidence: "Sessão sintética confirmada para teste." });
  assert.equal(next.contracts[0].observed, "Conectado");
  assert.equal(next.contracts[0].status, "Ativo");
  assert.throws(() => run(next, { type: "operation.verify", id }), /não está disponível/);
});
test("resultado incerto preserva observado e exige verificar antes de confirmar", () => {
  let state = registered(); const id = state.operations[0].id;
  state = run(state, { type: "operation.verify", id });
  state = run(state, { type: "operation.uncertain", id, evidence: "Evidência insuficiente no cenário sintético." });
  assert.equal(state.contracts[0].observed, "Sem leitura");
  assert.equal(state.operations[0].status, "Incerta");
  assert.throws(() => run(state, { type: "operation.confirm", id, evidence: "Evidência suficiente no cenário sintético." }), /Inicie a verificação/);
  assert.equal(run(state, { type: "operation.verify", id }).operations[0].status, "Verificando");
});
test("mudança de intenção torna operações antigas obsoletas", () => {
  const state = registered(); const next = run(state, { type: "contract.access", id: state.contracts[0].id, desired: "Suspenso", reason: "Suspensão demonstrativa solicitada" });
  assert.equal(next.operations[0].status, "Obsoleta");
  assert.equal(next.operations[1].targetAccess, "Suspenso");
  assert.throws(() => run(next, { type: "operation.verify", id: state.operations[0].id }), /não está disponível/);
});
test("agendamento aplica vigência sem alterar faturas emitidas ou perfil observado", () => {
  let state = connected(); state = run(state, { type: "plan.create", input: { name: "Fibra 600 Mega", speed: 600, price: 14990 } });
  state = run(state, { type: "contract.schedule", id: state.contracts[0].id, input: { planId: state.plans[1].id, dueDay: 20, date: "2026-10-18", reason: "Mudança demonstrativa solicitada" } });
  const invoices = structuredClone(state.invoices), observed = state.contracts[0].observedPlanId;
  const next = run(state, { type: "clock.advance" });
  assert.equal(next.contracts[0].planId, state.plans[1].id);
  assert.equal(next.contracts[0].price, 14990);
  assert.equal(next.contracts[0].observedPlanId, observed);
  assert.equal(next.contracts[0].scheduledChange, null);
  assert.deepEqual(next.invoices, invoices);
  assert.equal(next.operations.at(-1)!.kind, "Mudança de plano");
});
test("mudança de vencimento não dispara operação de rede", () => {
  let state = connected(); state = run(state, { type: "contract.schedule", id: state.contracts[0].id, input: { planId: state.plans[0].id, dueDay: 20, date: "2026-10-18", reason: "Alteração demonstrativa de vencimento" } });
  const next = run(state, { type: "clock.advance" });
  assert.equal(next.contracts[0].dueDay, 20);
  assert.equal(next.operations.length, state.operations.length);
});
test("cancelamento remove mudança e bloqueio conserva agendamento para revisão", () => {
  let state = connected(); const schedule = { type: "contract.schedule", id: state.contracts[0].id, input: { planId: state.plans[0].id, dueDay: 20, date: "2026-10-18", reason: "Alteração demonstrativa de vencimento" } };
  state = run(state, schedule);
  assert.equal(run(state, { type: "contract.cancel-change", id: state.contracts[0].id }).contracts[0].scheduledChange, null);
  assert.throws(() => run(state, schedule), /Cancele/);
  state = run(state, { type: "contract.access", id: state.contracts[0].id, desired: "Suspenso", reason: "Suspensão pendente de verificação" });
  assert.notEqual(run(state, { type: "clock.advance" }).contracts[0].scheduledChange, null);
});
test("atendimento tem ciclo completo com autoria, resolução e reabertura", () => {
  let state = addTicket(registered()); const id = state.tickets[0].id;
  assert.throws(() => run(state, { type: "ticket.transition", id, status: "Resolvido", agent: "Operador teste", reason: "Motivo demonstrativo" }), /não permitida/);
  for (const status of ["Em atendimento", "Aguardando", "Resolvido", "Aberto"]) state = run(state, { type: "ticket.transition", id, status, agent: "Operador teste", reason: `Transição demonstrativa para ${status}` });
  assert.equal(state.tickets[0].status, "Aberto");
  assert.equal(state.tickets[0].notes.length, 4);
  assert.equal(operationalMetrics(state).openTickets, 1);
});
test("notas internas e respostas demonstrativas não se confundem", () => {
  let state = addTicket(registered()); const id = state.tickets[0].id;
  for (const visibility of ["Interna", "Resposta demonstrativa"]) state = run(state, { type: "ticket.note", id, text: "Conteúdo fictício para o teste", visibility });
  assert.equal(state.tickets[0].notes[0].visibility, "Resposta demonstrativa");
  assert.equal(state.tickets[0].notes[1].visibility, "Interna");
  state = run(state, { type: "ticket.transition", id, status: "Em atendimento", agent: "Operador teste", reason: "Assumindo atendimento demonstrativo" });
  state = run(state, { type: "ticket.transition", id, status: "Resolvido", agent: "Operador teste", reason: "Resolução demonstrativa confirmada" });
  assert.throws(() => run(state, { type: "ticket.note", id, text: "Nova nota interna", visibility: "Interna" }), /Reabra/);
});
test("agenda impede sobreposição e aceita visitas consecutivas", () => {
  const state = addOrder(registered());
  assert.throws(() => addOrder(state, "2026-10-17T12:30:00.000Z"), /intervalo/);
  assert.equal(addOrder(state, "2026-10-17T13:00:00.000Z").orders.length, 2);
  assert.throws(() => addOrder(state, "2026-10-17T11:00:00.000Z"), /passado/);
});
test("reagendamento valida intervalo ignorando apenas a própria ordem", () => {
  let state = addOrder(registered()); const id = state.orders[0].id;
  state = run(state, { type: "order.reschedule", id, startAt: "2026-10-17T14:00:00.000Z", technician: "Outro técnico", duration: 120, reason: "Reagendamento demonstrativo solicitado" });
  assert.equal(state.orders[0].duration, 120);
  assert.equal(state.orders[0].technician, "Outro técnico");
});
test("ordem exige início, horário e evidência para concluir, sem alterar conexão", () => {
  let state = addOrder(registered()); const id = state.orders[0].id;
  assert.throws(() => run(state, { type: "order.transition", id, status: "Concluída", result: "Conclusão demonstrativa de teste" }), /não permitida/);
  state = run(state, { type: "order.transition", id, status: "Em execução", result: "Início demonstrativo da visita" });
  assert.throws(() => run(state, { type: "order.transition", id, status: "Concluída", result: "curta" }));
  state = run(state, { type: "order.transition", id, status: "Concluída", result: "Instalação sintética concluída com evidência de teste" });
  assert.equal(state.contracts[0].observed, "Sem leitura");
  assert.equal(operationalMetrics(state).activeOrders, 0);
  assert.throws(() => run(state, { type: "order.transition", id, status: "Em execução", result: "Tentativa de repetir conclusão" }), /não permitida/);
  const future = addOrder(registered(), "2026-10-18T12:00:00.000Z");
  assert.throws(() => run(future, { type: "order.transition", id: future.orders[0].id, status: "Em execução", result: "Início antecipado demonstrativo" }), /horário/);
});
test("cancelamento libera intervalo e impede conclusão posterior", () => {
  let state = addOrder(registered()); const id = state.orders[0].id;
  state = run(state, { type: "order.transition", id, status: "Cancelada", result: "Cancelamento demonstrativo solicitado" });
  assert.equal(addOrder(state).orders.length, 2);
  assert.throws(() => run(state, { type: "order.transition", id, status: "Concluída", result: "Conclusão de uma ordem cancelada" }), /não permitida/);
});
test("IDs ausentes do estado são recusados; isso não substitui autorização no servidor", () => {
  const state = registered(); const foreign = "foreign-workspace-id";
  for (const command of [
    { type: "invoice.pay", id: foreign, method: "Pix demonstrativo" },
    { type: "subscriber.note", id: foreign, text: "Nota demonstrativa" },
    { type: "ticket.create", input: { subscriberId: foreign, subject: "Teste demonstrativo", category: "Conexão", channel: "Telefone", priority: "Alta" } },
    { type: "operation.verify", id: foreign },
  ]) assert.throws(() => run(state, command), /não encontrado/);
});
test("invariantes detectam duplicidade, vínculo inválido e mensalidade repetida", () => {
  const state = registered(); const duplicate = structuredClone(state); duplicate.subscribers.push(duplicate.subscribers[0]);
  assert.throws(() => assertReferences(duplicate), /duplicados/);
  const wrongSubscriber = structuredClone(state); wrongSubscriber.invoices[0].subscriberId = "missing";
  assert.throws(() => assertReferences(wrongSubscriber), /diferente/);
  const duplicateInvoice = structuredClone(state); duplicateInvoice.invoices.push({ ...duplicateInvoice.invoices[0], id: "duplicate" });
  assert.throws(() => assertReferences(duplicateInvoice), /Mensalidade duplicada/);
});
test("autor é obrigatório e falha nunca modifica o estado anterior", () => {
  const state = registered(); const before = structuredClone(state);
  assert.throws(() => executeCommand(state, { type: "clock.advance" }, { actorId: "" }), /autor/);
  assert.throws(() => run(state, { type: "operation.confirm", id: state.operations[0].id, evidence: "Confirmação sem início de verificação" }));
  assert.deepEqual(state, before);
});
