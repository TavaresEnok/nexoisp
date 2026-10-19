import type { WorkspaceData } from "../../lib/types";
import { getCommercialData, planUsage } from "../../lib/commercial";
import { normalize } from "../../domain/formatters";

export function selectContracts(data: WorkspaceData, filters: { planId: string | null; subscriberId: string | null; status: string; query: string }) {
  const { plans, contracts } = getCommercialData(data);
  return filterContractCatalog({ plans, contracts, subscribers: data.subscribers }, filters);
}
export function filterContractCatalog({ plans, contracts, subscribers }: { plans: import("../../domain/commercial").CatalogPlan[]; contracts: import("../../domain/commercial").ServiceContract[]; subscribers: Pick<WorkspaceData["subscribers"][number], "id" | "name">[] }, filters: { planId: string | null; subscriberId: string | null; status: string; query: string }) {
  const rows = contracts.filter(c => {
    const subscriber = subscribers.find(s => s.id === c.subscriberId);
    const plan = plans.find(p => p.id === c.planId);
    return (!filters.planId || c.planId === filters.planId) && (!filters.subscriberId || c.subscriberId === filters.subscriberId) && (filters.status === "Todos" || c.status === filters.status) && normalize(`${c.code} ${c.label} ${subscriber?.name ?? ""} ${c.address} ${plan?.name ?? ""}`).includes(normalize(filters.query));
  });
  const groups = subscribers.map(subscriber => ({ subscriber, contracts: rows.filter(c => c.subscriberId === subscriber.id) })).filter(group => group.contracts.length);
  return { rows, groups };
}
export function selectPlans(data: Parameters<typeof getCommercialData>[0], filters: { query: string; service: string; pop: string; sort: "name" | "active" | "speed" }) {
  const { plans, contracts } = getCommercialData(data);
  return plans.map(plan => ({ plan, usage: planUsage(plan.id, contracts) })).filter(({ plan, usage }) => normalize(`${plan.name} ${plan.id} ${plan.download ?? ""} ${plan.serviceType} ${usage.pops.join(" ")}`).includes(normalize(filters.query)) && (filters.service === "Todos" || plan.serviceType === filters.service) && (!filters.pop || usage.pops.includes(filters.pop)))
    .sort((a, b) => filters.sort === "active" ? b.usage.active - a.usage.active : filters.sort === "speed" ? (b.plan.download ?? -1) - (a.plan.download ?? -1) : a.plan.name.localeCompare(b.plan.name, "pt-BR"));
}
