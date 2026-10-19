import { commandSchema, workspaceStateSchema, type WorkspaceState, type ExecutionContext } from "./schema";

export class DomainError extends Error {}
export function createWorkspace(clock: string): WorkspaceState {
  return workspaceStateSchema.parse({ version: 1, clock, plans: [], subscribers: [], contracts: [], invoices: [], operations: [], tickets: [], orders: [], events: [] });
}
function demand(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError(message);
}
function find<T extends { id: string }>(rows: T[], id: string, label: string): T {
  const row = rows.find(value => value.id === id);
  if (!row) throw new DomainError(`${label} não encontrado neste workspace.`);
  return row;
}
const terminal = (op: WorkspaceState["operations"][number]) => op.status === "Concluída" || op.status === "Obsoleta";
export function assertReferences(state: WorkspaceState) {
  for (const rows of [state.plans, state.subscribers, state.contracts, state.invoices, state.operations, state.tickets, state.orders, state.events]) {
    demand(new Set(rows.map(row => row.id)).size === rows.length, "Identificadores duplicados no estado.");
  }
  demand(new Set(state.subscribers.map(s => s.document.toUpperCase())).size === state.subscribers.length, "Documento duplicado no workspace.");
  const competencies = new Set<string>();
  for (const c of state.contracts) {
    find(state.subscribers, c.subscriberId, "Assinante");
    find(state.plans, c.planId, "Plano");
    if (c.observedPlanId) find(state.plans, c.observedPlanId, "Plano observado");
    if (c.scheduledChange) find(state.plans, c.scheduledChange.planId, "Plano agendado");
  }
  for (const invoice of state.invoices) {
    const contract = find(state.contracts, invoice.contractId, "Contrato");
    demand(contract.subscriberId === invoice.subscriberId, "Fatura vinculada a um assinante diferente do contrato.");
    const key = `${contract.id}:${invoice.competence}`;
    demand(!competencies.has(key), "Mensalidade duplicada por contrato e competência.");
    demand(Boolean(invoice.paidAt) === Boolean(invoice.method), "Pagamento sem data ou método.");
    competencies.add(key);
  }
  for (const operation of state.operations) {
    find(state.contracts, operation.contractId, "Contrato");
    find(state.plans, operation.targetPlanId, "Plano alvo");
  }
  for (const row of [...state.tickets, ...state.orders]) find(state.subscribers, row.subscriberId, "Assinante");
}
function nextDue(clock: string, day: number) {
  const now = new Date(clock);
  let year = now.getUTCFullYear(), month = now.getUTCMonth();
  if (day < now.getUTCDate()) month += 1;
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}
function assertSlot(state: WorkspaceState, candidate: Pick<WorkspaceState["orders"][number], "technician" | "startAt" | "duration">, exceptId?: string) {
  demand(candidate.startAt >= state.clock, "O agendamento não pode ficar no passado do cenário.");
  const start = Date.parse(candidate.startAt), end = start + candidate.duration * 60_000;
  const conflict = state.orders.some(order => order.id !== exceptId && !["Cancelada", "Concluída"].includes(order.status) && order.technician.toLocaleLowerCase("pt-BR") === candidate.technician.toLocaleLowerCase("pt-BR") && start < Date.parse(order.startAt) + order.duration * 60_000 && end > Date.parse(order.startAt));
  demand(!conflict, "O técnico já possui uma ordem nesse intervalo.");
}
export function executeCommand(previous: WorkspaceState, rawCommand: unknown, context: ExecutionContext): WorkspaceState {
  const command = commandSchema.parse(rawCommand);
  demand(context.actorId?.trim(), "A execução exige um autor fornecido pelo servidor.");
  const state = workspaceStateSchema.parse(structuredClone(previous));
  assertReferences(state);
  const id = context.createId ?? (() => crypto.randomUUID());
  const log = (entityId: string, detail: string) => state.events.unshift({ id: id(), actorId: context.actorId, at: state.clock, action: command.type, entityId, detail });
  const enqueue = (contract: WorkspaceState["contracts"][number], kind: WorkspaceState["operations"][number]["kind"], reason: string) => {
    for (const pending of state.operations.filter(op => op.contractId === contract.id && !terminal(op))) pending.status = "Obsoleta";
    state.operations.push({ id: id(), contractId: contract.id, kind, status: "Pendente", targetAccess: contract.desired, targetPlanId: contract.planId, reason, evidence: "", createdAt: state.clock });
  };
  switch (command.type) {
    case "plan.create":
    case "plan.revise": {
      const previousPlan = command.type === "plan.revise" ? find(state.plans, command.id, "Plano") : null;
      const catalogId = previousPlan?.catalogId ?? id();
      const family = state.plans.filter(plan => plan.catalogId === catalogId);
      if (previousPlan) {
        demand(family.every(plan => plan.version <= previousPlan.version), "Use a versão mais recente para revisar o plano.");
        family.forEach(plan => { plan.active = false; });
      }
      const plan = { ...command.input, id: id(), catalogId, version: previousPlan ? previousPlan.version + 1 : 1, active: true };
      state.plans.push(plan);
      log(plan.id, `Plano ${plan.name} v${plan.version}. Contratos e faturas emitidas preservados.`);
      break;
    }
    case "plan.availability": {
      const plan = find(state.plans, command.id, "Plano");
      demand(!command.active || !state.plans.some(p => p.catalogId === plan.catalogId && p.version > plan.version), "Uma versão histórica não pode voltar à oferta.");
      plan.active = command.active;
      log(plan.id, command.active ? "Plano disponível para contratação." : "Plano retirado da oferta sem alterar contratos existentes.");
      break;
    }
    case "subscriber.create": {
      const input = command.input;
      demand(!state.subscribers.some(s => s.document.toUpperCase() === input.document), "Já existe um assinante com esse identificador.");
      const plan = find(state.plans, input.planId, "Plano");
      demand(plan.active, "O plano não está disponível para contratação.");
      const { planId, dueDay, ...fields } = input;
      const subscriberId = id(), contractId = id();
      state.subscribers.push({ ...fields, id: subscriberId, createdAt: state.clock, notes: [] });
      const contract: WorkspaceState["contracts"][number] = { id: contractId, subscriberId, planId, dueDay, label: "Instalação principal", address: input.address, neighborhood: input.neighborhood, pop: input.pop, price: plan.price, status: "Em instalação", desired: "Liberado", observed: "Sem leitura", observedPlanId: null, scheduledChange: null, createdAt: state.clock };
      state.contracts.push(contract);
      const due = nextDue(state.clock, dueDay);
      state.invoices.push({ id: id(), subscriberId, contractId, amount: plan.price, due, competence: due.slice(0, 7), paidAt: null, method: null });
      enqueue(contract, "Provisionamento", "Novo contrato demonstrativo");
      log(subscriberId, "Assinante, contrato, primeira mensalidade e solicitação de provisionamento criados em uma única alteração de estado.");
      break;
    }
    case "subscriber.edit": {
      const subscriber = find(state.subscribers, command.id, "Assinante");
      Object.assign(subscriber, command.input);
      log(subscriber.id, "Dados cadastrais atualizados; vínculos financeiros e contratuais preservados.");
      break;
    }
    case "subscriber.note": {
      const subscriber = find(state.subscribers, command.id, "Assinante");
      subscriber.notes.unshift({ id: id(), text: command.text, at: state.clock, actorId: context.actorId, visibility: "Interna" });
      log(subscriber.id, "Anotação interna registrada.");
      break;
    }
    case "contract.create": {
      const input = command.input;
      const subscriber = find(state.subscribers, input.subscriberId, "Assinante");
      const plan = find(state.plans, input.planId, "Plano");
      demand(plan.active, "O plano não está disponível para contratação.");
      const contract: WorkspaceState["contracts"][number] = {
        ...input, id: id(), price: plan.price, status: "Em instalação", desired: "Liberado",
        observed: "Sem leitura", observedPlanId: null, scheduledChange: null, createdAt: state.clock,
      };
      state.contracts.push(contract);
      const due = nextDue(state.clock, input.dueDay);
      state.invoices.push({ id: id(), subscriberId: subscriber.id, contractId: contract.id, amount: plan.price, due, competence: due.slice(0, 7), paidAt: null, method: null });
      enqueue(contract, "Provisionamento", `Contratação adicional: ${input.label}`);
      log(contract.id, `Novo contrato de ${plan.serviceType} para o assinante existente. Demais contratos preservados.`);
      break;
    }
    case "contract.schedule": {
      const contract = find(state.contracts, command.id, "Contrato");
      demand(contract.status === "Ativo", "Somente contratos ativos podem receber mudanças agendadas.");
      demand(!contract.scheduledChange, "Cancele o agendamento existente antes de criar outro.");
      demand(command.input.date > state.clock.slice(0, 10), "A vigência deve ser futura no cenário.");
      const plan = find(state.plans, command.input.planId, "Plano");
      demand(plan.active || plan.id === contract.planId, "Plano indisponível para a mudança.");
      demand(plan.id !== contract.planId || command.input.dueDay !== contract.dueDay, "Altere o plano ou o vencimento.");
      contract.scheduledChange = command.input;
      log(contract.id, `Mudança agendada para ${command.input.date}: ${command.input.reason}`);
      break;
    }
    case "contract.cancel-change": {
      const contract = find(state.contracts, command.id, "Contrato");
      demand(contract.scheduledChange, "Não há mudança agendada para cancelar.");
      contract.scheduledChange = null;
      log(contract.id, "Mudança contratual cancelada antes da aplicação.");
      break;
    }
    case "contract.access": {
      const contract = find(state.contracts, command.id, "Contrato");
      demand(contract.status !== "Encerrado", "Um contrato encerrado não aceita solicitações de acesso.");
      demand(contract.desired !== command.desired, "O acesso desejado já possui esse estado.");
      if (command.desired === "Liberado") demand(!state.invoices.some(i => i.contractId === contract.id && !i.paidAt && i.due < state.clock.slice(0, 10)), "Há mensalidades vencidas; regularize-as antes de solicitar reativação.");
      contract.desired = command.desired;
      enqueue(contract, command.desired === "Liberado" ? "Reativação" : "Suspensão", command.reason);
      log(contract.id, "Solicitação demonstrativa criada. A conexão observada não foi alterada.");
      break;
    }
    case "invoice.pay": {
      const invoice = find(state.invoices, command.id, "Fatura");
      demand(!invoice.paidAt, "A fatura já foi paga; nenhuma segunda baixa foi registrada.");
      invoice.paidAt = state.clock;
      invoice.method = command.method;
      const contract = find(state.contracts, invoice.contractId, "Contrato");
      const overdue = state.invoices.some(i => i.contractId === contract.id && !i.paidAt && i.due < state.clock.slice(0, 10));
      if (!overdue && contract.desired === "Suspenso" && contract.status !== "Encerrado") {
        contract.desired = "Liberado";
        enqueue(contract, "Reativação", "Regularização financeira demonstrativa");
      }
      log(invoice.id, `Baixa demonstrativa de ${invoice.amount} centavos, sem cobrança bancária e sem alteração da conexão observada.`);
      break;
    }
    case "operation.verify": {
      const operation = find(state.operations, command.id, "Operação");
      demand(operation.status === "Pendente" || operation.status === "Incerta", "A operação não está disponível para iniciar verificação.");
      operation.status = "Verificando";
      log(operation.id, "Verificação demonstrativa iniciada; nenhum equipamento contatado.");
      break;
    }
    case "operation.confirm":
    case "operation.uncertain": {
      const operation = find(state.operations, command.id, "Operação");
      demand(operation.status === "Verificando", "Inicie a verificação antes de registrar o resultado.");
      const contract = find(state.contracts, operation.contractId, "Contrato");
      demand(operation.targetAccess === contract.desired && operation.targetPlanId === contract.planId, "A solicitação ficou obsoleta; não aplique um alvo antigo.");
      operation.evidence = command.evidence;
      operation.status = command.type === "operation.confirm" ? "Concluída" : "Incerta";
      if (command.type === "operation.confirm") {
        contract.observed = operation.targetAccess === "Liberado" ? "Conectado" : "Desconectado";
        contract.observedPlanId = operation.targetPlanId;
        if (operation.kind === "Provisionamento" && contract.status === "Em instalação") contract.status = "Ativo";
      }
      log(operation.id, `${command.type === "operation.confirm" ? "Evidência simulada confirmada" : "Resultado incerto registrado"}: ${command.evidence}`);
      break;
    }
    case "ticket.create": {
      find(state.subscribers, command.input.subscriberId, "Assinante");
      const ticket = { ...command.input, id: id(), agent: "", status: "Aberto" as const, createdAt: state.clock, notes: [] };
      state.tickets.push(ticket);
      log(ticket.id, "Atendimento aberto e vinculado ao assinante.");
      break;
    }
    case "ticket.transition": {
      const ticket = find(state.tickets, command.id, "Atendimento");
      const allowed = { Aberto: ["Em atendimento"], "Em atendimento": ["Aguardando", "Resolvido"], Aguardando: ["Em atendimento", "Resolvido"], Resolvido: ["Aberto"] };
      demand(allowed[ticket.status].includes(command.status), "Transição de atendimento não permitida.");
      ticket.status = command.status;
      ticket.agent = command.agent;
      ticket.notes.unshift({ id: id(), text: command.reason, at: state.clock, actorId: context.actorId, visibility: "Interna" });
      log(ticket.id, `${command.status}: ${command.reason}`);
      break;
    }
    case "ticket.note": {
      const ticket = find(state.tickets, command.id, "Atendimento");
      demand(ticket.status !== "Resolvido", "Reabra o atendimento antes de adicionar novas mensagens.");
      ticket.notes.unshift({ id: id(), text: command.text, visibility: command.visibility, actorId: context.actorId, at: state.clock });
      log(ticket.id, command.visibility === "Interna" ? "Nota interna adicionada; não é mensagem ao assinante." : "Resposta demonstrativa registrada; nenhum canal externo acionado.");
      break;
    }
    case "order.create": {
      find(state.subscribers, command.input.subscriberId, "Assinante");
      assertSlot(state, command.input);
      const order = { ...command.input, id: id(), status: "Agendada" as const, result: "", createdAt: state.clock };
      state.orders.push(order);
      log(order.id, `Ordem de serviço agendada para ${order.startAt}.`);
      break;
    }
    case "order.reschedule": {
      const order = find(state.orders, command.id, "Ordem de serviço");
      demand(order.status === "Agendada", "Somente ordens agendadas podem ser reagendadas.");
      assertSlot(state, command, order.id);
      order.startAt = command.startAt;
      order.technician = command.technician;
      order.duration = command.duration;
      log(order.id, `Ordem reagendada: ${command.reason}`);
      break;
    }
    case "order.transition": {
      const order = find(state.orders, command.id, "Ordem de serviço");
      const allowed: Record<typeof order.status, string[]> = { Agendada: ["Em execução", "Cancelada"], "Em execução": ["Concluída", "Cancelada"], Concluída: [], Cancelada: [] };
      demand(allowed[order.status].includes(command.status), "Transição de ordem de serviço não permitida.");
      if (command.status === "Em execução") demand(order.startAt <= state.clock, "A ordem ainda não chegou ao horário agendado.");
      order.status = command.status;
      order.result = command.result;
      log(order.id, `${command.status}: ${command.result}. Estado de rede preservado.`);
      break;
    }
    case "clock.advance": {
      const next = new Date(state.clock);
      next.setUTCDate(next.getUTCDate() + 1);
      state.clock = next.toISOString();
      for (const contract of state.contracts) {
        const change = contract.scheduledChange;
        if (!change || change.date > state.clock.slice(0, 10)) continue;
        const plan = find(state.plans, change.planId, "Plano");
        if (contract.status !== "Ativo" || (!plan.active && plan.id !== contract.planId) || state.operations.some(op => op.contractId === contract.id && !terminal(op))) {
          log(contract.id, "Mudança ainda pendente: revise o contrato, a disponibilidade do plano e as operações em aberto.");
          continue;
        }
        const changedPlan = contract.planId !== plan.id;
        contract.planId = plan.id;
        contract.price = plan.price;
        contract.dueDay = change.dueDay;
        contract.scheduledChange = null;
        if (changedPlan) enqueue(contract, "Mudança de plano", change.reason);
        log(contract.id, "Mudança aplicada. Faturas emitidas e acesso observado preservados.");
      }
      log("workspace", "Relógio demonstrativo avançado em um dia; não representa uma tarefa agendada de produção.");
      break;
    }
  }
  assertReferences(state);
  return workspaceStateSchema.parse(state);
}
export function operationalMetrics(state: WorkspaceState) {
  const month = state.clock.slice(0, 7);
  const currentInvoices = state.invoices.filter(i => i.competence === month);
  return {
    subscribers: state.subscribers.length,
    recurring: state.contracts.filter(c => c.status !== "Encerrado").reduce((sum, c) => sum + c.price, 0),
    billed: currentInvoices.reduce((sum, i) => sum + i.amount, 0),
    received: state.invoices.filter(i => i.paidAt?.startsWith(month)).reduce((sum, i) => sum + i.amount, 0),
    overdue: state.invoices.filter(i => !i.paidAt && i.due < state.clock.slice(0, 10)).reduce((sum, i) => sum + i.amount, 0),
    connected: state.contracts.filter(c => c.observed === "Conectado").length,
    openTickets: state.tickets.filter(t => t.status !== "Resolvido").length,
    activeOrders: state.orders.filter(o => !["Concluída", "Cancelada"].includes(o.status)).length,
  };
}
