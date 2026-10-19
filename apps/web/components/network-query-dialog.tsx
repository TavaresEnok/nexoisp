"use client";

import { useState } from "react";
import { Search, RotateCcw, SlidersHorizontal, Info, Server, Wifi, MapPin, FileText, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { querySections, networkOptions, validIpQuery, type NetworkFilters, type NetworkSubscriber, type QueryKey } from "@/lib/network-query";
import styles from "./network-explorer.module.css";

const sectionIcons = { infra: Server, connection: Wifi, address: MapPin, subscriber: FileText, regulatory: ShieldCheck };

export function NetworkQueryDialog({ open, onOpenChange, filters, subscribers, map = false, onApply }: { open: boolean; onOpenChange: (open: boolean) => void; filters: NetworkFilters; subscribers: NetworkSubscriber[]; map?: boolean; onApply: (filters: NetworkFilters) => void }) {
  const [draft, setDraft] = useState<NetworkFilters>(filters);
  const [tab, setTab] = useState("infra");
  const [error, setError] = useState("");
  const update = (key: QueryKey | "visibility", value: string) => { setDraft(prev => ({ ...prev, [key]: value, ...(key === "pop" ? { nas: "" } : {}), ...(key === "olt" ? { pon: "" } : {}) })); setError(""); };
  const count = Object.entries(draft).filter(([key, v]) => v && key !== "visibility").length;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className={styles.dialog}>
    <DialogHeader className={styles.dialogHeader}><div className={styles.dialogHeading}><span className={styles.dialogIcon}><SlidersHorizontal size={18} /></span><div><DialogTitle>{map ? "Consulta no mapa" : "Consulta online"}</DialogTitle><DialogDescription>Filtre por parâmetros de rede, endereço ou assinante.</DialogDescription></div></div></DialogHeader>
    <form className={styles.queryForm} onSubmit={event => { event.preventDefault(); if (draft.ip && !validIpQuery(draft.ip.trim())) { setError("Informe um IPv4 válido ou uma rede CIDR, como 100.64.0.0/16."); setTab("connection"); return; } onApply({ ...draft, ip: draft.ip?.trim() }); onOpenChange(false); }}>
      <Tabs value={tab} onValueChange={value => setTab(String(value))} className={styles.queryTabs}><div className={styles.tabScroll}><TabsList variant="line">{querySections.map(section => <TabsTrigger key={section.id} value={section.id}>{(() => { const Icon = sectionIcons[section.id]; return <Icon data-icon="inline-start" />; })()}{section.label}</TabsTrigger>)}</TabsList></div>
        {querySections.map(section => <TabsContent key={section.id} value={section.id} className={styles.tabBody}><p className={styles.sectionDescription}>{section.description}</p><FieldGroup className={styles.fieldGrid}>{section.fields.map(([key, label, type]) => {
          const id = `query-${key}`;
          const options = type === "boolean" ? ["yes", "no"] : type === "select" ? networkOptions(subscribers, key, draft) : [];
          return <Field key={key} data-invalid={key === "ip" && !!error} className={type === "check" ? styles.checkField : undefined}>
            {type === "check" ? <label className={styles.checkLabel} htmlFor={id}><input id={id} type="checkbox" checked={draft[key] === "yes"} onChange={e => update(key, e.target.checked ? "yes" : "")} />{label}</label> : <><FieldLabel htmlFor={id}>{label}</FieldLabel>{type === "select" || type === "boolean" ? <select id={id} value={draft[key] || ""} onChange={e => update(key, e.target.value)} className={styles.select}><option value="">Não filtrar</option>{options.map(option => <option key={option} value={option}>{option === "yes" ? "Sim" : option === "no" ? "Não" : option}</option>)}</select> : <Input id={id} value={draft[key] || ""} onChange={e => update(key, e.target.value)} aria-invalid={key === "ip" && !!error} maxLength={160} placeholder={key === "ip" ? "Ex.: 100.64.0.0/16" : key === "address" ? "Rua ou avenida da instalação" : "Digite para filtrar"} />}</>}
            {type === "select" && options.length === 0 && <FieldDescription>Sem valores informados na base.</FieldDescription>}{key === "ip" && error && <p role="alert" className={styles.error}>{error}</p>}
          </Field>;
        })}{section.id === "regulatory" && <Field data-disabled><label htmlFor="query-anatel" className={styles.checkLabel}><input id="query-anatel" type="checkbox" disabled />Dados detalhados para ANATEL</label><FieldDescription>Indisponível nesta base: os dados regulatórios ainda não foram integrados.</FieldDescription></Field>}</FieldGroup></TabsContent>)}
      </Tabs>
      {map && <FieldGroup className={styles.mapVisibility}><Field><FieldLabel htmlFor="query-visibility">Exibição no mapa</FieldLabel><select id="query-visibility" className={styles.select} value={draft.visibility || "all"} onChange={e => update("visibility", e.target.value)}><option value="all">Online e offline</option><option value="online">Somente online</option><option value="offline">Somente offline</option></select></Field><Field data-disabled><label htmlFor="query-pois" className={styles.checkLabel}><input id="query-pois" type="checkbox" disabled />Exibir pontos de interesse</label><FieldDescription>Nenhuma camada de pontos de interesse foi integrada.</FieldDescription></Field></FieldGroup>}
      <p className={styles.queryHint}><Info size={14} />Parâmetros técnicos ausentes não são deduzidos. Esta base é demonstrativa; a consulta não acessa equipamentos.</p>
      <footer className={styles.dialogFooter}><Button type="button" variant="ghost" onClick={() => { setDraft({ visibility: map ? "all" : "online" }); setError(""); }}><RotateCcw data-icon="inline-start" />Limpar</Button><div><Badge variant="secondary">{count} {count === 1 ? "filtro" : "filtros"}</Badge><Button variant="outline" type="button" onClick={() => onOpenChange(false)}>Cancelar</Button><Button type="submit"><Search data-icon="inline-start" />{map ? "Aplicar no mapa" : "Consultar online"}</Button></div></footer>
    </form>
  </DialogContent></Dialog>;
}
