import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { ProfileFacts } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { QueryBoundary } from "@/features/shared/feedback";
import { RecordEditor } from "@/features/shared/record-editor";
import { useSession } from "@/features/session/provider";
import { api } from "@/platform/erp-client";
import { notifyAcs } from "./acs-notice";
import {
  cpeIntentKey,
  readCpeIntent,
  sendCpeIntent,
  type CpeIntent,
} from "./cpe-intent";
const schema = z.array(
  z.object({
    id: z.string().uuid(),
    intent_id: z.string().uuid(),
    kind: z.enum(["wifi", "refresh", "reboot"]),
    state: z.enum([
      "prepared",
      "uncertain",
      "queued",
      "observed",
      "review",
      "rejected",
    ]),
    remote_task_id: z.string().nullable(),
    last_error: z.string().nullable(),
    created_at: z.string(),
  }),
);
const states: Record<string, string> = {
  prepared: "Preparada · aguardando processamento",
  uncertain: "Resultado desconhecido · somente consulta",
  queued: "Aceita pelo ACS · aguardando confirmação por leitura",
  observed: "Alteração observada por leitura",
  review: "Revisão necessária",
  rejected: "Recusada",
};
const errors: Record<string, string> = {
  acs_unavailable: "Não foi possível consultar o servidor de gerência",
  acs_review: "Confira a propriedade do roteador e a instância de gerência",
  acs_task_fault: "O servidor de gerência registrou uma falha na tarefa",
};
const kinds: Record<string, string> = {
  wifi: "Alterar Wi-Fi",
  refresh: "Atualizar leitura",
  reboot: "Reiniciar roteador",
};
export function useCpeCommands(
  contract: string,
  portal = false,
  enabled = true,
) {
  const { me } = useSession();
  const { mutate } = useSWRConfig();
  const base = portal
    ? `/portal/cpe/${contract}`
    : `/contracts/${contract}/cpe`;
  const key = cpeIntentKey(me?.tenant?.id ?? "", me?.id ?? "", contract);
  const tasks = useSWR(
    enabled ? ["cpe-tasks", base] : null,
    async () => schema.parse(await api(`${base}/tasks`)),
    { refreshInterval: 15000 },
  );
  const observed = tasks.data?.find((task) => task.state === "observed")?.id;
  useEffect(() => {
    if (observed) {
      void mutate(["erp-cpe", contract]);
      void mutate("portal-cpe");
    }
  }, [observed, contract, mutate]);
  const [pending, setPending] = useState<CpeIntent | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const reload = () => {
    try {
      setPending(readCpeIntent(localStorage, key));
      setStorageError(null);
    } catch (e) {
      setStorageError((e as Error).message);
    }
  };
  useEffect(() => {
    reload();
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) reload();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);
  useEffect(() => {
    if (
      !pending ||
      !navigator.locks ||
      !tasks.data?.some(
        (t) =>
          t.intent_id === pending.intent_id &&
          ["observed", "rejected"].includes(t.state),
      )
    )
      return;
    void navigator.locks.request(key, () => {
      try {
        const current = readCpeIntent(localStorage, key);
        if (
          current &&
          tasks.data?.some(
            (t) =>
              t.intent_id === current.intent_id &&
              ["observed", "rejected"].includes(t.state),
          )
        )
          localStorage.removeItem(key);
        reload();
      } catch (e) {
        setStorageError((e as Error).message);
      }
    });
  }, [pending, tasks.data, key]);
  const send = async (
    kind: CpeIntent["kind"],
    body: Record<string, unknown> = {},
  ) => {
    if (!navigator.locks)
      throw Error(
        "Use navegador atualizado para proteger a intenção entre abas.",
      );
    try {
      const response = await navigator.locks.request(key, () =>
        sendCpeIntent(localStorage, key, kind, body, (b) =>
          api<{ result?: string; note?: string }>(`${base}/${kind}`, {
            body: b,
          }),
        ),
      );
      notifyAcs(response as { result?: string; note?: string });
      await tasks.mutate();
      return response;
    } finally {
      reload();
    }
  };
  return {
    base,
    tasks,
    pending,
    storageError,
    send,
    blocked:
      Boolean(storageError) ||
      Boolean(
        tasks.data?.some((t) => !["observed", "rejected"].includes(t.state)),
      ),
  };
}
export function CpeTasks({
  commands,
  writable,
}: {
  commands: ReturnType<typeof useCpeCommands>;
  writable: boolean;
}) {
  const [retry, setRetry] = useState<string | null>(null);
  return (
    <div className="erp-stack">
      <QueryBoundary
        loading={commands.tasks.isLoading}
        error={commands.tasks.error}
        retry={() => commands.tasks.mutate()}
      >
        {commands.storageError && <p role="alert">{commands.storageError}</p>}
        {commands.pending && (
          <p role="status">
            Intenção preservada: {kinds[commands.pending.kind]} ·{" "}
            {commands.pending.intent_id}. Uma resposta perdida não autoriza
            outra solicitação.
          </p>
        )}
        {commands.tasks.data?.map((task) => (
          <div className="erp-contract-card" key={task.id}>
            <ProfileFacts
              items={[
                ["Solicitação", kinds[task.kind]],
                ["Estado", states[task.state]],
                ["Tarefa no ACS", task.remote_task_id ?? "Não confirmada"],
                ["Intenção", task.intent_id],
              ]}
            />
            {task.last_error && (
              <p role="status">
                Pendência:{" "}
                {errors[task.last_error] ?? "Consulta não confirmada"}. O
                comando não será reenviado automaticamente.
              </p>
            )}
            {writable &&
              ["uncertain", "queued", "review"].includes(task.state) && (
                <Button variant="outline" onClick={() => setRetry(task.id)}>
                  Reagendar consulta da tarefa
                </Button>
              )}
          </div>
        ))}
      </QueryBoundary>
      {retry && (
        <RecordEditor
          title="Consultar tarefa CPE"
          description="Somente consulta a tarefa e o readback. Não recria nem reenvia o comando."
          initial={{ reason: "" }}
          fields={[
            {
              key: "reason",
              label: "Justificativa (10 a 500 caracteres)",
              required: true,
              maxLength: 500,
            },
          ]}
          onClose={() => setRetry(null)}
          submit="Reagendar consulta"
          onSubmit={async (values) => {
            await api(`${commands.base}/tasks/${retry}/retry-lookup`, {
              body: values,
            });
            setRetry(null);
            await commands.tasks.mutate();
          }}
        />
      )}
    </div>
  );
}
