/** Persist only identity/kind. Wi-Fi passwords never enter browser storage. */
export type CpeIntent = {
  intent_id: string;
  kind: "wifi" | "refresh" | "reboot";
};
export function cpeIntentKey(tenant: string, actor: string, contract: string) {
  return `nexo:cpe-intent:v1:${tenant}:${actor}:${contract}`;
}
export function readCpeIntent(storage: Storage, key: string): CpeIntent | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as CpeIntent;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.intent_id,
    ) ||
    !["wifi", "refresh", "reboot"].includes(value.kind)
  )
    throw Error(
      "Intenção CPE inválida; confira o histórico antes de continuar.",
    );
  return value;
}
export async function sendCpeIntent(
  storage: Storage,
  key: string,
  kind: CpeIntent["kind"],
  body: Record<string, unknown>,
  send: (body: Record<string, unknown>) => Promise<unknown>,
) {
  const prior = readCpeIntent(storage, key);
  if (prior && prior.kind !== kind)
    throw Error(
      "Há outra intenção CPE pendente. Consulte o histórico antes de nova operação.",
    );
  const intent = prior ?? { intent_id: crypto.randomUUID(), kind };
  storage.setItem(key, JSON.stringify(intent));
  try {
    return await send({ ...body, intent_id: intent.intent_id });
  } catch (error) {
    if ([400, 422].includes((error as { status?: number }).status ?? 0))
      storage.removeItem(key);
    throw error;
  }
}
