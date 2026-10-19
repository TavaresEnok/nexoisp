"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "@/platform/navigation/react";
import { useQueryState } from "@/lib/use-query-state";
import {
  Wrench,
  CalendarDays,
  MapPin,
  Clock3,
  ArrowUpRight,
  Download,
  ChevronRight,
  UserRound,
  CircleCheck,
  Columns3,
  List,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Panel,
  PageHeading,
  Status,
  PersonAvatar,
  SourceFooter,
  DemoNotice,
} from "@/components/workspace-ui";
import { useWorkspace } from "@/features/workspace/context";
import { exportCsv, scenarioDate, normalize } from "@/lib/format";
import { ServiceOrderDetails } from "@/components/service-order-details";
import { InputGroup, InputGroupInput, InputGroupAddon } from "@/components/ui/input-group";
import type { WorkOrder } from "@/lib/types";
import { EmptyState } from "@/components/workspace-feedback";
import { FieldOrderBoard } from "@/components/field-order-board";
import { cn } from "@/lib/utils";
import styles from "./operations.module.css";
import { selectOrders } from "@/application/selectors/operations";
import { QueryBoundary } from "@/features/shared/feedback";
import type { WorkOrderSubscriber } from "@/lib/work-order-print";
import { fieldOrderViews } from "@/domain/view-states";

