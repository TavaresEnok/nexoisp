// Fila local das ações de campo feitas sem conexão. Cada ação leva uma chave de
// idempotência gerada no aparelho: o servidor devolve o mesmo resultado se ela
// chegar duas vezes e recusa a mesma chave com outro conteúdo. A fila guarda só
// a ação pendente (caminho, corpo e estado) e remove cada item após a confirmação.
export type FieldActionKind =
  | "check_in"
  | "check_out"
  | "note"
  | "checklist_add"
  | "checklist_done";
export type FieldActionState = "pending" | "sending" | "refused";
export type FieldAction = {
  key: string;
  kind: FieldActionKind;
  order_id: string;
  order_number: number;
  path: string;
  body: Record<string, unknown>;
  queued_at: string;
  state: FieldActionState;
  reason?: string;
};
export type FieldPayload =
  | { kind: "check_in" | "check_out"; location?: FieldLocation | null }
  | { kind: "note"; note: string }
  | { kind: "checklist_add"; label: string }
  | { kind: "checklist_done"; item_id: string; done: boolean };
export type FieldLocation = {
  latitude: number;
  longitude: number;
  accuracy_m?: number;
};
export type FlushResult = {
  sent: FieldAction[];
  refused: FieldAction[];
  pending: number;
  /** Falha transitória (sem conexão, sessão em troca, servidor indisponível): nada foi recusado. */
  interrupted: boolean;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kinds: FieldActionKind[] = [
  "check_in",
  "check_out",
  "note",
  "checklist_add",
  "checklist_done",
];
const states: FieldActionState[] = ["pending", "sending", "refused"];
export const fieldQueueLimit = 200;
export const fieldQueueEvent = "nexo:field-queue";

export function fieldQueueKey(scope: string): string {
  return `nexo:field-queue:v1:${encodeURIComponent(scope)}`;
}

export const fieldActionLabels: Record<FieldActionKind, string> = {
  check_in: "Check-in",
  check_out: "Check-out",
  note: "Anotação",
  checklist_add: "Item de checklist",
  checklist_done: "Checklist",
};

function finite(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

/** Monta o caminho e o corpo exatos que o servidor recebe, com chave e horário do aparelho. */
export function buildFieldAction(
  order: { id: string; number: number },
  payload: FieldPayload,
  key: string,
  now: Date,
): FieldAction {
  if (!uuid.test(order.id) || !uuid.test(key))
    throw new Error("Identificador da ação de campo inválido.");
  const base = `/work-orders/${encodeURIComponent(order.id)}`;
  const common = { idempotency_key: key, device_at: now.toISOString() };
  let path: string;
  let body: Record<string, unknown>;
  switch (payload.kind) {
    case "check_in":
    case "check_out": {
      path = `${base}/${payload.kind === "check_in" ? "check-in" : "check-out"}`;
      body = { ...common };
      const location = payload.location;
      if (location) {
        if (
          !finite(location.latitude, -90, 90) ||
          !finite(location.longitude, -180, 180) ||
          (location.accuracy_m !== undefined &&
            !finite(location.accuracy_m, 0, 100000))
        )
          throw new Error("Localização do aparelho inválida.");
        body.latitude = location.latitude;
        body.longitude = location.longitude;
        if (location.accuracy_m !== undefined)
          body.accuracy_m = Math.round(location.accuracy_m * 10) / 10;
      }
      break;
    }
    case "note": {
      const note = payload.note.trim();
      if (!note || note.length > 2000)
        throw new Error("A anotação deve ter de 1 a 2000 caracteres.");
      path = `${base}/notes`;
      body = { note, ...common };
      break;
    }
    case "checklist_add": {
      const label = payload.label.trim();
      if (label.length < 2 || label.length > 160)
        throw new Error("O item do checklist deve ter de 2 a 160 caracteres.");
      path = `${base}/checklist`;
      body = { items: [label], ...common };
      break;
    }
    case "checklist_done": {
      if (!/^[0-9a-z-]{1,64}$/i.test(payload.item_id))
        throw new Error("Item do checklist inválido.");
      path = `${base}/checklist/${encodeURIComponent(payload.item_id)}`;
      body = { done: payload.done, ...common };
      break;
    }
  }
  return {
    key,
    kind: payload.kind,
    order_id: order.id,
    order_number: order.number,
    path,
    body,
    queued_at: now.toISOString(),
    state: "pending",
  };
}

function valid(value: unknown): value is FieldAction {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<FieldAction>;
  return (
    typeof item.key === "string" &&
    uuid.test(item.key) &&
    typeof item.order_id === "string" &&
    uuid.test(item.order_id) &&
    typeof item.order_number === "number" &&
    Number.isInteger(item.order_number) &&
    kinds.includes(item.kind as FieldActionKind) &&
    states.includes(item.state as FieldActionState) &&
    typeof item.path === "string" &&
    item.path.startsWith(`/work-orders/${item.order_id}/`) &&
    !/[\r\n]/.test(item.path) &&
    !!item.body &&
    typeof item.body === "object" &&
    !Array.isArray(item.body) &&
    (item.body as Record<string, unknown>).idempotency_key === item.key &&
    typeof item.queued_at === "string" &&
    !Number.isNaN(Date.parse(item.queued_at)) &&
    (item.reason === undefined || typeof item.reason === "string")
  );
}

export function readFieldQueue(storage: Storage, key: string): FieldAction[] {
  const raw = storage.getItem(key);
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every(valid))
    throw new Error("Fila de campo armazenada inválida.");
  return value;
}

export function writeFieldQueue(
  storage: Storage,
  key: string,
  items: FieldAction[],
): void {
  if (!items.length) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify(items));
  if (readFieldQueue(storage, key).length !== items.length)
    throw new Error("Não foi possível guardar a fila de campo.");
}

