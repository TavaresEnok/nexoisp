import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { toast } from "sonner";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { RecordEditor } from "@/features/shared/record-editor";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { stamp } from "./models";
import { duration } from "./telemetry";
import { notifyAcs } from "./acs-notice";
export const cpeDeviceSchema = z.object({
  id: z.string(),
  manufacturer: z.string().nullable(),
  product: z.string().nullable().optional(),
  serial: z.string().nullable(),
  firmware: z.string().nullable(),
  last_inform: z.string().nullable(),
  uptime_s: z.number().nullable(),
  wan: z.object({ ip: z.string().nullable(), status: z.string().nullable() }),
  ppp_usernames: z.array(z.string()),
  wifi: z.array(
    z.object({
      index: z.string(),
      ssid: z.string().nullable(),
      enabled: z.boolean().nullable(),
    }),
  ),
});
const cpeSchema = z.object({
  enabled: z.boolean(),
  linked: z.boolean(),
  device: cpeDeviceSchema.nullable().optional(),
});
const acsStatusSchema = z.object({
  enabled: z.boolean(),
  public_url: z.string().nullable(),
});
const candidatesSchema = z.array(
  z.object({
    id: z.string(),
    manufacturer: z.string().nullable(),
    product: z.string().nullable().optional(),
    serial: z.string().nullable(),
    matched_by: z.string(),
    last_inform: z.string().nullable(),
  }),
);
export function ContractCpe({ id }: { id: string }) {
  const { me } = useSession();
  const operate = can(me, "network:operate");
  const path = `/contracts/${id}/cpe`;
  const result = useSWR(["erp-cpe", id], async () =>
    cpeSchema.parse(await api(path)),
  );
  const [serial, setSerial] = useState("");
  const [candidates, setCandidates] = useState<z.infer<
    typeof candidatesSchema
  > | null>(null);
  const [wifi, setWifi] = useState<{ index: string; ssid: string } | null>(
    null,
  );
  const unlinked = result.data?.enabled && !result.data.linked;
  const acs = useSWR(unlinked ? "erp-acs-status" : null, async () =>
    acsStatusSchema.parse(await api("/acs/status")),
  );
  const d = result.data?.device;
  const action = async (kind: string) => {
    const response = await api<{ note?: string; result?: string }>(
      `${path}/${kind}`,
      { method: "POST" },
    );
    notifyAcs(response);
    await result.mutate();
  };
  return (
    <ProfileSection
      title="Roteador do assinante · TR-069"
      caption="Gerência pelo servidor ACS configurado nesta instalação."
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data && !result.data.enabled ? (
          <p className="profile-footnote">
            Gerência TR-069 não habilitada nesta instalação.
          </p>
        ) : (
          result.data && (
            <>
              {!result.data.linked && (
                <>
                  <p className="profile-footnote">
                    Nenhum roteador vinculado. Procure pela conta PPPoE do
                    contrato ou pelo número de série da etiqueta.
                  </p>
                  {acs.data?.public_url && (
                    <ProfileFacts
                      items={[
                        [
                          "Endereço de gerência para o roteador",
                          <code key="acs" className="mono">
                            {acs.data.public_url}
                          </code>,
                        ],
                      ]}
                    />
                  )}
                  {operate && (
                    <>
                      <FormField
                        label="Número de série do roteador"
                        hint="Opcional. Em branco, pesquisa pela conta de acesso do contrato."
                      >
                        <Input
                          maxLength={64}
                          value={serial}
                          onChange={(event) => {
                            setSerial(event.target.value);
                            setCandidates(null);
                          }}
                        />
                      </FormField>
                      <ActionButton
                        onClick={async () =>
                          setCandidates(
                            candidatesSchema.parse(
                              await api(
                                `${path}/candidates${serial.trim() ? `?serial=${encodeURIComponent(serial.trim())}` : ""}`,
                              ),
                            ),
                          )
                        }
                      >
                        Procurar roteador
                      </ActionButton>
                      {candidates && candidates.length === 0 && (
                        <p role="status">
                          Nenhum roteador encontrado. O equipamento precisa ter
                          contatado o servidor de gerência.
                        </p>
                      )}
                      {candidates?.map((candidate) => (
                        <div className="erp-contract-card" key={candidate.id}>
                          <strong>
                            {[candidate.manufacturer, candidate.product]
                              .filter(Boolean)
                              .join(" ") || "Roteador"}
                          </strong>
                          <p className="profile-footnote">
                            Série {candidate.serial || "não informada"} ·{" "}
                            {candidate.matched_by === "pppoe"
                              ? "Informa a conta deste contrato"
                              : "Número de série"}{" "}
                            · contato {stamp(candidate.last_inform)}
                          </p>
                          <ActionButton
                            onClick={async () => {
                              await api(`${path}/link`, {
                                body: {
                                  acs_device_id: candidate.id,
                                  ...(serial.trim()
                                    ? { serial: serial.trim() }
                                    : {}),
                                },
                              });
                              setCandidates(null);
                              await result.mutate();
                            }}
                          >
                            Vincular roteador
                          </ActionButton>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
              {result.data.linked && (
                <>
                  {!d && (
                    <p role="alert">
                      O roteador vinculado não foi encontrado no servidor de
                      gerência.
                    </p>
                  )}
                  {d && (
                    <>
                      <ProfileFacts
                        items={[
                          [
                            "Roteador",
                            [d.manufacturer, d.product]
                              .filter(Boolean)
                              .join(" ") || "Não informado",
                          ],
                          ["Série", d.serial || "Não informada"],
                          ["Firmware", d.firmware || "Não informado"],
                          ["Último contato", stamp(d.last_inform)],
                          [
                            "Tempo ligado",
                            d.uptime_s == null
                              ? "Não informado"
                              : duration(d.uptime_s),
                          ],
                          ["IP WAN", d.wan.ip || "Não informado"],
                          ["Estado WAN", d.wan.status || "Não informado"],
                          [
                            "Contas PPPoE",
                            d.ppp_usernames.join(", ") || "Não informadas",
                          ],
                        ]}
                      />
                      {d.last_inform &&
                        Date.now() - Date.parse(d.last_inform) > 900000 && (
                          <Badge variant="warning">
                            Último contato há mais de quinze minutos
                          </Badge>
                        )}
                      {d.wifi.map((w) => (
                        <div className="erp-contract-card" key={w.index}>
                          <header>
                            <strong>
                              Wi-Fi {w.index} · {w.ssid || "Nome não informado"}
                            </strong>
                            {w.enabled === false && (
                              <Badge variant="outline">Desligado</Badge>
                            )}
                          </header>
                          {operate && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setWifi({ index: w.index, ssid: w.ssid ?? "" })
                              }
                            >
                              Alterar Wi-Fi {w.index}
                            </Button>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                  {operate && (
                    <div className="erp-inline-actions">
                      <ActionButton onClick={() => action("refresh")}>
                        Reler roteador
                      </ActionButton>
                      <ActionButton
                        confirm="Reiniciar o roteador do assinante? A conexão poderá cair por alguns minutos."
                        onClick={() => action("reboot")}
                      >
                        Reiniciar roteador
                      </ActionButton>
                      <ActionButton
                        danger
                        confirm="Desvincular este roteador do contrato?"
                        onClick={async () => {
                          await api(`${path}/link`, { method: "DELETE" });
                          setCandidates(null);
                          await result.mutate();
                        }}
                      >
                        Desvincular roteador
                      </ActionButton>
                    </div>
                  )}
                </>
              )}
            </>
          )
        )}
      </QueryBoundary>
      {wifi && (
        <RecordEditor
          title="Alterar Wi-Fi do assinante"
          description="Aparelhos conectados precisarão da nova senha. Em branco, a senha atual será mantida. O servidor informa se a alteração foi aplicada ou ficou na fila."
          initial={{ ssid: wifi.ssid, password: "" }}
          fields={[
            { key: "ssid", label: "Nome da rede Wi-Fi", maxLength: 32 },
            {
              key: "password",
              label: "Nova senha Wi-Fi",
              type: "password",
              maxLength: 63,
              hint: "De oito a 63 caracteres comuns, sem acento. Em branco, mantém a atual.",
            },
          ]}
          submit="Solicitar alteração Wi-Fi"
          onClose={() => setWifi(null)}
          onSubmit={async (values) => {
            if (values.password && values.password.length < 8)
              throw new Error("A senha deve ter pelo menos oito caracteres.");
            const response = await api<{ note?: string; result?: string }>(
              `${path}/wifi`,
              {
                body: {
                  index: wifi.index,
                  ...(values.ssid ? { ssid: values.ssid } : {}),
                  ...(values.password ? { password: values.password } : {}),
                },
              },
            );
            notifyAcs(response);
            setWifi(null);
            await result.mutate();
          }}
        />
      )}
    </ProfileSection>
  );
}