export function FieldOperations() {
  const { data, openSubscriber } = useWorkspace();
  return <OrderWorkspace orders={data.orders} subscribers={data.subscribers} reference={data.snapshot.asOf} provider={data.snapshot.provider} openSubscriber={openSubscriber} />;
}
export function OrderWorkspace({ orders, subscribers = [], reference, provider, openSubscriber, operational = false, statusOptions, technicianOptions, total, actions, controls, onOpen, onExport, pagination, loading, error, onTechnician, onResetFilters }: { orders: WorkOrder[]; subscribers?: WorkOrderSubscriber[]; reference: string; provider: string; openSubscriber:(id:string)=>void; operational?:boolean; statusOptions?:string[]; technicianOptions?:{value:string;label:string}[]; total?:number; actions?:ReactNode; controls?:ReactNode; onOpen?:(order:WorkOrder)=>void; onExport?:()=>void; pagination?:ReactNode; loading?:boolean; error?:unknown; onTechnician?:(value:string)=>void; onResetFilters?:()=>void }) {
  const params = useSearchParams();
  const [filter, setFilter] = useQueryState("situacao", operational ? "Pendentes" : params.get("filtro") === "atrasadas" ? "Atrasada" : "Todas", statusOptions ?? ["Todas", ...orders.map(o => o.status)], { resetPage: operational });
  const [query, setQuery] = useQueryState("busca", "", undefined, { resetPage: operational });
  const [view, setView] = useQueryState("visualizacao", "board", fieldOrderViews);
  const [technician, setTechnician] = useQueryState("tecnico", "Todos", ["Todos", ...(technicianOptions ? technicianOptions.map(tech => tech.value) : orders.map(o => o.technician))], { resetPage: operational });
  const [selected, setSelected] = useState<WorkOrder | null>(null);
  const rows = operational ? orders : selectOrders(orders, filter, technician, query);
  const openOrder = (order: WorkOrder) => onOpen ? onOpen(order) : setSelected(order);
  const technicians = technicianOptions ?? [...new Set(orders.map((o) => o.technician))].map(name => ({ value: name, label: name }));
  const completed = orders.filter((o) => o.status === "Concluída").length;
  const changeTechnician = (value:string) => onTechnician ? onTechnician(value) : setTechnician(value);
  const resetFilters = () => {
    if (onResetFilters) { onResetFilters(); return; }
    setQuery("");
    setFilter("Todas");
    setTechnician("Todos");
  };
  return (
    <>
      <PageHeading
        title="Ordens de serviço"
        description="Agenda, contexto e execução alinhados para a próxima visita."
        actions={
          <>{actions}<Button
            variant="outline"
            onClick={onExport ?? (() =>
              exportCsv(
                "nexo-agenda-demonstrativa",
                [
                  "OS",
                  "Horário",
                  "Serviço",
                  "Assinante fictício",
                  "Bairro",
                  "Técnico",
                  "Status",
                ],
                rows.map((o) => [
                  o.code,
                  o.time,
                  o.type,
                  o.name,
                  o.neighborhood,
                  o.technician,
                  o.status,
                ]),
              )
            )}
          >
            <Download data-icon="inline-start" />
            Exportar agenda
          </Button></>
        }
      />
      <div className={cn("field-top-strip", styles.overview)}>
        <div>
          <CalendarDays size={19} />
          <span>
            <strong>{scenarioDate(reference, "weekday")}</strong>
            <small>{operational ? "Consulta paginada de OS" : "Agenda demonstrativa · 2026"}</small>
          </span>
        </div>
        <div>
          <span className="live-dot" />
          {operational ? `${total ?? orders.length} OS na consulta · ${orders.length} nesta página` : `${orders.length} visitas programadas`}
        </div>
        <div className={styles.completion}>
          <span><CircleCheck size={14} />{completed}/{orders.length} concluídas</span>
          <progress value={completed} max={orders.length || 1} aria-label="Conclusão das visitas da agenda" />
        </div>
        <div className="text-danger">
          <Clock3 size={16} />
          {orders.filter((o) => operational ? o.late : o.status === "Atrasada").length} {operational ? "agendamentos vencidos na página" : "atrasadas"}
        </div>
      </div>
      <div className={styles.layout}>
        <Panel
          title="Agendamentos e ordens de serviço"
          description={operational ? "Quadro e visitas limitados à página consultada. Use os filtros para consultar o provedor." : "A mesma agenda, organizada para acompanhar cada visita."}
          action={<Badge variant="outline">{operational ? "OS do ERP" : "17 OUT"}</Badge>}
          className={cn("field-agenda", styles.agendaPanel)}
        >
          <Tabs value={view} onValueChange={(value) => setView(String(value))} className={styles.views}>
            <div className={styles.toolbar}>
              <TabsList aria-label="Visualização das ordens de serviço">
                <TabsTrigger value="board"><Columns3 data-icon="inline-start" />Quadro de OS</TabsTrigger>
                <TabsTrigger value="agenda"><List data-icon="inline-start" />Agenda</TabsTrigger>
              </TabsList>
              <div className={styles.agendaSearch}><InputGroup><InputGroupInput aria-label="Buscar ordens de serviço" placeholder="Buscar OS, assinante ou técnico…" value={query} onChange={event => setQuery(event.target.value)} /><InputGroupAddon><Search /></InputGroupAddon></InputGroup></div>
              <span className={styles.selection} aria-live="polite">{rows.length} OS · {technician === "Todos" ? "Todos os técnicos" : technicians.find(tech => tech.value === technician)?.label ?? "Técnico selecionado"}</span>
            </div>
            <div className={styles.filters}>
          <Tabs value={filter} onValueChange={(v) => setFilter(String(v))}>
            <TabsList variant="line">
              {(statusOptions ?? ["Todas", "Agendada", "Em execução", "Atrasada", "Concluída"]).map((v) => (
                <TabsTrigger key={v} value={v}>
                  {v === "Agendada"
                    ? "Agendadas"
                    : v === "Atrasada"
                      ? "Atrasadas"
                      : v === "Concluída"
                        ? "Concluídas"
                        : v}
                  {!operational && <span className={styles.filterCount}>{orders.filter((order) => (v === "Todas" || order.status === v) && (technician === "Todos" || order.technician === technician) && normalize(`${order.name} ${order.code} ${order.type} ${order.technician} ${order.neighborhood}`).includes(normalize(query.trim()))).length}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
            </div>
            {controls}<QueryBoundary loading={loading} error={error}><TabsContent value="board"><FieldOrderBoard orders={rows} onSelect={openOrder} onReset={resetFilters} /></TabsContent>
            <TabsContent value="agenda">
          <div className="field-orders">
            {rows.map((o) => (
              <button
                className="field-order"
                key={o.id}
                onClick={() => openOrder(o)}
              >
                <div className="field-order-time">
                  <strong>{o.time}</strong>
                  <small>{o.duration} min</small>
                  <span />
                </div>
                <div className="field-order-main">
                  <div>
                    <span className="mono subtle">OS #{o.code}</span>
                    <Status value={o.status} />{operational && o.late && <Badge variant="warning">Agendamento vencido</Badge>}
                  </div>
                  <h3>{o.type}</h3>
                  <p>
                    {o.name}
                    <span>·</span>
                    <MapPin size={12} />
                    {o.neighborhood}
                  </p>
                  <div className="field-order-tech">
                    <PersonAvatar name={o.technician} small />
                    {o.technician}
                  </div>
                </div>
                <ArrowUpRight size={17} />
              </button>
            ))}
            {rows.length === 0 && (
              <EmptyState
                icon={CalendarDays}
                title="Nenhuma visita nesta seleção."
                description="Troque o técnico ou o status para consultar a agenda."
              >
                <Button
                  variant="outline"
                  onClick={resetFilters}
                >
                  Ver agenda completa
                </Button>
              </EmptyState>
            )}
          </div>
            </TabsContent>
          </QueryBoundary></Tabs>{pagination}
        </Panel>
        <div className="field-sidebar">
          <Panel
            title="Quem está em campo"
            description={operational ? "Distribuição das visitas nesta página" : "Distribuição das visitas por técnico"}
          >
            <button
              className={cn("technician-row", technician === "Todos" && "technician-selected")}
              aria-pressed={technician === "Todos"}
              onClick={() => changeTechnician("Todos")}
            >
              <span className="summary-icon">
                <UserRound size={18} />
              </span>
              <span>
                <strong>Todos os técnicos</strong>
                <small>{orders.length} visitas na agenda</small>
              </span>
              <ChevronRight size={15} />
            </button>
            {technicians.map((t) => {
              const all = orders.filter((o) => operational ? o.assigneeId === t.value : o.technician === t.value);
              const done = all.filter((o) => o.status === "Concluída").length;
              return (
                <button
                  className={cn("technician-row", technician === t.value && "technician-selected")}
                  aria-pressed={technician === t.value}
                  key={t.value}
                  onClick={() => changeTechnician(t.value)}
                >
                  <PersonAvatar name={t.label} />
                  <span>
                    <strong>{t.label}</strong>
                    <small>
                      {done} de {all.length} visitas concluídas
                    </small>
                    <span className="technician-progress">
                      <i style={{ width: `${(all.length ? done / all.length : 0) * 100}%` }} />
                    </span>
                  </span>
                  <ChevronRight size={15} />
                </button>
              );
            })}
          </Panel>
          <section className="field-context-card">
            <span className="summary-icon">
              <Wrench size={22} />
            </span>
            <h3>Chegue com contexto.</h3>
            <p>
              O técnico e o atendimento olham para a mesma história. Abra a OS
              para consultar assinante, conexão e observações da visita.
            </p>
            <span>
              <CircleCheck size={14} />
              Sem troca de abas. Sem informação perdida.
            </span>
          </section>
        </div>
      </div>
      {!operational && <><DemoNotice>
        Visitas e técnicos fictícios. A agenda não utiliza geolocalização e não
        representa deslocamentos em tempo real.
      </DemoNotice>
      <SourceFooter sample="8 ordens de serviço fictícias" /></>}
      <OrderDetailsDialog order={selected} open={!!selected} onClose={() => setSelected(null)} description={<>Agenda de {scenarioDate(reference, "full")} · demonstração</>}>          {selected && <ServiceOrderDetails
            key={selected.id}
            order={selected}
            subscriber={subscribers.find(subscriber => subscriber.id === selected.subscriberId)}
            provider={provider}
            reference={reference}
            onOpenSubscriber={() => { const id = selected.subscriberId; setSelected(null); openSubscriber(id); }}
          />}</OrderDetailsDialog>
    </>
  );
}

export function OrderDetailsDialog({order,open,onClose,description,children}:{order:WorkOrder|null;open:boolean;onClose:()=>void;description:ReactNode;children:ReactNode}) {
 return <Dialog open={open} onOpenChange={open=>{if(!open)onClose();}}><DialogContent className={cn("order-dialog",styles.dialog,styles.orderDetailsDialog)}><DialogHeader><p className="eyebrow">ORDEM DE SERVIÇO <span className="mono">#{order?.code}</span></p><DialogTitle>{order?.type ?? "Ordem de serviço"}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>{children}</DialogContent></Dialog>;
}
