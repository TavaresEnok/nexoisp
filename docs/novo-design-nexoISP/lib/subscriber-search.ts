import { normalize } from "../domain/formatters";
import type { Subscriber } from "./types";

export function matchesSubscriber(subscriber: Subscriber, query: string) {
  const term = normalize(query.trim());
  if (!term) return true;
  const values = [subscriber.name, subscriber.code, subscriber.document, subscriber.email, subscriber.phone, subscriber.plan,
    subscriber.contract, subscriber.address, subscriber.neighborhood, subscriber.pop, subscriber.nas, subscriber.onu,
    subscriber.access?.login, subscriber.access?.ip, subscriber.access?.mac];
  if (values.some(value => value && normalize(value).includes(term))) return true;
  const compact = term.replace(/[^a-z0-9]/g, "");
  return compact.length >= 3 && [subscriber.document, subscriber.phone, subscriber.access?.mac, subscriber.onu]
    .some(value => value && normalize(value).replace(/[^a-z0-9]/g, "").includes(compact));
}
