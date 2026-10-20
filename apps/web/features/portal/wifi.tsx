import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { Panel } from "@/components/workspace-ui";
import { Button } from "@/components/ui/button";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
import { notifyAcs } from "@/features/network/acs-notice";
const wifi = z.object({ index: z.string(), ssid: z.string().nullable() });
const cpe = z.object({
  contract_id: z.string(),
  wifi: z.array(wifi),
  last_inform: z.string().optional(),
});
export function PortalWifi({ standalone }: { standalone?: boolean } = {}) {
  const result = useSWR("portal-cpe", async () =>
    z.array(cpe).parse(await api("/portal/cpe")),
  );
  const [editing, setEditing] = useState<{
    contract: string;
    index: string;
    ssid: string;
  } | null>(null);
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      {(standalone ||
        Boolean(result.data?.some((item) => item.wifi.length))) && (
        <Panel
          title="Meu Wi-Fi"
          description="Alterações podem ser aplicadas imediatamente ou ficar na fila até o roteador contatar o servidor."
        >
          {!result.data?.some((item) => item.wifi.length) && (
            <p>
              Nenhum roteador com Wi-Fi gerenciável vinculado aos seus planos.
            </p>
          )}
          <div className="erp-stack">
            {result.data?.flatMap((item) =>
              item.wifi.map((network) => (
                <div
                  className="erp-contract-card"
                  key={`${item.contract_id}:${network.index}`}
                >
                  <header>
                    <strong>{network.ssid ?? "Rede sem nome informado"}</strong>
                  </header>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setEditing({
                        contract: item.contract_id,
                        index: network.index,
                        ssid: network.ssid ?? "",
                      })
                    }
                  >
                    Alterar Wi-Fi {network.index}
                  </Button>
                </div>
              )),
            )}
          </div>
        </Panel>
      )}
      {editing && (
        <RecordEditor
          title="Alterar meu Wi-Fi"
          description="Use caracteres comuns, sem acento. Deixar a senha vazia mantém a senha atual. Seus aparelhos precisarão da nova senha para reconectar."
          initial={{ ssid: editing.ssid, password: "" }}
          fields={[
            { key: "ssid", label: "Nome da minha rede", maxLength: 32 },
            {
              key: "password",
              label: "Nova senha do meu Wi-Fi",
              type: "password",
              maxLength: 63,
              hint: "De 8 a 63 caracteres, ou vazio para manter.",
            },
          ]}
          onClose={() => setEditing(null)}
          submit="Salvar no roteador"
          onSubmit={async (values) => {
            if (values.password && values.password.length < 8)
              throw new Error(
                "A senha precisa ter pelo menos oito caracteres.",
              );
            if (!values.ssid && !values.password)
              throw new Error("Informe um nome ou uma nova senha.");
            const response = await api<{ note?: string; result?: string }>(
              `/portal/cpe/${editing.contract}/wifi`,
              {
                body: {
                  index: editing.index,
                  ...(values.ssid ? { ssid: values.ssid } : {}),
                  ...(values.password ? { password: values.password } : {}),
                },
              },
            );
            notifyAcs(response);
            setEditing(null);
            await result.mutate();
          }}
        />
      )}
    </QueryBoundary>
  );
}
