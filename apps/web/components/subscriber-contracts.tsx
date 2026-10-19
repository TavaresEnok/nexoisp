"use client";

import { ArrowUpRight, MapPin } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/workspace-ui";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { getCommercialData, contractMonthlyTotal } from "@/lib/commercial";
import { money } from "@/lib/format";
import type { WorkspaceData } from "@/lib/types";

export type SubscriberContractCard = { id: string; title: string; status: string; plan: string; address: string; monthly: number; dueDay: number; extras?: string; action?: ReactNode };

export function SubscriberContracts({ subscriberId, data, navigate }: { subscriberId: string; data: WorkspaceData; navigate: (href: string) => void }) {
  const { plans, contracts } = getCommercialData(data);
  const linked = contracts.filter(c => c.subscriberId === subscriberId);
  const total = linked.filter(c => !["Cancelado", "Encerrado"].includes(c.status)).reduce((sum, c) => sum + contractMonthlyTotal(c), 0);
  return <SubscriberContractList count={linked.length} total={total} onConsult={() => navigate(`/contratos?assinante=${encodeURIComponent(subscriberId)}`)} contracts={linked.map(c => ({ id: c.id, title: `${c.code} · ${c.label}`, status: c.status, plan: plans.find(p => p.id === c.planId)?.name ?? "Plano não encontrado", address: c.address, monthly: contractMonthlyTotal(c), dueDay: c.dueDay, extras: c.additionalServices.length > 0 ? `Adicionais: ${c.additionalServices.map(a => a.name).join(", ")}` : undefined }))} />;
}

export function SubscriberContractList({ count, total, onConsult, contracts, totalLabel = "Mensalidade total dos contratos não encerrados", empty = "Nenhum contrato vinculado a este titular.", footer }: { count: number; total: number; onConsult: () => void; contracts: SubscriberContractCard[]; totalLabel?: string; empty?: string; footer?: ReactNode }) {
  return <ProfileSection title={`Contratos do titular (${count})`} caption="Cada endereço ou serviço pode ter um contrato independente, sem duplicar o assinante." action={<Button variant="ghost" size="sm" onClick={onConsult}>Consultar vínculos<ArrowUpRight data-icon="inline-end" /></Button>}>
    <div className="commercial-subscriber-total"><span>{totalLabel}</span><strong>{money(total)}</strong></div><div className="flex flex-col gap-3">{contracts.map(c => <article key={c.id} className="commercial-contract-card"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{c.title}</strong><Status value={c.status} /></div><p>{c.plan}</p><span><MapPin size={14} />{c.address}</span><div className="flex items-center justify-between gap-2"><b>{money(c.monthly)} / mês</b><small>Vencimento dia {c.dueDay}</small></div>{c.extras && <p>{c.extras}</p>}{c.action}</article>)}</div>{!contracts.length && <p className="text-sm text-muted-foreground">{empty}</p>}{footer}
  </ProfileSection>;
}
