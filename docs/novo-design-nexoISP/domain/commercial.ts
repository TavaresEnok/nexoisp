import type { Subscriber, WorkspaceData } from "./workspace";

export type ServiceType = "Internet" | "IPTV" | "Telefonia" | "Serviço";
export type CatalogPlan = {
  id: string; name: string; serviceType: ServiceType; download: number | null; upload: number | null;
  price: number | null; active: boolean | null; technology: string | null; billing: string | null;
  installationFee: number | null; loyaltyMonths: number | null; discount: number | null;
  sla: string | null; ipv4Pool: string | null; ipv6Pool: string | null;
  policyIn: string | null; policyOut: string | null; radius: string | null; onu: string | null;
  source: "catalog" | "legacy";
};
export type ServiceContract = {
  id: string; code: string; subscriberId: string; planId: string; label: string;
  address: string; neighborhood: string; pop: string; price: number; dueDay: number;
  status: string; since: string;
  additionalServices: { id: string; name: string; serviceType: ServiceType; price: number }[];
};
export function contractMonthlyTotal(contract: ServiceContract) {
  return contract.price + contract.additionalServices.reduce((total, item) => total + item.price, 0);
}
export function legacyPlanId(subscriber: Pick<Subscriber, "plan" | "speed">) {
  return `legacy:${encodeURIComponent(subscriber.plan)}:${subscriber.speed}`;
}
// Compatibility projection only: legacy records are not an independently registered catalog.
export function getCommercialData(data: Pick<WorkspaceData, "subscribers" | "commercialPlans" | "contracts">) {
  const plans = data.commercialPlans ?? Array.from(new Map(data.subscribers.map(s => [legacyPlanId(s), {
    id: legacyPlanId(s), name: s.plan, serviceType: "Internet", download: s.speed, upload: null,
    price: null, active: null, technology: null, billing: null, installationFee: null,
    loyaltyMonths: null, discount: null, sla: null, ipv4Pool: null, ipv6Pool: null,
    policyIn: null, policyOut: null, radius: null, onu: null, source: "legacy",
  } satisfies CatalogPlan])).values());
  const contracts = data.contracts ?? data.subscribers.map(s => ({
    id: `legacy-contract:${s.id}`, code: s.contract, subscriberId: s.id, planId: legacyPlanId(s),
    label: "Instalação principal", address: s.address, neighborhood: s.neighborhood, pop: s.pop,
    price: s.price, dueDay: s.dueDay, status: s.status, since: s.since, additionalServices: [],
  } satisfies ServiceContract));
  return { plans, contracts };
}
export function planUsage(planId: string, contracts: ServiceContract[]) {
  const rows = contracts.filter(c => c.planId === planId);
  return {
    contracts: rows, active: rows.filter(c => c.status === "Ativo").length,
    suspended: rows.filter(c => c.status === "Suspenso").length,
    installing: rows.filter(c => c.status === "Em instalação").length,
    canceled: rows.filter(c => ["Cancelado", "Encerrado"].includes(c.status)).length,
    recurring: rows.filter(c => c.status === "Ativo").reduce((sum, c) => sum + contractMonthlyTotal(c), 0),
    subscribers: new Set(rows.map(c => c.subscriberId)).size,
    pops: [...new Set(rows.map(c => c.pop).filter(Boolean))],
  };
}
