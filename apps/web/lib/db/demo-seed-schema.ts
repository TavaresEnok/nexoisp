import { z } from "zod";
import { parseWorkspaceRecords } from "../workspace-schema";

export const demoSeedSchema = z.object({
  format: z.literal(1), scope: z.literal("public-demo"), records: z.array(z.object({
    id: z.string().min(1), kind: z.enum(["snapshot", "subscriber", "invoice", "ticket", "order", "node", "activity"]),
    payload: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime(),
  })).min(1),
}).superRefine((seed, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  if (new Set(seed.records.map(row => row.id)).size !== seed.records.length) fail("IDs duplicados no seed.");
  if (seed.records.filter(row => row.kind === "snapshot").length !== 1) fail("O cenário precisa de exatamente um snapshot.");
  const subscriberIds = new Set(seed.records.filter(row => row.kind === "subscriber").map(row => row.id));
  for (const row of seed.records) {
    if (["invoice", "ticket", "order"].includes(row.kind) && !subscriberIds.has(String(row.payload.subscriberId))) fail(`Vínculo inválido no registro ${row.id}.`);
    if (row.kind === "activity" && row.payload.subscriberId && !subscriberIds.has(String(row.payload.subscriberId))) fail(`Atividade ${row.id} sem assinante correspondente.`);
  }
  try { parseWorkspaceRecords(seed.records); } catch { fail("Os payloads do cenário não correspondem ao contrato validado da aplicação."); }
});
