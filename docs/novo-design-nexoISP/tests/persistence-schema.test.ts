import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commandEnvelopeSchema, serverUserIdSchema, WorkspaceConflictError, RequestConflictError } from "../lib/operations/persistence-schema";

const envelope = () => ({ requestId: randomUUID(), expectedRevision: 0, command: { type: "plan.create", input: { name: "Fibra 400 Mega", speed: 400, price: 11990 } } });

test("persistência privada recusa cenário público, espaços e identificadores vazios", () => {
  for (const userId of ["", " ", "public-demo", " operator", "operator ", "x".repeat(161)]) assert.equal(serverUserIdSchema.safeParse(userId).success, false);
  assert.equal(serverUserIdSchema.parse("server-user-001"), "server-user-001");
});
test("chave de requisição deve ser UUID e revisão inteira não negativa", () => {
  for (const requestId of ["", "request-1", 123]) assert.equal(commandEnvelopeSchema.safeParse({ ...envelope(), requestId }).success, false);
  for (const expectedRevision of [-1, 0.5, "0", 2_147_483_647]) assert.equal(commandEnvelopeSchema.safeParse({ ...envelope(), expectedRevision }).success, false);
  assert.equal(commandEnvelopeSchema.parse(envelope()).expectedRevision, 0);
});
test("cliente não pode enviar autoria, estado completo ou identidade no envelope", () => {
  for (const field of ["actorId", "userId", "state", "role"]) assert.equal(commandEnvelopeSchema.safeParse({ ...envelope(), [field]: "forged" }).success, false);
  assert.equal(commandEnvelopeSchema.safeParse({ ...envelope(), command: { type: "clock.advance", actorId: "forged" } }).success, false);
});
test("envelope preserva validação estrita de preços do núcleo", () => {
  const raw = envelope();
  assert.equal(commandEnvelopeSchema.safeParse({ ...raw, command: { ...raw.command, input: { ...raw.command.input, price: 119.9 } } }).success, false);
  assert.equal(commandEnvelopeSchema.safeParse({ ...raw, command: { type: "invoice.pay", id: "invoice-1", method: "Pix demonstrativo", amount: 1 } }).success, false);
});
test("normalização estabiliza comandos para tentativas repetidas", () => {
  const raw = envelope();
  const reordered = { command: { input: { price: 11990, speed: 400, name: "  Fibra 400 Mega  " }, type: "plan.create" }, expectedRevision: 0, requestId: raw.requestId };
  assert.equal(JSON.stringify(commandEnvelopeSchema.parse(raw)), JSON.stringify(commandEnvelopeSchema.parse(reordered)));
});
test("conflitos distinguem revisão antiga de reutilização indevida de chave", () => {
  assert.equal(new WorkspaceConflictError().name, "WorkspaceConflictError");
  assert.equal(new RequestConflictError().name, "RequestConflictError");
  assert.notEqual(new WorkspaceConflictError().message, new RequestConflictError().message);
});
