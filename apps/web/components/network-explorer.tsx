"use client";

import { useState, type ReactNode } from "react";
import { useNetworkFilters } from "@/lib/use-network-filters";
import { useQueryState } from "@/lib/use-query-state";
import Link from "@/platform/navigation/link";
import { Search, SlidersHorizontal, MapPin, ArrowUpRight, Radio, X, LocateOff, ListFilter } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/features/workspace/context";
import { NetworkQueryDialog } from "@/components/network-query-dialog";
import { NetworkOnline } from "@/components/network-online";
import { hasLocation, filterLabels, type NetworkFilters, type QueryKey } from "@/lib/network-query";
import { cn } from "@/lib/utils";
import styles from "./network-explorer.module.css";
import { selectMapSubscribers } from "@/application/selectors/network";
import { isDemoMode } from "@/application/execution-mode";

import { ClientMap } from "@/platform/maps/client-map";

export function NetworkExplorer({ mode }: { mode: "map" | "online" }) {
  return mode === "online" ? <NetworkOnline /> : <NetworkMapExplorer />;
}

function NetworkMapExplorer() {
  const { data, openSubscriber } = useWorkspace();
  const map = true;
  const initial: NetworkFilters = { visibility: map ? "all" : "online" };
  const [filters, setFilters] = useNetworkFilters(initial);
  const [query, setQuery] = useQueryState("busca", "");
  const [dialog, setDialog] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [list, setList] = useState(false);
  const { rows, located, online } = selectMapSubscribers(data.subscribers, filters, query);
  const active = Object.entries(filters).filter(([key, value]) => key !== "visibility" && value);
  const clear = () => { setFilters(initial); setQuery(""); setSelected(null); };
  return <section className={styles.page}>
    <header className={styles.header}><div><p className={styles.overline}>RELATÓRIO <span>/</span> {map ? "GEOLOCALIZAÇÃO" : "CONSULTA DE CONEXÕES"}</p><h1>{map ? "Sua rede, no mapa." : "Online agora"}</h1><p>{map ? "Localize instalações e consulte o estado de conexão de cada cliente." : "Consulte os clientes conectados com os parâmetros que você precisa."}</p></div><div className={styles.actions}><Link href={map ? "/rede/online" : "/rede/mapa"} className={buttonVariants({ variant: "outline", size: "sm" })}>{map ? <Radio data-icon="inline-start" /> : <MapPin data-icon="inline-start" />}{map ? "Online agora" : "Abrir mapa"}</Link><Button onClick={() => setDialog(true)} size="sm"><SlidersHorizontal data-icon="inline-start" />{map ? "Filtros do mapa" : "Fazer consulta"}{active.length > 0 && <span>({active.length})</span>}</Button></div></header>
    {active.length > 0 && <div className={styles.chips}><ListFilter size={14} />{active.map(([key, value]) => <Badge key={key} variant="secondary">{filterLabels[key as QueryKey]}: {value === "yes" ? "Sim" : value === "no" ? "Não" : value}<button aria-label={`Remover filtro ${filterLabels[key as QueryKey]}`} onClick={() => setFilters(prev => ({ ...prev, [key]: "" }))}><X size={12} /></button></Badge>)}<Button size="sm" variant="ghost" onClick={clear}>Limpar filtros</Button></div>}
    {map ? <div className={styles.mapShell}>
      <div className={styles.mapToolbar}><div className={styles.search}><Search size={15} /><Input aria-label="Buscar instalações" placeholder="Nome, login, endereço ou bairro…" value={query} onChange={e => { setQuery(e.target.value); setList(true); }} /></div><div className={styles.mapCounts}><span>{located.length} no mapa</span><span><i className={styles.onlineDot} />{online} online</span><span><i className={styles.offlineDot} />{rows.length - online} offline</span></div><Button variant="outline" size="sm" onClick={() => setList(v => !v)}><ListFilter data-icon="inline-start" />{list ? "Ocultar lista" : "Ver clientes"}</Button></div>
      <div className={styles.mapCanvas}><ClientMap rows={rows} selectedId={selected} />
        {list && <aside className={styles.mapList} aria-label="Instalações encontradas"><div className={styles.listHeading}><strong>{rows.length} instalações</strong><Button variant="ghost" size="icon-sm" aria-label="Fechar lista de instalações" onClick={() => setList(false)}><X /></Button></div>{rows.length ? rows.map(s => <button key={s.id} className={styles.locationRow} onClick={() => { if (hasLocation(s)) setSelected(s.id); else openSubscriber(s.id); }}><span className={s.connection === "Online" ? styles.onlineDot : styles.offlineDot} /><span><strong>{s.name}</strong><small>{s.address}</small><small>{hasLocation(s) ? s.pop : "Coordenadas não cadastradas"}</small></span><ArrowUpRight size={13} /></button>) : <p className={styles.listEmpty}>Nenhuma instalação encontrada.</p>}</aside>}
        {located.length === 0 && !list && <div className={styles.mapEmpty}><LocateOff size={22} /><strong>{rows.length ? "Faltam as coordenadas das instalações" : "Nenhum cliente nesta seleção"}</strong><p>{rows.length ? "Os endereços estão disponíveis, mas ainda não têm latitude e longitude registradas. Nenhum ponto foi posicionado por aproximação." : "Ajuste os filtros para encontrar outras instalações."}</p><Button variant="outline" size="sm" onClick={() => rows.length ? setList(true) : clear()}>{rows.length ? "Consultar endereços" : "Limpar filtros"}</Button></div>}
        <div className={styles.legend}><span><i className={styles.onlineDot} />Online</span><span><i className={styles.offlineDot} />Offline</span><span>Local da instalação</span></div>
      </div><footer className={styles.mapFooter}><span><MapPin size={13} />{rows.length - located.length} instalações sem coordenadas</span><span>Arraste para mover · use + e − para aproximar</span></footer>
    </div> : null}
    <p className={cn(styles.source, map && styles.mapSource)}>{isDemoMode ? "Base demonstrativa local." : "Base demonstrativa persistida no Neon."} Status estático; nenhum concentrador ou OLT real conectado.{map && " Os endereços não são enviados automaticamente a serviços de geocodificação."}</p>
    {dialog && <NetworkQueryDialog open={dialog} onOpenChange={setDialog} filters={filters} subscribers={data.subscribers} map={map} onApply={value => { setFilters(value); setQuery(""); }} />}
  </section>;
}

