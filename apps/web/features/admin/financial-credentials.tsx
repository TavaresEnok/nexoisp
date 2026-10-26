import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { QueryBoundary } from "@/features/shared/feedback";
import { FormField, MutationForm } from "@/features/shared/form";
import { api } from "@/platform/erp-client";

const versionSchema = z.object({
  id: z.string(),
  version: z.number(),
  kind: z.enum(["efi_pix", "efi_charges"]),
  certificate_expires_at: z.string().nullable().optional(),
  current: z.boolean(),
});
export function FinancialCredentials({
  connection,
  onClose,
  onSaved,
}: {
  connection: { id: string; name: string };
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const versions = useSWR(["financial-credentials", connection.id], async () =>
    z
      .array(versionSchema)
      .parse(await api(`/financial-connections/${connection.id}/credentials`)),
  );
  const [selected, setSelected] = useState("efi_pix");
  const kind = versions.data?.[0]?.kind ?? selected;
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [pixKey, setPixKey] = useState("");
  const [certificate, setCertificate] = useState<File | null>(null);
  const [privateKey, setPrivateKey] = useState<File | null>(null);
  const current = versions.data?.find((version) => version.current);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Credenciais de {connection.name}</DialogTitle>
          <DialogDescription>
            Uma nova versão preserva o histórico das cobranças. Os segredos
            cadastrados não serão exibidos novamente.
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={versions.isLoading}
          error={versions.error}
          retry={() => versions.mutate()}
        >
          {current && (
            <p className="text-sm text-muted-foreground">
              Versão atual: {current.version}
              {current.certificate_expires_at
                ? ` · Certificado válido até ${new Date(current.certificate_expires_at).toLocaleDateString("pt-BR")}`
                : ""}
            </p>
          )}
          <MutationForm
            submit="Salvar nova versão"
            onCancel={onClose}
            onSubmit={async () => {
              if (kind === "efi_pix" && (!certificate || !privateKey))
                throw new Error("Selecione o certificado e a chave privada.");
              if (
                (certificate?.size ?? 0) > 131072 ||
                (privateKey?.size ?? 0) > 32768
              )
                throw new Error(
                  "Arquivo de certificado ou chave excede o limite.",
                );
              await api(`/financial-connections/${connection.id}/credentials`, {
                body: {
                  kind,
                  client_id: clientId,
                  client_secret: secret,
                  ...(kind === "efi_pix"
                    ? {
                        pix_key: pixKey,
                        certificate_pem: await certificate!.text(),
                        private_key_pem: await privateKey!.text(),
                      }
                    : {}),
                },
              });
              setSecret("");
              setCertificate(null);
              setPrivateKey(null);
              await onSaved();
              onClose();
            }}
          >
            <div className="erp-columns">
              <FormField label="API da aplicação">
                <select
                  className="commercial-select"
                  value={kind}
                  disabled={(versions.data?.length ?? 0) > 0}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  <option value="efi_pix">
                    Pix imediato e Pix com vencimento
                  </option>
                  <option value="efi_charges">Boleto / Bolix</option>
                </select>
              </FormField>
              <FormField label="ID da aplicação">
                <Input
                  required
                  autoComplete="off"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                />
              </FormField>
              <FormField label="Senha da aplicação">
                <Input
                  required
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </FormField>
              {kind === "efi_pix" && (
                <>
                  <FormField label="Chave Pix">
                    <Input
                      required
                      autoComplete="off"
                      value={pixKey}
                      onChange={(event) => setPixKey(event.target.value)}
                    />
                  </FormField>
                  <FormField label="Certificado PEM">
                    <Input
                      required
                      type="file"
                      accept=".pem,.crt"
                      onChange={(event) =>
                        setCertificate(event.target.files?.[0] ?? null)
                      }
                    />
                  </FormField>
                  <FormField label="Chave privada PEM">
                    <Input
                      required
                      type="file"
                      accept=".pem,.key"
                      onChange={(event) =>
                        setPrivateKey(event.target.files?.[0] ?? null)
                      }
                    />
                  </FormField>
                </>
              )}
            </div>
          </MutationForm>
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}
