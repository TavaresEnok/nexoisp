"use client";

import type { ReactNode } from "react";
import { ArrowUpRight, Copy, FileText, MapPin, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/workspace-ui";
import { EmptyState } from "@/components/workspace-feedback";
import { money, date } from "@/lib/format";
import type { Subscriber, WorkspaceData } from "@/lib/types";
import { getSubscriberProfile } from "@/lib/subscriber-profile";

export function ProfileSection({ title, caption, children, action }: { title: string; caption?: string; children: ReactNode; action?: ReactNode }) {
  return <section className="profile-section"><header><div><h3>{title}</h3>{caption && <p>{caption}</p>}</div>{action}</header>{children}</section>;
}
export function ProfileFacts({ items }: { items: [string, ReactNode][] }) {
  return <dl className="profile-facts">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
export function SubscriberContract({ subscriber: s }: { subscriber: Subscriber }) {
  return <ProfileSection title="Serviço contratado" caption="Condições comerciais separadas do estado técnico do acesso."><div className="profile-plan"><span><Wifi size={22} /></span><div><strong>{s.plan}</strong><p>{s.speed} Mbps de download</p></div><div><strong>{money(s.price)}</strong><p>por mês</p></div></div><ProfileFacts items={[["Contrato", <span className="mono" key="contract">{s.contract}</span>], ["Situação comercial", <Status key="status" value={s.status} />], ["Início da vigência", date(s.since)], ["Dia de vencimento", `Todo dia ${s.dueDay}`], ["Ponto de presença", s.pop], ["Conexão registrada", <Status key="connection" value={s.connection} />]]} /></ProfileSection>;
}
export function SubscriberRegistration({ subscriber: s, copy }: { subscriber: Subscriber; copy: (value: string) => void }) {
  return <div className="profile-two-columns"><ProfileSection title="Identificação e contato" caption="Dados do titular disponíveis no cadastro."><ProfileFacts items={[["Nome completo", s.name], ["CPF / CNPJ", s.document], ["Código do assinante", s.code], ["Cliente desde", date(s.since)], ["E-mail principal", <span className="profile-copy" key="email"><a href={`mailto:${s.email}`}>{s.email}</a><button aria-label="Copiar e-mail" onClick={() => copy(s.email)}><Copy size={13} /></button></span>], ["Telefone principal", <span className="profile-copy" key="phone"><a href={`tel:${s.phone.replace(/[^+\d]/g, "")}`}>{s.phone}</a><button aria-label="Copiar telefone" onClick={() => copy(s.phone)}><Copy size={13} /></button></span>]]} /></ProfileSection><ProfileSection title="Endereço de instalação" caption="Local de prestação do serviço."><div className="profile-address"><MapPin size={20} /><div><strong>{s.address}</strong><p>{s.neighborhood}</p></div></div><ProfileFacts items={[["Bairro", s.neighborhood], ["POP de atendimento", s.pop], ["Contrato vinculado", s.contract]]} /><p className="profile-footnote">Complemento, CEP e referência não foram informados no cadastro disponível.</p></ProfileSection></div>;
}
export function SubscriberFinancial({ subscriber: s, data, navigate }: { subscriber: Subscriber; data: WorkspaceData; navigate: (href: string) => void }) {
  const p = getSubscriberProfile(s, data);
  return <><FinancialTotals items={[["Vencido", money(p.overdueTotal), `${p.overdue.length} título(s)`], ["A vencer", money(p.pendingTotal), `${p.pending.length} título(s)`], ["Em conciliação", money(p.reconciliationTotal), "Baixa não confirmada"], ["Pago no período", money(p.paidTotal), `${p.paid.length} título(s)`]]} /><ProfileSection title="Títulos do contrato" caption="Valores calculados somente sobre os registros disponíveis." action={<Button variant="ghost" size="sm" onClick={() => navigate(`/financeiro?busca=${encodeURIComponent(s.name)}`)}>Financeiro<ArrowUpRight data-icon="inline-end" /></Button>}>
    {p.invoices.length ? <div className="profile-table-scroll"><table className="profile-table"><thead><tr><th>Título / referência</th><th>Vencimento</th><th>Pagamento</th><th>Situação</th><th className="numeric">Valor</th></tr></thead><tbody>{p.invoices.map(i => <tr key={i.id}><td><strong>{i.code}</strong><small>{i.reference}</small></td><td>{date(i.due)}</td><td>{i.method}</td><td><Status value={i.status} /></td><td className="numeric">{money(i.amount)}</td></tr>)}</tbody></table></div> : <EmptyState icon={FileText} title="Nenhum título vinculado" description="Não há faturas para este assinante nos registros disponíveis." />}
    <p className="profile-footnote">Pagamento em conciliação não é considerado recebido. Juros, multas e acordos não são presumidos.</p></ProfileSection></>;
}
export function FinancialTotals({ items }: { items: [string, ReactNode, ReactNode][] }) {
  return <div className="profile-financial-totals">{items.map(([label, value, detail]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>)}</div>;
}
