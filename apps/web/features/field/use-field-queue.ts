import { useCallback, useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { useSession } from "@/features/session/provider";
import { sessionScope } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import {
  buildFieldAction,
  discardFieldAction,
  enqueueFieldAction,
  fieldQueueEvent,
  fieldQueueKey,
  flushFieldQueue,
  readFieldQueue,
  type FieldAction,
  type FieldPayload,
  type FlushResult,
} from "./field-queue";

export type SentFieldAction = FieldAction & { sent_at: string };
// Confirmações recentes ficam só na memória desta aba: a fila persistida é limpa no envio.
// Separadas por sessão: troca de usuário na mesma aba não mostra confirmações alheias.
const recentlySent = new Map<string, SentFieldAction[]>();
const sentLimit = 20;

function announce() {
  window.dispatchEvent(new Event(fieldQueueEvent));
}

export function useFieldQueue({ autoFlush = false } = {}) {
  const { me } = useSession();
  const key = me ? fieldQueueKey(sessionScope(me)) : null;
  const { mutate } = useSWRConfig();
  const [items, setItems] = useState<FieldAction[]>([]);
  const [sent, setSent] = useState<SentFieldAction[]>(() =>
    key ? (recentlySent.get(key) ?? []) : [],
  );
  const [storageError, setStorageError] = useState<string | null>(null);
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const running = useRef<Promise<FlushResult | null> | null>(null);

  const load = useCallback(() => {
    setSent(key ? (recentlySent.get(key) ?? []) : []);
    if (!key) return;
    try {
      setItems(readFieldQueue(window.localStorage, key));
      setStorageError(null);
    } catch {
      setStorageError(
        "Não foi possível ler a fila de campo deste aparelho; nenhuma ação guardada será enviada.",
      );
    }
  }, [key]);

  useEffect(() => {
    load();
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) load();
    };
    const network = () => setOnline(navigator.onLine);
    window.addEventListener(fieldQueueEvent, load);
    window.addEventListener("storage", storage);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    return () => {
      window.removeEventListener(fieldQueueEvent, load);
      window.removeEventListener("storage", storage);
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
    };
  }, [key, load]);

  const refreshOrders = useCallback(
    async (actions: FieldAction[]) => {
      const orders = new Set(actions.map((action) => action.order_id));
      await mutate(
        (cacheKey) =>
          Array.isArray(cacheKey) &&
          typeof cacheKey[0] === "string" &&
          (["erp-orders", "erp-agenda"].includes(cacheKey[0]) ||
            (["erp-order", "erp-work-visits"].includes(cacheKey[0]) &&
              orders.has(String(cacheKey[1])))),
      );
    },
    [mutate],
  );

  const flushOnce = useCallback(async (): Promise<FlushResult | null> => {
    if (!key) return null;
    const result = await flushFieldQueue({
      storage: window.localStorage,
      locks: navigator.locks,
      key,
      send: (path, body) => api(path, { body }),
      onChange: announce,
    });
    if (result.sent.length) {
      const stamp = new Date().toISOString();
      recentlySent.set(
        key,
        [
          ...result.sent.map((action) => ({ ...action, sent_at: stamp })),
          ...(recentlySent.get(key) ?? []),
        ].slice(0, sentLimit),
      );
      announce();
      await refreshOrders(result.sent);
    }
    return result;
  }, [key, refreshOrders]);

  // Rodadas pedidas nesta aba entram em sequência; entre abas, o Web Lock serializa.
  const flush = useCallback(async (): Promise<FlushResult | null> => {
    const previous = running.current;
    const next = (async () => {
      if (previous) await previous.catch(() => null);
      return flushOnce();
    })();
    running.current = next;
    try {
      return await next;
    } finally {
      if (running.current === next) running.current = null;
    }
  }, [flushOnce]);

  /**
   * Guarda a ação na fila e tenta enviá-la. Recusa imediata vira erro para o
   * formulário; sem conexão a ação fica pendente e o retorno é "queued".
   */
  const submit = useCallback(
    async (
      order: { id: string; number: number },
      payload: FieldPayload,
    ): Promise<"sent" | "queued"> => {
      if (!key) throw new Error("Sessão indisponível para registrar a ação.");
      const action = buildFieldAction(
        order,
        payload,
        crypto.randomUUID(),
        new Date(),
      );
      await enqueueFieldAction(
        window.localStorage,
        navigator.locks,
        key,
        action,
      );
      announce();
      if (!navigator.onLine) return "queued";
      const result = await flush();
      if (result?.sent.some((item) => item.key === action.key)) return "sent";
      const refused = result?.refused.find((item) => item.key === action.key);
      if (refused) {
        await discardFieldAction(
          window.localStorage,
          navigator.locks,
          key,
          action.key,
        );
        announce();
        throw new Error(refused.reason ?? "Ação recusada pelo servidor.");
      }
      return "queued";
    },
    [key, flush],
  );

  const discard = useCallback(
    async (actionKey: string) => {
      if (!key) return;
      await discardFieldAction(
        window.localStorage,
        navigator.locks,
        key,
        actionKey,
      );
      announce();
    },
    [key],
  );

  const pending = items.some((item) => item.state !== "refused");
  useEffect(() => {
    if (!autoFlush || !online || !pending) return;
    void flush().catch(() => undefined);
    const timer = window.setInterval(
      () => void flush().catch(() => undefined),
      30000,
    );
    return () => window.clearInterval(timer);
  }, [autoFlush, online, pending, flush]);

  return {
    ready: Boolean(key),
    items,
    sent,
    online,
    storageError,
    submit,
    flush,
    discard,
  };
}
