import { z } from "zod";
export const channel = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  phone_field: z.string(),
  message_field: z.string(),
  active: z.boolean(),
  has_headers: z.boolean(),
});
export const templates = z.object({
  variables: z.array(z.string()),
  rows: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      body: z.string(),
      preview: z.string(),
    }),
  ),
});
export const rule = z.object({
  id: z.string(),
  name: z.string(),
  days_relative: z.coerce.number(),
  hour_from: z.coerce.number(),
  hour_to: z.coerce.number(),
  active: z.boolean(),
  template_name: z.string(),
  channel_name: z.string(),
  sent: z.coerce.number(),
  plan_id: z.string().nullable(),
  pop_id: z.string().nullable(),
  tag_id: z.string().nullable(),
  weekdays: z.array(z.coerce.number()),
  min_interval_days: z.coerce.number(),
});
export const noticeLog = z.object({
  id: z.union([z.string(), z.number()]),
  created_at: z.string(),
  subscriber_name: z.string().nullable(),
  contact_value: z.string().nullable(),
  rule_name: z.string().nullable(),
  status: z.string(),
  attempts: z.coerce.number(),
  error: z.string().nullable(),
});
export const messageStates: Record<string, string> = {
  sent: "Enviado ao serviço",
  failed: "Falhou",
  skipped_no_consent: "Sem consentimento",
  skipped_settled: "Não encaminhado",
  queued: "Na fila",
  sending: "Enviando",
  uncertain: "Resultado desconhecido",
  test: "Teste",
};
