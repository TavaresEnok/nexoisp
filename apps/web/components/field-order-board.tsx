"use client";

import { ArrowUpRight, CalendarDays, Clock3, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/workspace-feedback";
import { PersonAvatar, Status } from "@/components/workspace-ui";
import type { WorkOrder } from "@/lib/types";
import styles from "./operations.module.css";

const columns = [
  { status: "Atrasada", title: "Atrasadas", tone: "danger" },
  { status: "Em execução", title: "Em execução", tone: "info" },
  { status: "Agendada", title: "Agendadas", tone: "neutral" },
  { status: "Concluída", title: "Concluídas", tone: "success" },
];

export function FieldOrderBoard({
  orders,
  onSelect,
  onReset,
}: {
  orders: WorkOrder[];
  onSelect: (order: WorkOrder) => void;
  onReset: () => void;
}) {
  if (orders.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="Nenhuma visita nesta seleção."
        description="Troque o técnico ou o status para consultar a agenda."
      >
        <Button variant="outline" onClick={onReset}>Ver agenda completa</Button>
      </EmptyState>
    );
  }

  const otherStatuses = [...new Set(orders.map((order) => order.status))]
    .filter((status) => !columns.some((column) => column.status === status));
  const visibleColumns = [
    ...columns,
    ...otherStatuses.map((status) => ({ status, title: status, tone: "neutral" })),
  ];

  return (
    <div className={styles.boardScroll} role="region" aria-label="Quadro de ordens por status" tabIndex={0}>
      <div className={styles.board}>
        {visibleColumns.map((column) => {
          const items = orders.filter((order) => order.status === column.status);
          return (
            <section className={styles.column} data-tone={column.tone} key={column.status} aria-label={`${column.title}: ${items.length} ordens`}>
              <header className={styles.columnHeader}>
                <span className={styles.columnDot} aria-hidden="true" />
                <h3>{column.title}</h3>
                <Badge variant="secondary">{items.length}</Badge>
              </header>
              {items.length === 0 ? (
                <p className={styles.columnEmpty}>Nenhuma OS nesta seleção</p>
              ) : (
                <ul className={styles.orderList}>
                  {items.map((order) => (
                    <li key={order.id}>
                      <button
                        type="button"
                        className={styles.orderCard}
                        onClick={() => onSelect(order)}
                        aria-label={`Ver OS ${order.code}, ${order.type}, ${order.name}`}
                      >
                        <span className={styles.orderTop}>
                          <span className={styles.orderTime}><Clock3 size={12} aria-hidden="true" />{order.time}</span>
                          <span className={styles.orderCode}>#{order.code}</span>
                        </span>
                        <span className={styles.orderTitle}>{order.type}</span>
                        <span className={styles.orderName}>{order.name}</span>
                        <span className={styles.orderLocation}><MapPin size={12} aria-hidden="true" />{order.neighborhood}</span>
                        <Status value={order.status} />{order.late && <Badge variant="warning">Agendamento vencido</Badge>}
                        <span className={styles.orderBottom}>
                          <PersonAvatar name={order.technician} small />
                          <span>{order.technician}</span>
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
