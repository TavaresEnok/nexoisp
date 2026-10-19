"use client";

import { NetworkOnlineView } from "./network-online-view";

import { useState } from "react";
import { useNetworkFilters } from "@/lib/use-network-filters";
import { useQueryState } from "@/lib/use-query-state";
import Link from "@/platform/navigation/link";
import { Filter, MapPin, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useWorkspace } from "@/components/workspace-provider";
import { NetworkQueryDialog } from "@/components/network-query-dialog";
import { matchesNetwork, filterLabels, type QueryKey } from "@/lib/network-query";
import { exportCsv } from "@/lib/format";
import styles from "./network-online.module.css";

const pageSize = 8;

export function NetworkOnline() {
  const { data, openSubscriber } = useWorkspace();
  const [filters, setFilters] = useNetworkFilters({ visibility: "online" });
  const [search, setSearch] = useQueryState("busca", "");
  const [dialog, setDialog] = useState(false);
  const [page, setPage] = useState(0);
  const connected = data.subscribers.filter(s => s.connection === "Online");
  const rows = data.subscribers.filter(s => matchesNetwork(s, filters, search));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * pageSize, (current + 1) * pageSize);
  const active = Object.entries(filters).filter(([key, value]) => key !== "visibility" && value);
  const pops = new Set(connected.map(s => s.pop).filter(Boolean)).size;
  const nas = new Set(connected.map(s => s.nas).filter(Boolean)).size;
  const ipv6Known = connected.filter(s => typeof s.access?.ipv6 === "boolean");
  const ipv6Count = ipv6Known.filter(s => s.access?.ipv6).length;
  const metrics = [
    { label: "Clientes conectados", value: String(connected.length).padStart(2, "0"), note: `${data.subscribers.length ? Math.round(connected.length / data.subscribers.length * 100) : 0}% dos clientes da base`, online: true },
    { label: "POPs com clientes online", value: String(pops).padStart(2, "0"), note: "Pontos de presença distintos" },
    { label: "Concentradores NAS", value: String(nas).padStart(2, "0"), note: "Associados aos clientes online" },
    { label: "Dual-Stack IPv6", value: ipv6Known.length ? String(ipv6Count) : "—", note: ipv6Known.length ? `${ipv6Known.length} clientes com informação de IPv6` : "Sem dados de IPv6 na base" },
  ];
  const clear = () => { setFilters({ visibility: "online" }); setSearch(""); setPage(0); };

  return <NetworkOnlineView metrics={metrics} actions={      <div className={styles.actions}>
        {active.length > 0 && <Button variant="ghost" size="sm" onClick={clear}><RotateCcw data-icon="inline-start" />Limpar filtros</Button>}
        <Link href="/rede/mapa" className={buttonVariants({ variant: "outline", size: "sm" })}><MapPin data-icon="inline-start" />Mapa</Link>
        <Button size="sm" onClick={() => setDialog(true)}><SlidersHorizontal data-icon="inline-start" />Fazer consulta{active.length > 0 && <span>({active.length})</span>}</Button>
      </div>} filterBar={<>    {active.length > 0 && <div className={styles.filters}><span><Filter size={13} />Filtros aplicados</span>{active.map(([key, value]) => <Badge key={key} variant="secondary">{filterLabels[key as QueryKey]}: {value === "yes" ? "Sim" : value === "no" ? "Não" : value}<button aria-label={`Remover filtro ${filterLabels[key as QueryKey]}`} onClick={() => { setFilters(prev => ({ ...prev, [key]: "" })); setPage(0); }}><X size={12} /></button></Badge>)}</div>}</>} rows={rows} visible={visible} connectedCount={connected.length} search={search} setSearch={value=>{setSearch(value);setPage(0);}} clear={clear} current={current} pages={pages} onPage={setPage} onExport={()=>exportCsv("nexo-acessos-online", ["Cliente", "Login", "IP", "MAC", "POP", "OLT", "PON", "Plano", "Download", "Upload", "Uptime"], rows.map(s => [s.name, s.access?.login || "", s.access?.ip || "", s.access?.mac || "", s.pop, s.access?.olt || "", s.access?.pon || "", s.plan, s.access?.download || "", s.access?.upload || "", s.access?.uptime || ""]))} openSubscriber={openSubscriber} source={`Estado cadastrado · ${data.snapshot.asOf}`} sourceNote="Sem leitura RADIUS ao vivo. Tráfego e duração ausentes são exibidos como “—”.">    {dialog && <NetworkQueryDialog open={dialog} onOpenChange={setDialog} filters={filters} subscribers={data.subscribers} onApply={value => { setFilters({ ...value, visibility: "online" }); setSearch(""); setPage(0); toast.success("Consulta aplicada."); }} />}</NetworkOnlineView>;
}
