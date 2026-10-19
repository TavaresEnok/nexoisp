import { z } from "zod";
import type { CatalogPlan } from "@/domain/commercial";
export const planSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  active: z.boolean(),
  version: z.coerce.number(),
  price_cents: z.coerce.number().int(),
  down_kbps: z.coerce.number(),
  up_kbps: z.coerce.number(),
  profile_name: z.string(),
  active_contracts: z.coerce.number(),
  loyalty_months: z.number().nullable(),
  penalty_model: z.string().nullable(),
  penalty_cents: z.number().nullable(),
  rate_limit: z.string().nullable(),
  address_pool: z.string().nullable(),
  warn_after_days: z.number().nullable(),
  reduce_after_days: z.number().nullable(),
  block_after_days: z.number().nullable(),
  reduced_profile: z.string().nullable(),
  access_technology: z.string().nullable(),
});
export type ErpPlan = z.infer<typeof planSchema>;
export function projectPlan(plan: ErpPlan): CatalogPlan {
  return {
    id: plan.id,
    name: plan.name,
    serviceType: "Internet",
    active: plan.active,
    download: plan.down_kbps / 1000,
    upload: plan.up_kbps / 1000,
    price: plan.price_cents / 100,
    technology: plan.access_technology,
    billing: "Mensal",
    installationFee: null,
    loyaltyMonths: plan.loyalty_months,
    discount: null,
    sla: null,
    ipv4Pool: plan.address_pool,
    ipv6Pool: null,
    policyIn: null,
    policyOut: null,
    radius:
      [
        plan.profile_name && `Perfil: ${plan.profile_name}`,
        plan.rate_limit && `Rate limit: ${plan.rate_limit}`,
      ]
        .filter(Boolean)
        .join("\n") || null,
    onu: null,
    source: "catalog",
  };
}
export function decimalToCents(value: string) {
  const input = value.trim();
  const valid = input.includes(",")
    ? /^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(input)
    : /^\d+(?:\.\d{1,2})?$/.test(input);
  if (!valid)
    throw new Error(
      "Informe um valor monetário válido, com até duas casas decimais.",
    );
  const normalized = input.includes(",")
    ? input.replace(/\./g, "").replace(",", ".")
    : input;
  const [whole, decimals = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents))
    throw new Error("Valor monetário acima do limite permitido.");
  return cents;
}

export const contractRecordSchema = z.object({
  id: z.string().uuid(),
  subscriber_id: z.string().uuid(),
  subscriber_name: z.string(),
  subscriber_document: z.string().nullable(),
  plan_id: z.string().uuid(),
  plan_name: z.string(),
  plan_version: z.coerce.number(),
  price_cents: z.coerce.number(),
  down_kbps: z.coerce.number(),
  up_kbps: z.coerce.number(),
  due_day: z.coerce.number(),
  status: z.enum(["active", "ended"]),
  start_date: z.string(),
  end_date: z.string().nullable(),
  notes: z.string().nullable(),
  pop_id: z.string().nullable(),
  company_id: z.string().nullable(),
  install_street: z.string().nullable(),
  install_number: z.string().nullable(),
  install_district: z.string().nullable(),
  install_city: z.string().nullable(),
  install_state: z.string().nullable(),
  install_zip: z.string().nullable(),
  service_area: z.string(),
  loyalty_until: z.string().nullable(),
  penalty_model: z.string().nullable(),
  penalty_cents: z.number().nullable(),
  credit_restricted_at: z.string().nullable(),
  referred_by_subscriber_id: z.string().nullable(),
  custom: z.record(z.string(), z.unknown()).nullable(),
  tags: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type ErpContract = z.infer<typeof contractRecordSchema>;

export const contractDetailSchema = contractRecordSchema.extend({
  history: z.array(
    z.object({
      at: z.string(),
      event: z.string(),
      actor_name: z.string().nullable(),
      detail: z.record(z.string(), z.unknown()),
    }),
  ),
});
export type ContractDetail = z.infer<typeof contractDetailSchema>;
export type ContractAddon = {
  id: string;
  description: string;
  unit_price_cents: number;
  quantity: number;
  from_competence: string;
  ended_competence: string | null;
  current: boolean;
};
export function projectContract(
  contract: ErpContract,
  addons?: ContractAddon[],
): import("@/domain/commercial").ServiceContract {
  return {
    id: contract.id,
    code: contract.id.slice(0, 8),
    subscriberId: contract.subscriber_id,
    planId: contract.plan_id,
    label: "Contrato",
    address:
      [
        contract.install_street,
        contract.install_number,
        contract.install_city,
        contract.install_state,
      ]
        .filter(Boolean)
        .join(", ") || "Endereço específico não informado",
    neighborhood: contract.install_district ?? "Não informado",
    pop: contract.pop_id ? "Consulte o vínculo de POP" : "Sem POP vinculado",
    price: contract.price_cents / 100,
    dueDay: contract.due_day,
    status: contract.status === "active" ? "Vigente" : "Encerrado",
    since: contract.start_date,
    additionalServices: (addons ?? [])
      .filter((addon) => addon.current)
      .map((addon) => ({
        id: addon.id,
        name: `${addon.description}${addon.quantity > 1 ? ` (×${addon.quantity})` : ""}`,
        serviceType: "Serviço",
        price: (addon.unit_price_cents * addon.quantity) / 100,
      })),
  };
}
