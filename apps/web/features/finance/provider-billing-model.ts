import { z } from "zod";
import { cents } from "@/features/shared/schema";

export const productLabels = {
  pix_cob: "Pix imediato",
  pix_cobv: "Pix com vencimento",
  bolix: "Boleto / Bolix",
} as const;
export type BillingProduct = keyof typeof productLabels;
export const billingStateLabels: Record<string, string> = {
  prepared: "Preparada · aguardando processamento",
  uncertain: "Resultado desconhecido · consultar antes de decidir",
  review: "Revisão necessária",
  issued: "Cobrança emitida",
  confirmed: "Operação confirmada",
  rejected: "Operação recusada",
};
const issuanceSchema = z.object({
  id: z.string().uuid(),
  financial_connection_id: z.string().uuid(),
  intent_id: z.string().uuid(),
  predecessor_id: z.string().uuid().nullable().optional(),
  product: z.enum(["pix_cob", "pix_cobv", "bolix"]),
  state: z.enum(["prepared", "uncertain", "review", "issued"]),
  account_name: z.string(),
  account_status: z.string(),
  charge_id: z.string().nullable(),
  last_error: z.string().nullable(),
  receipt_review: z.boolean(),
  receipt_checked_at: z.string().nullable(),
  receipt_last_error: z.string().nullable(),
});
const operationSchema = z.object({
  id: z.string().uuid(),
  issuance_id: z.string().uuid(),
  intent_id: z.string().uuid(),
  kind: z.enum(["cancel", "refund"]),
  payment_id: z.string().uuid().nullable(),
  amount_cents: cents().nullable(),
  reason: z.string(),
  state: z.enum(["prepared", "uncertain", "review", "confirmed", "rejected"]),
  last_error: z.string().nullable(),
});
export const providerBillingSchema = z.object({
  sandbox_enabled: z.boolean(),
  dispatch_enabled: z.boolean(),
  operations_write_enabled: z.boolean(),
  accounts: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      provider: z.literal("efi"),
      environment: z.literal("sandbox"),
      products: z.array(z.enum(["pix_cob", "pix_cobv", "bolix"])),
    }),
  ),
  issuances: z.array(issuanceSchema),
  operations: z.array(operationSchema),
  resolutions: z
    .array(
      z.object({
        id: z.string().uuid(),
        issuance_id: z.string().uuid(),
        intent_id: z.string().uuid(),
        kind: z.enum(["resolve", "reissue"]),
        status: z.string(),
        reason: z.string(),
        snapshot_hash: z.string(),
        created_at: z.string(),
        successor_id: z.string().uuid().nullable(),
      }),
    )
    .default([]),
  refund_payments: z.array(
    z.object({
      id: z.string().uuid(),
      amount_cents: cents(),
      refundable_cents: cents(),
      issuance_id: z.string().uuid().optional(),
      paid_at: z.string(),
    }),
  ),
});
export type ProviderBillingData = z.infer<typeof providerBillingSchema>;
export type ProviderIssuance = z.infer<typeof issuanceSchema>;
export type ProviderOperation = z.infer<typeof operationSchema>;

const intentSchema = z.object({
  intent_id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  connection_id: z.string().uuid(),
  issuance_id: z.string().uuid().optional(),
  kind: z.enum(["issue", "cancel", "refund", "resolve", "reissue"]),
  body: z.record(z.string(), z.unknown()),
});
export type ProviderIntent = z.infer<typeof intentSchema>;
export function providerIntentKey(
  tenant: string,
  actor: string,
  invoice: string,
  operation: boolean,
) {
  return `nexo:provider-billing:v1:${tenant}:${actor}:${invoice}:${operation ? "operation" : "issue"}`;
}
export function readProviderIntent(
  storage: Storage,
  key: string,
  invoice: string,
): ProviderIntent | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const parsed = intentSchema.safeParse(JSON.parse(raw));
  if (
    !parsed.success ||
    parsed.data.invoice_id !== invoice ||
    (parsed.data.kind !== "issue" && !parsed.data.issuance_id)
  )
    throw new Error(
      "Intenção de cobrança inválida. Confira o journal com o administrador antes de continuar.",
    );
  return parsed.data;
}
export function providerIntentPath(intent: ProviderIntent) {
  const base = `/financial-connections/${intent.connection_id}/issuance`;
  if (intent.kind === "issue") return base;
  if (intent.kind === "resolve" || intent.kind === "reissue")
    return `${base}/${intent.issuance_id}/${intent.kind}`;
  return `${base}/${intent.issuance_id}/operations`;
}
/** Call inside navigator.locks; freeze the payload before the first request.
 * Acceptance is preparation, not bank settlement. Keep intent until the journal
 * proves a terminal result, including after a successful preparation response.
 */
export async function sendProviderIntent(
  storage: Storage,
  key: string,
  candidate: ProviderIntent,
  send: (path: string, body: Record<string, unknown>) => Promise<unknown>,
) {
  const intent =
    readProviderIntent(storage, key, candidate.invoice_id) ??
    intentSchema.parse(candidate);
  storage.setItem(key, JSON.stringify(intent));
  try {
    await send(providerIntentPath(intent), {
      ...intent.body,
      intent_id: intent.intent_id,
    });
  } catch (error) {
    // These responses guarantee the transaction was rejected. Conflicts and
    // ambiguous failures remain frozen for lookup/replay of the same intention.
    if ([400, 422].includes((error as { status?: number })?.status ?? 0))
      storage.removeItem(key);
    throw error;
  }
}
export function providerIntentTerminal(
  intent: ProviderIntent,
  data: ProviderBillingData,
) {
  if (intent.kind === "resolve")
    return data.resolutions.some(
      (row) =>
        row.intent_id === intent.intent_id &&
        row.issuance_id === intent.issuance_id &&
        row.kind === "resolve",
    );
  return intent.kind === "issue" || intent.kind === "reissue"
    ? data.issuances.some(
        (row) =>
          row.intent_id === intent.intent_id &&
          row.financial_connection_id === intent.connection_id &&
          row.state === "issued",
      )
    : data.operations.some(
        (row) =>
          row.intent_id === intent.intent_id &&
          row.issuance_id === intent.issuance_id &&
          ["confirmed", "rejected"].includes(row.state),
      );
}
