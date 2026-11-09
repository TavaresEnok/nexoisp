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
  cameraAccept,
  captionLimit,
  validateAttachment,
} from "./work-attachments-model";
import {
  blobToBase64,
  browserPhotoCodec,
  photoName,
  reducePhoto,
} from "./image-reduce";

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
  const [caption, setCaption] = useState("");
  const locked = useRef(false);
  const actions = attachmentActions(status, writable, result.data);
  const currentActions = useRef(actions);
  currentActions.current = actions;
  const upload = async (picked?: File, camera = false) => {
    if (!picked || locked.current || !currentActions.current.upload) return;
    locked.current = true;
    setBusy(true);
    try {
      let file: Blob = picked;
      let name = picked.name;
      if (camera) {
        // Câmera do celular: reduz o lado maior a 1920 px e recodifica em JPEG.
        file = (await reducePhoto(picked, browserPhotoCodec)).blob;
        name = photoName(new Date());
      }
      const error = validateAttachment(
        camera ? new File([file], name, { type: file.type }) : picked,
      );
      if (error) throw new Error(error);
      if (Array.from(caption.trim()).length > captionLimit)
        throw new Error(`A legenda deve ter até ${captionLimit} caracteres.`);
      const content = await blobToBase64(file);
      if (!currentActions.current.upload)
        throw new Error("O envio de anexos não está disponível para esta OS.");
      attachmentSchema.parse(
        await api<unknown>(path, {
          method: "POST",
          body: {
            name,
            content_base64: content,
            caption: caption.trim() || null,
          },
        }),
      );
      setCaption("");
      toast.success(camera ? "Foto enviada." : "Anexo enviado.");
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
          <>
            <FormField
              label="Legenda do próximo envio (opcional)"
              hint="Até 200 caracteres; acompanha a foto ou o PDF enviado em seguida."
            >
              <Input
                maxLength={captionLimit}
                disabled={busy}
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
              />
            </FormField>
            <FormField
              label={busy ? "Enviando foto…" : "Tirar foto com a câmera"}
              hint="No celular abre a câmera traseira; a foto é reduzida para até 1920 px em JPEG antes do envio."
            >
              <Input
                type="file"
                accept={cameraAccept}
                capture="environment"
                disabled={busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  void upload(file, true);
                }}
              />
            </FormField>
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
          </>
        )}
        {result.data && result.data.items.length === 0 && (
          <p className="profile-footnote">Nenhum anexo nesta OS.</p>
        )}
        {result.data?.items.map((item) => (
          <div className="erp-contract-card" key={item.id}>
            <strong>{item.name}</strong>
            {item.caption && (
              <p className="whitespace-pre-wrap">{item.caption}</p>
            )}
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
