import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedIntents,
  fold,
  parseIntent,
  suggestions,
  suggestionsFor,
  validIp,
} from "../features/assistant/intents";
import type { Session } from "../features/session/model";

const now = new Date(2026, 10, 9, 15, 30);
const session = (
  role: Session["role"],
  perms: string[],
  modules: string[] = ["noc", "field"],
): Session => ({
  id: role,
  name: role,
  email: `${role}@example.invalid`,
  role,
  perms,
  modules,
  tenant: { id: "t", name: "Alfa", slug: "alfa" },
  support: false,
  demo: false,
  mfa_enabled: false,
  mfa_pending: false,
});

test("normalização preserva o comprimento para recortar o termo original", () => {
  for (const text of ["Ação São João", "ÁÉÍÓÚ ç", "🙂 olá"]) {
    assert.equal(fold(text).length, text.length);
  }
  assert.equal(fold("Ação São João"), "acao sao joao");
});

test("reconhece busca de cliente por nome, documento e login", () => {
  assert.deepEqual(parseIntent("cliente Maria Souza", now), {
    kind: "customer",
    subject: "Maria Souza",
  });
  assert.deepEqual(parseIntent("buscar o assinante João Ação", now), {
    kind: "customer",
    subject: "João Ação",
  });
  assert.deepEqual(parseIntent("Quem é o cliente \"Ana Lima\"?", now), {
    kind: "customer",
    subject: "Ana Lima",
  });
  assert.deepEqual(parseIntent("procurar login joao.pppoe", now), {
    kind: "customer",
    subject: "joao.pppoe",
  });
  assert.deepEqual(parseIntent("123.456.789-09", now), {
    kind: "customer",
    subject: "123.456.789-09",
  });
  assert.deepEqual(parseIntent("cliente", now), { kind: "unknown" });
});

test("reconhece diagnóstico de cliente sem internet", () => {
  assert.deepEqual(
    parseIntent("Por que o cliente Maria Souza está sem internet?", now),
    { kind: "diagnosis", subject: "Maria Souza" },
  );
  assert.deepEqual(parseIntent("por que a Joana Dark está sem conexão", now), {
    kind: "diagnosis",
    subject: "Joana Dark",
  });
  assert.deepEqual(parseIntent("cliente José Ávila sem internet", now), {
    kind: "diagnosis",
    subject: "José Ávila",
  });
  assert.deepEqual(parseIntent("diagnóstico do cliente Pedro", now), {
    kind: "diagnosis",
    subject: "Pedro",
  });
  assert.deepEqual(parseIntent("internet do João caiu", now), {
    kind: "diagnosis",
    subject: "João",
  });
  assert.deepEqual(parseIntent("cliente sem internet", now), {
    kind: "diagnosis",
    subject: null,
  });
});

test("reconhece faturas vencidas com e sem cliente", () => {
  assert.deepEqual(parseIntent("faturas vencidas de Maria Souza", now), {
    kind: "overdue",
    subject: "Maria Souza",
  });
  assert.deepEqual(parseIntent("Faturas em atraso do cliente João", now), {
    kind: "overdue",
    subject: "João",
  });
  assert.deepEqual(parseIntent("A Ana Lima tem faturas vencidas?", now), {
    kind: "overdue",
    subject: "Ana Lima",
  });
  assert.deepEqual(parseIntent("quanto o Pedro deve", now), {
    kind: "overdue",
    subject: "Pedro",
  });
  assert.deepEqual(parseIntent("faturas vencidas", now), {
    kind: "overdue",
    subject: null,
  });
});

test("reconhece ordens de serviço abertas de hoje", () => {
  assert.deepEqual(parseIntent("OS abertas de hoje", now), {
    kind: "orders",
    today: true,
    subject: null,
  });
  assert.deepEqual(parseIntent("ordens de serviço pendentes", now), {
    kind: "orders",
    today: false,
    subject: null,
  });
  assert.deepEqual(parseIntent("O.S. do cliente Maria", now), {
    kind: "orders",
    today: false,
    subject: "Maria",
  });
  // "os" como artigo não vira ordem de serviço.
  assert.equal(parseIntent("os clientes sem internet", now).kind, "diagnosis");
});

test("reconhece consulta de IP com data, hora e porta", () => {
  assert.deepEqual(parseIntent("IP 1.2.3.4 às 10h", now), {
    kind: "ip",
    ip: "1.2.3.4",
    port: null,
    date: null,
    time: "10:00",
  });
  assert.deepEqual(
    parseIntent("quem estava com o IP 203.0.113.10 ontem às 22:15 porta 40001", now),
    { kind: "ip", ip: "203.0.113.10", port: 40001, date: "2026-11-08", time: "22:15" },
  );
  assert.deepEqual(parseIntent("ip 2001:db8::1 em 05/11 14h30", now), {
    kind: "ip",
    ip: "2001:db8::1",
    port: null,
    date: "2026-11-05",
    time: "14:30",
  });
  assert.deepEqual(parseIntent("100.64.0.9", now), {
    kind: "ip",
    ip: "100.64.0.9",
    port: null,
    date: null,
    time: null,
  });
  assert.equal(parseIntent("IP 300.1.1.1 às 10h", now).kind, "unknown");
  assert.equal(validIp("10.0.0.256"), false);
  assert.equal(validIp("2001:db8::1"), true);
  assert.equal(validIp("abc"), false);
});

test("pergunta não reconhecida devolve intenção desconhecida", () => {
  for (const text of ["", "   ", "bom dia", "qual a previsão do tempo?", "me ajuda"])
    assert.deepEqual(parseIntent(text, now), { kind: "unknown" });
});

test("intenções e sugestões respeitam permissões e módulos da sessão", () => {
  const admin = session("admin", [
    "subscribers:read",
    "network:read",
    "finance:read",
    "os:read",
    "legal:query",
  ]);
  assert.deepEqual(
    [...allowedIntents(admin)].sort(),
    ["customer", "diagnosis", "ip", "orders", "overdue"],
  );
  assert.equal(suggestionsFor(admin).length, suggestions.length);
  const finance = session("finance", ["subscribers:read", "finance:read"], []);
  assert.deepEqual([...allowedIntents(finance)].sort(), ["customer", "ip", "overdue"]);
  const noModules = session("noc", ["subscribers:read", "network:read", "os:read"], []);
  assert.equal(allowedIntents(noModules).has("diagnosis"), false);
  assert.equal(allowedIntents(noModules).has("orders"), false);
  assert.equal(allowedIntents(session("subscriber", ["portal:self"])).size, 0);
  assert.equal(allowedIntents(null).size, 0);
  assert.ok(
    suggestionsFor(finance).every((item) =>
      ["customer", "ip", "overdue"].includes(item.kind),
    ),
  );
  for (const item of suggestions)
    assert.equal(parseIntent(item.question, now).kind, item.kind, item.question);
});
