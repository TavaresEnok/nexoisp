"use client";

import { ArrowUpRight, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/workspace-ui";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { getCommercialData, contractMonthlyTotal } from "@/lib/commercial";
import { money } from "@/lib/format";
import type { WorkspaceData } from "@/lib/types";

export function SubscriberContracts({ subscriberId, data, navigate }: { subscriberId: string; data: WorkspaceData; navigate: (href: string) => void }) {
  const { plans, contracts } = getCommercialData(data);
  const linked = contracts.filter(c => c.subscriberId === subscriberId);
  const total = linked.filter(c => !["Cancelado", "Encerrado"].includes(c.status)).reduce((sum, c) => sum + contractMonthlyTotal(c), 0);
  return <ProfileSection title={`Contratos do titular (${linked.length})`} caption="Cada endereço ou serviço pode ter um contrato independente, sem duplicar o assinante." action={<Button variant="ghost" size="sm" onClick={() => navigate(`/contratos?assinante=${encodeURIComponent(subscriberId)}`)}>Consultar vínculos<ArrowUpRight data-icon="inline-end" /></Button>}>
    <div className="commercial-subscriber-total"><span>Mensalidade total dos contratos não encerrados</span><strong>{money(total)}</strong></div><div className="flex flex-col gap-3">{linked.map(c => <article key={c.id} className="commercial-contract-card"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{c.code} · {c.label}</strong><Status value={c.status} /></div><p>{plans.find(p => p.id === c.planId)?.name ?? "Plano não encontrado"}</p><span><MapPin size={14} />{c.address}</span><div className="flex items-center justify-between gap-2"><b>{money(contractMonthlyTotal(c))} / mês</b><small>Vencimento dia {c.dueDay}</small></div>{c.additionalServices.length > 0 && <p>Adicionais: {c.additionalServices.map(a => a.name).join(", ")}</p>}</article>)}</div>{!linked.length && <p className="text-sm text-muted-foreground">Nenhum contrato vinculado a este titular.</p>}
  </ProfileSection>;
}
