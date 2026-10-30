import { useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/features/shared/action";
import { FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can, hasModule } from "@/features/session/model";
import { api, download } from "@/platform/erp-client";
import {
  attachmentAccept,
  attachmentActions,
  attachmentSchema,
  attachmentsSchema,
  validateAttachment,
} from "./work-attachments-model";

export function WorkAttachments({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const { me } = useSession();
  const readable = can(me, "os:read") && hasModule(me, "field");
  const writable = can(me, "os:write") && hasModule(me, "field");
  const path = `/work-orders/${encodeURIComponent(id)}/attachments`;
  const result = useSWR(readable ? ["erp-work-attachments", id] : null, () =>
    api<unknown>(path).then((data) => attachmentsSchema.parse(data)),
  );
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const actions = attachmentActions(status, writable, result.data);
  const currentActions = useRef(actions);
  currentActions.current = actions;
  const upload = async (file?: File) => {
    if (!file || locked.current || !currentActions.current.upload) return;
    const error = validateAttachment(file);
    if (error) {
      toast.error(error);
      return;
    }
    locked.current = true;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      if (!currentActions.current.upload)
        throw new Error("O envio de anexos não está disponível para esta OS.");
      attachmentSchema.parse(
        await api<unknown>(path, {
          method: "POST",
          body: { name: file.name, content_base64: btoa(binary) },
        }),
      );
      toast.success("Anexo enviado.");
      await result.mutate();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Não foi possível enviar o anexo.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <ProfileSection
      title="Anexos da visita"
      caption="Fotos e PDFs privados, até 5 MiB por arquivo."
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {actions.upload && (
          <FormField
            label={busy ? "Enviando arquivo…" : "Adicionar foto ou PDF"}
          >
            <Input
              type="file"
              accept={attachmentAccept}
              disabled={busy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                void upload(file);
              }}
            />
          </FormField>
        )}
        {result.data && result.data.items.length === 0 && (
          <p className="profile-footnote">Nenhum anexo nesta OS.</p>
        )}
        {result.data?.items.map((item) => (
          <div className="erp-contract-card" key={item.id}>
            <strong>{item.name}</strong>
            <small>
              {item.kind === "photo" ? "Foto" : "Documento"} ·{" "}
              {Math.ceil(item.size_bytes / 1024)} KiB ·{" "}
              {new Date(item.created_at).toLocaleString("pt-BR")}
            </small>
            <div className="erp-inline-actions">
              <ActionButton
                label={`Baixar ${item.name}`}
                onClick={async () => {
                  await download(
                    `${path}/${encodeURIComponent(item.id)}/download`,
                    item.name,
                  );
                }}
              >
                Baixar
              </ActionButton>
              {actions.delete && (
                <ActionButton
                  danger
                  label={`Excluir ${item.name}`}
                  confirm="Excluir este anexo? O conteúdo será removido e o registro de auditoria preservado."
                  onClick={async () => {
                    if (!currentActions.current.delete)
                      throw new Error(
                        "A exclusão de anexos não está disponível para esta OS.",
                      );
                    const response = await api<unknown>(
                      `${path}/${encodeURIComponent(item.id)}`,
                      { method: "DELETE" },
                    );
                    if (
                      !response ||
                      typeof response !== "object" ||
                      !("ok" in response) ||
                      response.ok !== true
                    )
                      throw new Error("Resposta de exclusão inválida.");
                    toast.success("Anexo excluído.");
                    await result.mutate();
                  }}
                >
                  Excluir
                </ActionButton>
              )}
            </div>
          </div>
        ))}
      </QueryBoundary>
    </ProfileSection>
  );
}
