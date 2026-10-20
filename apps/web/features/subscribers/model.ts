import { z } from "zod";
import { cents } from "@/features/shared/schema";
const optionalText = z.string().nullable().optional();
export const subscriberFields = {
  name: "",
  document: "",
  email: "",
  phone: "",
  address_street: "",
  address_number: "",
  address_district: "",
  address_city: "",
  address_state: "",
  address_zip: "",
  notes: "",
  status: "active",
  birth_date: "",
  rg: "",
  rg_issuer: "",
  mother_name: "",
  trade_name: "",
};
export const subscriberRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  document: optionalText,
  email: optionalText,
  phone: optionalText,
  address_street: optionalText,
  address_number: optionalText,
  address_district: optionalText,
  address_city: optionalText,
  address_state: optionalText,
  address_zip: optionalText,
  notes: optionalText,
  birth_date: optionalText,
  rg: optionalText,
  rg_issuer: optionalText,
  mother_name: optionalText,
  trade_name: optionalText,
  status: z.enum(["active", "inactive"]),
  created_at: z.string(),
  active_contracts: z.coerce.number().optional(),
  active_plan_names: optionalText,
  active_base_cents: z.preprocess(
    (value) => (value === null || value === undefined ? null : Number(value)),
    z.number().nullable(),
  ),
  anonymized_at: optionalText,
  anonymized_reason: optionalText,
  custom: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const subscriberContractSchema = z.object({
  id: z.string().uuid(),
  subscriber_id: z.string().uuid(),
  plan_id: z.string().uuid(),
  plan_name: z.string(),
  plan_version: z.coerce.number(),
  price_cents: cents(),
  down_kbps: z.coerce.number(),
  up_kbps: z.coerce.number(),
  due_day: z.coerce.number(),
  start_date: z.string(),
  status: z.string(),
  install_street: optionalText,
  install_number: optionalText,
  install_district: optionalText,
  install_city: optionalText,
});
export const subscriberDetailSchema = subscriberRecordSchema.extend({
  contracts: z.array(subscriberContractSchema),
});
export type SubscriberRecord = z.infer<typeof subscriberRecordSchema>;
export type SubscriberDetail = z.infer<typeof subscriberDetailSchema>;
export type SubscriberInput = typeof subscriberFields;
export function subscriberInput(initial?: SubscriberRecord): SubscriberInput {
  return Object.fromEntries(
    Object.entries(subscriberFields).map(([key, fallback]) => [
      key,
      initial?.[key as keyof SubscriberRecord] ?? fallback,
    ]),
  ) as SubscriberInput;
}
export function subscriberCommand(input: SubscriberInput) {
  return Object.fromEntries(
    Object.keys(subscriberFields).map((key) => [
      key,
      input[key as keyof SubscriberInput],
    ]),
  );
}
