import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { api } from "@/platform/erp-client";
import { stamp, type Device } from "./models";

// Equipamentos cujo backup o agente sabe fazer (o RADIUS integrado não tem equipamento a consultar).
export const configBackupDrivers = [
  "olt_huawei",
  "olt_zte",
  "olt_datacom",
  "mikrotik_radius",
  "olt_demo",
  "demo",
];

const copySchema = z.object({
  id: z.string().uuid(),
  device_id: z.string().uuid(),
  taken_at: z.string(),
  trigger: z.enum(["scheduled", "manual"]),
  size_bytes: z.number(),
  lines: z.number(),
  sha256: z.string(),
  changed: z.boolean().nullable(),
});
const listSchema = z.object({
  device: z.object({
    config_backup: z.boolean(),
    config_backup_requested_at: z.string().nullable(),
    config_backup_error: z.string().nullable(),
    config_backup_error_at: z.string().nullable(),
    next_due_at: z.string().nullable(),
    supported: z.boolean(),
  }),
  items: z.array(copySchema),
  keep: z.number(),
  interval_days: z.number(),
});
const contentSchema = copySchema.extend({
  device_name: z.string(),
  content: z.string(),
});
const diffSchema = z.object({
  backup: copySchema,
  previous: copySchema,
  lines: z.array(
    z.object({
      op: z.enum([" ", "-", "+", "@"]),
      old: z.number().optional(),
      new: z.number().optional(),
      text: z.string(),
    }),
  ),
  added: z.number(),
  removed: z.number(),
  truncated: z.boolean(),
});
type Copy = z.infer<typeof copySchema>;

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function fileName(device: string, takenAt: string) {
  const day = new Date(takenAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `${device.replace(/[^A-Za-z0-9_.-]+/g, "_")}-${day}.txt`;
}
function save(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DeviceConfigBackups({
  device,
  writable,
}: {
  device: Device;
  writable: boolean;
}) {
  const key = `/devices/${device.id}/config-backups`;
  const result = useSWR(["erp-config-backups", key], async () =>
    listSchema.parse(await api(key)),
  );
  const [viewing, setViewing] = useState<Copy | null>(null);
  const [comparing, setComparing] = useState<Copy | null>(null);
  const data = result.data;
  const items = data?.items ?? [];
  const status = !data
    ? ""
    : !data.device.config_backup
      ? "Desligado neste equipamento"
      : !device.agent_id
        ? "Sem agente local: o backup é feito pelo agente"
        : data.device.config_backup_requested_at
          ? `Pedido em ${stamp(data.device.config_backup_requested_at)} · aguardando o agente`
          : `A cada ${data.interval_days} dias`;
  return (
    <ProfileSection
      title="Backup de configuração"
      caption={`Feito pelo agente local, uma vez por semana. Ficam as ${data?.keep ?? 4} cópias mais recentes, cifradas.`}
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data && (
          <>
            <ProfileFacts
              items={[
                ["Situação", status],
                ["Último backup", items[0] ? stamp(items[0].taken_at) : "Nenhum ainda"],
                [
                  "Próximo backup",
                  data.device.config_backup && device.agent_id
                    ? stamp(data.device.next_due_at)
                    : "Não se aplica",
                ],
                ...(data.device.config_backup_error
                  ? ([
                      [
                        "Última falha",
                        `${stamp(data.device.config_backup_error_at)} · ${data.device.config_backup_error}`,
                      ],
                    ] as [string, string][])
                  : []),
              ]}
            />
            {items.length === 0 && (
              <p className="profile-footnote">
                Nenhuma cópia guardada ainda.
                {device.driver === "mikrotik_radius" &&
                  " No MikroTik o agente usa SSH (/export), com a chave do equipamento fixada na credencial local."}
              </p>
            )}
            {items.map((item, index) => (
              <div key={item.id} className="border-t py-3 erp-stack">
                <div className="erp-inline-actions">
                  <span className="mono">{stamp(item.taken_at)}</span>
                  <Badge variant="outline">
                    {item.trigger === "manual" ? "Pedido no painel" : "Semanal"}
                  </Badge>
                  {item.changed === true && (
                    <Badge variant="warning">Configuração alterada</Badge>
                  )}
                  {item.changed === false && (
                    <Badge variant="secondary">Sem mudança</Badge>
                  )}
                  <span className="profile-footnote">
                    {size(item.size_bytes)} · {item.lines} linhas
                  </span>
                </div>
                {writable && (
                  <div className="erp-inline-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setViewing(item)}
                    >
                      Ver e baixar
                    </Button>
                    {index < items.length - 1 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setComparing(item)}
                      >
                        Comparar com a anterior
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {writable && (
              <div className="erp-inline-actions">
                {data.device.config_backup && device.agent_id && (
                  <ActionButton
                    onClick={async () => {
                      await api(key, { method: "POST" });
                      toast.success(
                        "Backup pedido. O agente executa no próximo ciclo.",
                      );
                      await result.mutate();
                    }}
                  >
                    Fazer backup agora
                  </ActionButton>
                )}
                <ActionButton
                  confirm={
                    data.device.config_backup
                      ? "Desligar o backup semanal deste equipamento? As cópias já guardadas continuam disponíveis."
                      : undefined
                  }
                  onClick={async () => {
                    await api(`/devices/${device.id}`, {
                      method: "PATCH",
                      body: { config_backup: !data.device.config_backup },
                    });
                    await result.mutate();
                  }}
                >
                  {data.device.config_backup
                    ? "Desligar backup"
                    : "Ligar backup semanal"}
                </ActionButton>
              </div>
            )}
            {!writable && items.length > 0 && (
              <p className="profile-footnote">
                Abrir ou comparar o conteúdo exige permissão de escrita de rede
                no provedor inteiro.
              </p>
            )}
          </>
        )}
      </QueryBoundary>
      {viewing && (
        <BackupContent copy={viewing} onClose={() => setViewing(null)} />
      )}
      {comparing && (
        <BackupDiff copy={comparing} onClose={() => setComparing(null)} />
      )}
    </ProfileSection>
  );
}

function BackupContent({ copy, onClose }: { copy: Copy; onClose: () => void }) {
  const path = `/config-backups/${copy.id}`;
  const result = useSWR(["erp-config-backup", path], async () =>
    contentSchema.parse(await api(path)),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Configuração de {stamp(copy.taken_at)}</DialogTitle>
          <DialogDescription>
            Cópia guardada pelo NexoISP. A abertura fica registrada na
            auditoria.
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          {result.data && (
            <>
              <div className="erp-inline-actions">
                <Button
                  variant="outline"
                  onClick={() =>
                    save(
                      fileName(result.data!.device_name, result.data!.taken_at),
                      result.data!.content,
                    )
                  }
                >
                  Baixar arquivo .txt
                </Button>
                <span className="profile-footnote mono">
                  SHA-256 {result.data.sha256.slice(0, 16)}…
                </span>
              </div>
              <pre className="mono max-h-[60vh] overflow-auto whitespace-pre rounded border p-3 text-xs">
                {result.data.content}
              </pre>
            </>
          )}
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}

function BackupDiff({ copy, onClose }: { copy: Copy; onClose: () => void }) {
  const path = `/config-backups/${copy.id}/diff`;
  const result = useSWR(["erp-config-backup-diff", path], async () =>
    diffSchema.parse(await api(path)),
  );
  const data = result.data;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>O que mudou</DialogTitle>
          <DialogDescription>
            {data
              ? `De ${stamp(data.previous.taken_at)} para ${stamp(data.backup.taken_at)}: ${data.added} linha(s) incluída(s), ${data.removed} removida(s).`
              : "Comparando com a cópia anterior."}
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          {data && data.lines.length === 0 && !data.truncated && (
            <p className="profile-footnote">
              Nenhuma diferença na configuração.
            </p>
          )}
          {data?.truncated && (
            <p className="profile-footnote">
              {data.lines.length === 0
                ? "Diferenças demais para comparar linha a linha. Baixe as duas cópias para comparar fora do painel."
                : "Mostrando só o começo das diferenças."}
            </p>
          )}
          {data && data.lines.length > 0 && (
            <pre className="mono max-h-[60vh] overflow-auto whitespace-pre rounded border p-3 text-xs">
              {data.lines.map((line, i) =>
                line.op === "@" ? (
                  <div key={i} className="text-muted-foreground">
                    {`@@ linha ${line.old} → ${line.new}`}
                  </div>
                ) : (
                  <div
                    key={i}
                    className={
                      line.op === "+"
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : line.op === "-"
                          ? "bg-red-500/10 text-red-700 dark:text-red-300"
                          : ""
                    }
                  >
                    {`${line.op} ${line.text}`}
                  </div>
                ),
              )}
            </pre>
          )}
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}
