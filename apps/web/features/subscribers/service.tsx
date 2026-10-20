import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  ClipboardList,
  Headphones,
  History,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import styles from "@/components/service-records.module.css";

/** Aba de atendimento da ficha com a composição de `subscriber-service.tsx` do v0. */
export function SubscriberServiceWorkspace({
  firstName,
  openTickets,
  openOrders,
  events,
  onHistory,
  tickets,
  orders,
}: {
  firstName: string;
  openTickets: number | null;
  openOrders: number | null;
  events: number | null;
  onHistory: () => void;
  tickets?: ReactNode;
  orders?: ReactNode;
}) {
  const [tab, setTab] = useState(tickets ? "ocorrencias" : "ordens");
  const count = (value: number | null) =>
    value === null ? "—" : String(value).padStart(2, "0");
  return (
    <div className={styles.workspace}>
      <header className={styles.heading}>
        <div>
          <p className="eyebrow">ATENDIMENTO E CAMPO</p>
          <h3>Uma história, todo o contexto.</h3>
          <p>Ocorrências, visitas e registros de {firstName}.</p>
        </div>
        <Badge variant="outline">Registros do provedor</Badge>
      </header>
      <div className={styles.summary}>
        <button disabled={!tickets} onClick={() => setTab("ocorrencias")}>
          <Headphones size={16} />
          <span>
            <small>Ocorrências em aberto</small>
            <strong>{count(openTickets)}</strong>
          </span>
          <ArrowUpRight size={14} />
        </button>
        <button disabled={!orders} onClick={() => setTab("ordens")}>
          <CalendarDays size={16} />
          <span>
            <small>OS pendentes</small>
            <strong>{count(openOrders)}</strong>
          </span>
          <ArrowUpRight size={14} />
        </button>
        <button onClick={onHistory}>
          <History size={16} />
          <span>
            <small>Eventos no histórico</small>
            <strong>{count(events)}</strong>
          </span>
          <ArrowUpRight size={14} />
        </button>
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(String(value))}
        className={styles.recordsTabs}
      >
        <div className={styles.tabScroll}>
          <TabsList variant="line" aria-label="Atendimento do assinante">
            {tickets && (
              <TabsTrigger value="ocorrencias">
                <Headphones data-icon="inline-start" />
                Ocorrências
                {openTickets !== null && (
                  <Badge variant="secondary">{openTickets}</Badge>
                )}
              </TabsTrigger>
            )}
            {orders && (
              <TabsTrigger value="ordens">
                <ClipboardList data-icon="inline-start" />
                <span className={styles.fullLabel}>Ordens de serviço</span>
                <span className={styles.shortLabel}>OS</span>
                {openOrders !== null && (
                  <Badge variant="secondary">{openOrders}</Badge>
                )}
              </TabsTrigger>
            )}
          </TabsList>
        </div>
        {tickets && <TabsContent value="ocorrencias">{tickets}</TabsContent>}
        {orders && <TabsContent value="ordens">{orders}</TabsContent>}
      </Tabs>
    </div>
  );
}