// Moldura do mapa do v0 para camadas conectadas: cabeçalho, barra, tela, lista e rodapé.
export function MapExplorerFrame({ description, actions, controls, toolbar, canvas, list, overlay, footer, children }: { description: string; actions?: ReactNode; controls?: ReactNode; toolbar: ReactNode; canvas: ReactNode; list?: ReactNode; overlay?: ReactNode; footer: ReactNode; children?: ReactNode }) {
  return <section className={styles.page}>
    <header className={styles.header}><div><p className={styles.overline}>RELATÓRIO <span>/</span> GEOLOCALIZAÇÃO</p><h1>Sua rede, no mapa.</h1><p>{description}</p></div><div className={styles.actions}>{actions}</div></header>
    {controls}
    <div className={styles.mapShell}>
      <div className={styles.mapToolbar}>{toolbar}</div>
      <div className={styles.mapCanvas}>{canvas}{list}{overlay}</div>
      <footer className={styles.mapFooter}>{footer}</footer>
    </div>
    {children}
  </section>;
}
export function MapListPanel({ heading, label, closeLabel, onClose, children }: { heading: string; label: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  return <aside className={styles.mapList} aria-label={label}><div className={styles.listHeading}><strong>{heading}</strong><Button variant="ghost" size="icon-sm" aria-label={closeLabel} onClick={onClose}><X /></Button></div>{children}</aside>;
}
export const mapExplorerStyles = styles;
