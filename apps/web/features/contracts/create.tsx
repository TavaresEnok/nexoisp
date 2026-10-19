import { useState } from "react";
import useSWR from "swr";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MutationForm, FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
import { money } from "@/lib/format";
export function CreateContract({ subscriberId, onClose, onDone }: { subscriberId: string; onClose: () => void; onDone: () => Promise<void> }) {
 const plans = useSWR("erp-plans-for-contract", () => api<{ id: string; name: string; price_cents: number; down_kbps: number; active: boolean }[]>("/plans"));
 const [planId, setPlanId] = useState(""); const [dueDay, setDueDay] = useState("10");
 return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogHeader><DialogTitle>Novo contrato</DialogTitle><DialogDescription>O contrato utiliza a versão atual do plano e preserva seus vínculos comerciais.</DialogDescription></DialogHeader><QueryBoundary loading={plans.isLoading} error={plans.error} retry={() => plans.mutate()}><MutationForm onCancel={onClose} submit="Criar contrato" onSubmit={async () => { await api("/contracts", { body: { subscriber_id: subscriberId, plan_id: planId, due_day: Number(dueDay) } }); await onDone(); }}><FormField label="Plano"><select className="commercial-select" value={planId} required onChange={e => setPlanId(e.target.value)}><option value="">Selecione um plano</option>{plans.data?.filter(plan => plan.active).map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {money(plan.price_cents / 100)} · {plan.down_kbps / 1000} Mbps</option>)}</select></FormField><FormField label="Dia de vencimento" hint="Entre 1 e 28."><Input type="number" min={1} max={28} required value={dueDay} onChange={e => setDueDay(e.target.value)} /></FormField></MutationForm></QueryBoundary></DialogContent></Dialog>;
}
