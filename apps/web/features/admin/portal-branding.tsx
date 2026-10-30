import { useRef, useState } from "react";
import { Panel } from "@/components/workspace-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
import {
  brandingLogoUrl,
  brandingSchema,
  type BrandingUpdate,
  type PortalBranding as Branding,
} from "@/features/portal/branding-models";
import { usePortalBranding } from "@/features/portal/branding";

export function PortalBrandingSettings() {
  const result = usePortalBranding();
  return (
    <Panel
      title="Marca no portal do assinante"
      description="Opcional. Esta identidade de exibição não altera os dados fiscais do provedor."
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {!result.error && result.data && (
          <BrandingForm
            key={`${result.data.updated_at ?? "default"}:${result.data.logo?.sha256 ?? "none"}`}
            initial={result.data}
            save={async (body) => {
              const saved = brandingSchema.parse(
                await api("/settings/portal-branding", { method: "PUT", body }),
              );
              await result.mutate(saved, { revalidate: false });
            }}
          />
        )}
      </QueryBoundary>
    </Panel>
  );
}

function BrandingForm({
  initial,
  save,
}: {
  initial: Branding;
  save: (body: BrandingUpdate) => Promise<void>;
}) {
  const [name, setName] = useState(initial.display_name ?? "");
  const [action, setAction] = useState<"keep" | "remove" | "replace">("keep");
  const [content, setContent] = useState("");
  const [fileError, setFileError] = useState("");
  const [reading, setReading] = useState(false);
  const version = useRef(0);
  const selectFile = async (file: File | undefined) => {
    const current = ++version.current;
    setContent("");
    setAction("keep");
    setFileError("");
    setReading(Boolean(file));
    if (!file) return;
    try {
      if (
        !["image/png", "image/jpeg"].includes(file.type) ||
        file.size > 256 * 1024 ||
        file.size === 0
      )
        throw new Error("Escolha PNG ou JPEG de até 256 KiB.");
      const bitmap = await createImageBitmap(file);
      const valid =
        bitmap.width <= 512 &&
        bitmap.height <= 512 &&
        bitmap.width > 0 &&
        bitmap.height > 0;
      bitmap.close();
      if (!valid) throw new Error("A imagem deve ter até 512 × 512 pixels.");
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () =>
          reject(new Error("Não foi possível ler a imagem."));
        reader.readAsDataURL(file);
      });
      if (current !== version.current) return;
      setContent(data);
      setAction("replace");
    } catch (error) {
      if (current === version.current)
        setFileError(
          error instanceof Error ? error.message : "Imagem inválida.",
        );
    } finally {
      if (current === version.current) setReading(false);
    }
  };
  return (
    <MutationForm
      onSubmit={async () => {
        const trimmed = name.trim();
        const length = Array.from(trimmed).length;
        if (trimmed && (length < 2 || length > 80))
          throw new Error("O nome deve ter de 2 a 80 caracteres.");
        if (reading) throw new Error("Aguarde a leitura do logotipo.");
        if (fileError) throw new Error(fileError);
        await save(
          action === "replace"
            ? {
                display_name: trimmed || null,
                logo_action: action,
                logo_content_base64: content.split(",")[1],
              }
            : { display_name: trimmed || null, logo_action: action },
        );
      }}
    >
      <FormField
        label="Nome de exibição"
        hint="Deixe vazio para usar o nome do provedor."
      >
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </FormField>
      <FormField
        label="Logotipo"
        hint="PNG ou JPEG, até 256 KiB e 512 × 512 pixels."
      >
        <Input
          type="file"
          accept="image/png,image/jpeg"
          onChange={(event) => void selectFile(event.target.files?.[0])}
        />
      </FormField>
      {fileError && <p role="alert">{fileError}</p>}
      {action !== "remove" && (content || initial.logo) && (
        <img
          src={content || brandingLogoUrl(initial.logo!.sha256)}
          alt="Prévia do logotipo"
          className="h-20 w-32 object-contain"
        />
      )}
      <div className="erp-inline-actions">
        <Button type="button" variant="outline" onClick={() => setName("")}>
          Usar nome do provedor
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            version.current++;
            setReading(false);
            setAction("remove");
            setContent("");
            setFileError("");
          }}
        >
          Remover logotipo
        </Button>
        {action !== "keep" && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              version.current++;
              setReading(false);
              setAction("keep");
              setContent("");
              setFileError("");
            }}
          >
            Manter logotipo salvo
          </Button>
        )}
      </div>
    </MutationForm>
  );
}
