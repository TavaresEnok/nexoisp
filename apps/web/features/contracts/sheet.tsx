import useSWR, { useSWRConfig } from "swr";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { ContractDetails } from "@/components/contract-details";
import { QueryBoundary } from "@/features/shared/feedback";
import { SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { ProfileSection, ProfileFacts } from "@/components/subscriber-profile-sections";
import { api } from "@/platform/erp-client";
import { contractDetailSchema, planSchema, projectPlan, projectContract, type ContractAddon } from "./models";
import { LazyContractFinance as ContractFinance } from "@/features/finance/lazy";
import { ContractActions } from "./actions";
import { ContractConditions } from "./conditions";
import { ContractCommercial } from "./commercial";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { ContractStates, ContractEquipment } from "./status";
import { ContractAddons } from "./addons";
import { date, money } from "@/lib/format";
export function OperationalContractSheet({ id, onClose }: { id: string; onClose: () => void }) {
 const { me } = useSession(); const navigate = useNavigate(); const { mutate } = useSWRConfig();
 const detail = useSWR(["erp-contract", id], async ([, id]) => { const [contract, addons] = await Promise.all([api(`/contracts/${encodeURIComponent(id)}`), api<ContractAddon[]>(`/contracts/${encodeURIComponent(id)}/addons`)]); return { contract: contractDetailSchema.parse(contract), addons }; });
 const plans = useSWR("erp-plans", async () => z.array(planSchema).parse(await api("/plans")));
 const contract = detail.data?.contract;
 const refresh = async () => { await Promise.all([mutate(key => Array.isArray(key) && typeof key[0] === "string" && ["erp-contract", "erp-contracts", "erp-subscriber", "erp-contract-states"].includes(key[0])), mutate("erp-plans")]); };
 return <ContractDetails isOpen contract={contract ? projectContract(contract, detail.data?.addons) : null} plans={(plans.data ?? []).map(projectPlan)} subscriber={contract ? { id: contract.subscriber_id, name: contract.subscriber_name } : undefined} operational onClose={onClose} openSubscriber={id => navigate(`/assinantes?ficha=${id}`)} feedback={<><SheetHeader><SheetTitle>Contrato</SheetTitle><SheetDescription>Consultando o vínculo comercial no ERP.</SheetDescription></SheetHeader><div className="commercial-detail-body"><QueryBoundary loading={detail.isLoading || plans.isLoading} error={detail.error || plans.error} retry={() => Promise.all([detail.mutate(), plans.mutate()])}>{null}</QueryBoundary></div></>} actions={contract && <ContractActions contract={contract} refresh={refresh} />} conditions={contract && <ContractConditions contract={contract} refresh={refresh} />} installation={contract && <><ContractCommercial contract={contract} refresh={refresh} />{can(me, "stock:read") && <ContractEquipment id={contract.id} />}</>} services={contract && <><ContractStates id={contract.id} /><ContractAddons contract={contract} refresh={refresh} /></>} sections={contract ? [...(can(me, "finance:read") ? [{ id: "cobrancas", label: "Financeiro", content: <ContractFinance id={contract.id} /> }] : []), { id: "historico", label: "Histórico", content: <ProfileSection title="Histórico do contrato"><div className="profile-recent">{contract.history.map((event, index) => <div key={index}><span className="timeline-dot" /><div><strong>{({ created: "Contrato criado", plan_changed: "Plano alterado", ended: "Contrato encerrado", due_day_changed: "Vencimento alterado", credit_restricted: "Restrição de crédito", credit_released: "Restrição retirada", loyalty_set: "Fidelidade definida", penalty_charged: "Multa cobrada", penalty_waived: "Multa dispensada", amendment: "Aditivo registrado", addon_added: "Adicional contratado", addon_ended: "Adicional encerrado" } as Record<string,string>)[event.event] ?? event.event}</strong><p>{historyDescription(event.detail)}</p><small>{date(event.at)} · {event.actor_name ?? "Sistema"}</small></div></div>)}</div><ProfileFacts items={[["Identificador", contract.id]]} /></ProfileSection> }] : []} />;
}

function historyDescription(detail: Record<string, unknown>) {
 if (detail.from != null && detail.to != null) return `${detail.from} → ${detail.to}`;
 const labels: Record<string,string> = { plan: "Plano", version: "Versão", note: "Observação", reason: "Motivo", months: "Meses", until: "Até", model: "Modelo", product: "Produto", quantity: "Quantidade", title: "Título" };
 return Object.entries(detail).flatMap(([key,value]) => {
  if (value == null) return [];
  if (["amount_cents", "cents"].includes(key) && typeof value === "number") return [`Valor: ${money(value / 100)}`];
  if (!labels[key] || typeof value === "object") return [];
  const display = key === "model" ? ({ fixed: "Valor único", monthly: "Por mês restante" } as Record<string,string>)[String(value)] ?? String(value) : key === "until" ? date(String(value)) : String(value);
  return [`${labels[key]}: ${display}`];
 }).join(" · ");
}
