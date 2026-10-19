"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, ArrowUpRight, Info, Mail, Maximize2, Minimize2, Phone, ShieldCheck } from "lucide-react";
import { SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Status, PersonAvatar } from "@/components/workspace-ui";
import { ProfileSection, ProfileFacts } from "@/components/subscriber-profile-sections";
import { cn } from "@/lib/utils";

// Peças visuais da ficha do assinante do v0, compartilhadas pela demonstração e pela operação.
export function SubscriberSheetHeader({ code, name, description, statuses, context }: { code: string; name: string; description: string; statuses: string[]; context: string }) {
  return <SheetHeader className="subscriber-sheet-header"><div className="eyebrow">FICHA DO ASSINANTE <span className="mono">#{code}</span></div><div className="subscriber-identity"><PersonAvatar name={name} /><div><SheetTitle>{name}</SheetTitle><SheetDescription>{description}</SheetDescription></div></div><div className="subscriber-statuses">{statuses.map((value, index) => <Status key={index} value={value} />)}<span className="subscriber-context"><ShieldCheck size={13} />{context}</span></div></SheetHeader>;
}

export function SubscriberExpandButton({ expanded, onExpand }: { expanded: boolean; onExpand: () => void }) {
  return <Button variant="ghost" onClick={onExpand} className="profile-expand">{expanded ? <Minimize2 data-icon="inline-start" /> : <Maximize2 data-icon="inline-start" />}{expanded ? "Recolher ficha" : "Ampliar ficha"}</Button>;
}

export function SubscriberSheetTabs({ value, onChange, tabs, children }: { value: string; onChange: (value: string) => void; tabs: { value: string; label: string; alert?: boolean; count?: number }[]; children: ReactNode }) {
  const tabScroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = tabScroll.current;
    if (!scroller) return;
    const revealActiveTab = () => {
      const active = scroller.querySelector<HTMLElement>('[data-slot="tabs-trigger"][data-active]');
      if (!active) return;
      const bounds = scroller.getBoundingClientRect();
      const target = active.getBoundingClientRect();
      if (target.left < bounds.left || target.right > bounds.right) scroller.scrollLeft += target.left - bounds.left - (bounds.width - target.width) / 2;
    };
    revealActiveTab();
    const observer = new ResizeObserver(revealActiveTab);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [value]);
  return <Tabs value={value} onValueChange={next => onChange(String(next))} className="subscriber-tabs"><div ref={tabScroll} className="profile-tab-scroll"><TabsList variant="line" aria-label="Seções da ficha do assinante">{tabs.map(tab => <TabsTrigger key={tab.value} value={tab.value}>{tab.label}{tab.alert && <span className="nav-alert" />}{tab.count !== undefined && <span className="tab-count">{tab.count}</span>}</TabsTrigger>)}</TabsList></div>
    {children}
  </Tabs>;
}

export type SubscriberOverviewProps = {
  kpis: { label: string; value: ReactNode; detail: ReactNode; danger?: boolean; onClick?: () => void }[];
  attention: { icon: LucideIcon; title: string; detail: string; onClick: () => void }[];
  before?: ReactNode;
  contracts: ReactNode;
  contact: { phone?: string | null; email?: string | null; facts: [string, ReactNode][]; caption: string; onOpen: () => void };
  technical: { caption: string; facts: [string, ReactNode][]; footnote: string; onOpen?: () => void };
  recent: { items: { id: string; title: string; description?: string; meta: string }[]; onAll: () => void; empty?: string; loading?: boolean };
  footnote: string;
};

export function SubscriberOverview({ kpis, attention, before, contracts, contact, technical, recent, footnote }: SubscriberOverviewProps) {
  return <div className="sheet-content-body">
    <div className="profile-kpis">{kpis.map(kpi => <button key={kpi.label} onClick={kpi.onClick}><span>{kpi.label}</span><strong className={kpi.danger === undefined ? undefined : cn(kpi.danger && "text-danger")}>{kpi.value}</strong><small>{kpi.detail}<ArrowUpRight size={12} /></small></button>)}</div>
    {before}
    {attention.length > 0 && <div className="profile-attention"><div><span className="eyebrow">ANTES DA PRÓXIMA AÇÃO</span><h3>O que precisa de atenção</h3></div>{attention.map(({ icon: Icon, title, detail, onClick }) => <button key={title} onClick={onClick}><Icon size={17} /><span><strong>{title}</strong><small>{detail}</small></span><ArrowRight size={15} /></button>)}</div>}
    <div className="profile-two-columns">{contracts}<ProfileSection title="Contato e endereço cadastral" caption={contact.caption} action={<button className="profile-text-action" onClick={contact.onOpen}>Cadastro<ArrowUpRight size={13} /></button>}>{(contact.phone || contact.email) && <div className="profile-contact-links">{contact.phone && <a href={`tel:${contact.phone.replace(/[^+\d]/g, "")}`}><Phone size={15} /><span>{contact.phone}</span></a>}{contact.email && <a href={`mailto:${contact.email}`}><Mail size={15} /><span>{contact.email}</span></a>}</div>}<ProfileFacts items={contact.facts} /></ProfileSection></div>
    <div className="profile-two-columns"><ProfileSection title="Contexto técnico" caption={technical.caption} action={technical.onOpen && <button className="profile-text-action" onClick={technical.onOpen}>Detalhes<ArrowUpRight size={13} /></button>}><ProfileFacts items={technical.facts} /><p className="profile-footnote"><ShieldCheck size={13} /> {technical.footnote}</p></ProfileSection><ProfileSection title="Últimos movimentos" caption="Eventos vinculados a este assinante."><div className="profile-recent">{recent.items.map(a => <div key={a.id}><span className="timeline-dot" /><div><strong>{a.title}</strong><p>{a.description}</p><small>{a.meta}</small></div></div>)}{!recent.items.length && <p className="profile-footnote">{recent.loading ? "Consultando eventos…" : recent.empty ?? "Nenhum evento adicional registrado."}</p>}</div><button className="profile-text-action" onClick={recent.onAll}>Ver histórico completo<ArrowRight size={13} /></button></ProfileSection></div>
    <p className="profile-footnote"><Info size={13} /> {footnote}</p>
  </div>;
}
