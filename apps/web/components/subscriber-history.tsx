import type { ReactNode } from "react";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { getSubscriberHistory } from "@/lib/subscriber-history";
import { date, clock } from "@/lib/format";
import type { Subscriber, WorkspaceData } from "@/lib/types";

export function SubscriberHistory({ subscriber, data }: { subscriber: Subscriber; data: WorkspaceData }) {
  const { dated, undatedOrders } = getSubscriberHistory(subscriber, data);
  return <div className="flex flex-col gap-6"><ProfileSection title="Histórico e marcos do assinante" caption="Do dia mais recente ao mais antigo. Vencimentos são marcos previstos, não eventos de pagamento. Atividades usam o dia de referência do cenário; datas sem horário não têm ordem intradiária comprovada."><HistoryTimeline entries={dated.map(entry => ({ id: entry.id, title: entry.title, description: entry.description, at: entry.at, instant: entry.precision === "instant" }))} /></ProfileSection>{undatedOrders.length > 0 && <ProfileSection title="Ordens sem data registrada" caption="Exibidas separadamente: o horário sozinho não permite posicionar uma OS no histórico."><div className="history-timeline">{undatedOrders.map(order => <div key={order.id}><span className="timeline-dot" /><div><strong>OS #{order.code} · {order.status}</strong><p>{order.type} · {order.technician}</p><small>Horário registrado: {order.time} · {order.notes}</small></div></div>)}</div></ProfileSection>}</div>;
}

export type HistoryEntry = { id: string; title: string; description?: string; at: string; instant: boolean; meta?: string; action?: ReactNode };
export function HistoryTimeline({ entries }: { entries: HistoryEntry[] }) {
  return <div className="history-timeline">{entries.map(entry => <div key={entry.id}><span className="timeline-dot" /><div><strong>{entry.title}</strong><p>{entry.description}</p><small><time dateTime={entry.at}>{date(entry.at)}{entry.instant ? ` · ${clock(entry.at)}` : " · horário não informado"}</time>{entry.meta}</small>{entry.action}</div></div>)}</div>;
}