// Web Locks serializa leitura, envio e escrita entre abas do mesmo usuário.
export async function withFieldQueueLock<T>(
  locks: LockManager | undefined,
  key: string,
  action: () => Promise<T> | T,
): Promise<T> {
  if (!locks)
    throw new Error(
      "Coordenação entre abas indisponível; a ação de campo não foi guardada.",
    );
  return locks.request(key, () => action());
}

export async function enqueueFieldAction(
  storage: Storage,
  locks: LockManager | undefined,
  key: string,
  action: FieldAction,
): Promise<FieldAction[]> {
  return withFieldQueueLock(locks, key, () => {
    const items = readFieldQueue(storage, key);
    if (items.some((item) => item.key === action.key)) return items;
    if (items.length >= fieldQueueLimit)
      throw new Error(
        "Fila de campo cheia: envie as ações pendentes antes de registrar outras.",
      );
    const next = [...items, action];
    writeFieldQueue(storage, key, next);
    return next;
  });
}

export async function discardFieldAction(
  storage: Storage,
  locks: LockManager | undefined,
  key: string,
  actionKey: string,
): Promise<FieldAction[]> {
  return withFieldQueueLock(locks, key, () => {
    const next = readFieldQueue(storage, key).filter(
      (item) => item.key !== actionKey,
    );
    writeFieldQueue(storage, key, next);
    return next;
  });
}

/** Sem resposta definitiva do servidor: a ação continua pendente para nova tentativa. */
export function transientFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number") return true;
  if (status === 0 || status === 408 || status === 425 || status === 429)
    return true;
  if (status >= 500) return true;
  // O cliente devolve 409 com esta mensagem quando a sessão muda ou expira.
  return status === 409 && /sessão mudou/i.test(error.message);
}

/**
 * Envia as ações em ordem de registro. Uma recusa definitiva fica marcada com o
 * motivo e o envio segue para as demais; uma falha transitória interrompe a rodada.
 */
export async function flushFieldQueue(options: {
  storage: Storage;
  locks: LockManager | undefined;
  key: string;
  send: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  onChange?: (items: FieldAction[]) => void;
}): Promise<FlushResult> {
  const { storage, locks, key, send, onChange } = options;
  return withFieldQueueLock(locks, key, async () => {
    let items = readFieldQueue(storage, key);
    const sent: FieldAction[] = [];
    const refused: FieldAction[] = [];
    let interrupted = false;
    const save = (next: FieldAction[]) => {
      items = next;
      writeFieldQueue(storage, key, items);
      onChange?.(items);
    };
    // "Enviando" deixado por uma aba encerrada no meio do envio volta a ser reenviado:
    // a chave de idempotência impede efeito duplicado.
    for (const action of items.filter((item) => item.state !== "refused")) {
      save(
        items.map((item) =>
          item.key === action.key ? { ...item, state: "sending" } : item,
        ),
      );
      try {
        await send(action.path, action.body);
        sent.push(action);
        save(items.filter((item) => item.key !== action.key));
      } catch (error) {
        if (transientFailure(error)) {
          interrupted = true;
          save(
            items.map((item) =>
              item.key === action.key ? { ...item, state: "pending" } : item,
            ),
          );
          break;
        }
        const reason =
          error instanceof Error && error.message
            ? error.message.slice(0, 300)
            : "Recusado pelo servidor.";
        const marked: FieldAction = { ...action, state: "refused", reason };
        refused.push(marked);
        save(items.map((item) => (item.key === action.key ? marked : item)));
      }
    }
    return {
      sent,
      refused,
      pending: items.filter((item) => item.state !== "refused").length,
      interrupted,
    };
  });
}

/** Estado efetivo de presença considerando as ações ainda na fila. */
export function pendingPresence(items: FieldAction[], orderId: string) {
  let checkIn = false;
  let checkOut = false;
  for (const item of items) {
    if (item.order_id !== orderId || item.state === "refused") continue;
    if (item.kind === "check_in") {
      checkIn = true;
      checkOut = false;
    }
    if (item.kind === "check_out") checkOut = true;
  }
  return { checkIn, checkOut };
}
