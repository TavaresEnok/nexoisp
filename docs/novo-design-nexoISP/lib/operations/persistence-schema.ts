import { z } from "zod";
import { commandSchema } from "./schema";

export const serverUserIdSchema = z.string().min(1).max(160).refine(
  value => value === value.trim() && value !== "public-demo",
  "A persistência privada exige um identificador de usuário do servidor, diferente do cenário público.",
);

export const commandEnvelopeSchema = z.object({
  requestId: z.uuid(),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  command: commandSchema,
}).strict();

export class WorkspaceConflictError extends Error {
  constructor() {
    super("O workspace foi alterado. Atualize os dados antes de tentar novamente.");
    this.name = "WorkspaceConflictError";
  }
}

export class RequestConflictError extends Error {
  constructor() {
    super("A chave de requisição já foi usada com outro comando ou outra revisão.");
    this.name = "RequestConflictError";
  }
}
