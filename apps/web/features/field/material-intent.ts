export type MaterialIntent = {
  intention_id: string;
  item_id: string;
  qty: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function materialIntentKey(scope: string, order: string): string {
  return `nexo:material-intent:v1:${encodeURIComponent(scope)}:${encodeURIComponent(order)}`;
}

export function readMaterialIntent(
  storage: Storage,
  key: string,
): MaterialIntent | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object")
    throw new Error("Intenção de material armazenada inválida.");
  const intent = value as MaterialIntent;
  if (
    !uuid.test(intent.intention_id) ||
    !uuid.test(intent.item_id) ||
    !Number.isInteger(intent.qty) ||
    intent.qty === 0 ||
    Math.abs(intent.qty) > 10000
  )
    throw new Error("Intenção de material armazenada inválida.");
  return {
    intention_id: intent.intention_id,
    item_id: intent.item_id,
    qty: intent.qty,
  };
}

export function saveMaterialIntent(
  storage: Storage,
  key: string,
  intent: MaterialIntent,
): void {
  storage.setItem(key, JSON.stringify(intent));
  const saved = readMaterialIntent(storage, key);
  if (
    !saved ||
    saved.intention_id !== intent.intention_id ||
    saved.item_id !== intent.item_id ||
    saved.qty !== intent.qty
  )
    throw new Error("Não foi possível guardar a intenção de material.");
}

// Web Locks serializes the read/write pair across tabs sharing this namespace.
// Without it, localStorage alone cannot provide an atomic check-and-set.
export async function withMaterialIntentLock<T>(
  locks: LockManager | undefined,
  key: string,
  action: () => T,
): Promise<T> {
  if (!locks)
    throw new Error(
      "Coordenação entre abas indisponível; lançamento não enviado.",
    );
  return locks.request(key, action);
}

export async function acquireMaterialIntent(
  storage: Storage,
  locks: LockManager | undefined,
  key: string,
  create: () => MaterialIntent,
): Promise<MaterialIntent> {
  return withMaterialIntentLock(locks, key, () => {
    const existing = readMaterialIntent(storage, key);
    if (existing) return existing;
    const intent = create();
    saveMaterialIntent(storage, key, intent);
    return intent;
  });
}

export async function settleMaterialIntent(
  storage: Storage,
  locks: LockManager | undefined,
  key: string,
  id: string,
): Promise<MaterialIntent | null> {
  return withMaterialIntentLock(locks, key, () => {
    const current = readMaterialIntent(storage, key);
    if (current?.intention_id === id) {
      storage.removeItem(key);
      return null;
    }
    return current;
  });
}
