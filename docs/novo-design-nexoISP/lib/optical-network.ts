import type { Subscriber } from "./types";

export type PonGroup = {
  id: string;
  olt: string;
  slot: string;
  pon: string;
  subscribers: Subscriber[];
};

export function groupOpticalPorts(subscribers: Subscriber[]): PonGroup[] {
  const groups = new Map<string, PonGroup>();
  for (const subscriber of subscribers) {
    const { olt, oltSlot: slot, pon } = subscriber.access ?? {};
    if (!olt || !slot || !pon) continue;
    const id = JSON.stringify([olt, slot, pon]);
    const group = groups.get(id) ?? { id, olt, slot, pon, subscribers: [] };
    group.subscribers.push(subscriber);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => `${a.olt}/${a.slot}/${a.pon}`.localeCompare(`${b.olt}/${b.slot}/${b.pon}`, "pt-BR", { numeric: true }));
}

export function averageOpticalSignal(subscribers: Subscriber[]) {
  const signals = subscribers.filter(s => s.connection === "Online" && s.onu && Number.isFinite(s.signal) && s.signal < 0).map(s => s.signal);
  return signals.length ? signals.reduce((total, signal) => total + signal, 0) / signals.length : null;
}
