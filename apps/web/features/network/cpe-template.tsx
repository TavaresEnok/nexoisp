import { useEffect, useState } from "react";
import useSWR from "swr";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { api } from "@/platform/erp-client";
import {
  acsPreviewSchema,
  acsSuggestionSchema,
  dataModelLabel,
  type AcsPreview,
} from "./acs-templates-model";
import type { useCpeCommands } from "./cpe-tasks";

/** Aplicação de template ACS na ficha do contrato: sugere, pré-visualiza (senhas mascaradas) e registra a intenção durável. */
export function CpeTemplateAction({
  contract,
  commands,
  onApplied,
}: {
  contract: string;
  commands: ReturnType<typeof useCpeCommands>;
  onApplied: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={commands.blocked}
        onClick={() => setOpen(true)}
      >
        Aplicar template
      </Button>
      {open && (
        <TemplateDialog
          contract={contract}
          commands={commands}
          onClose={() => setOpen(false)}
          onApplied={onApplied}
        />
      )}
    </>
  );
}

function TemplateDialog({
  contract,
  commands,
  onClose,
  onApplied,
}: {
  contract: string;
  commands: ReturnType<typeof useCpeCommands>;
  onClose: () => void;
  onApplied: () => Promise<unknown>;
}) {
  const suggestions = useSWR(["cpe-templates", contract], async () =>
    acsSuggestionSchema.parse(
      await api(`/contracts/${contract}/cpe/templates`),
    ),
  );
  const [template, setTemplate] = useState("");
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<AcsPreview | null>(null);
  useEffect(() => {
    if (!template && suggestions.data?.suggested_id)
      setTemplate(suggestions.data.suggested_id);
  }, [template, suggestions.data]);
  const body = () => ({
    template_id: template,
    ...(ssid.trim() ? { wifi_ssid: ssid.trim() } : {}),
    ...(password ? { wifi_senha: password } : {}),
  });
  const data = suggestions.data;
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Aplicar template ACS</DialogTitle>
          <DialogDescription>
            Os valores são resolvidos no servidor. A tarefa fica registrada e
            somente uma leitura do roteador confirma a alteração.
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={suggestions.isLoading}
          error={suggestions.error}
          retry={() => suggestions.mutate()}
        >
          {data && !data.device && (
            <p role="alert">
              O roteador vinculado não foi encontrado no servidor de gerência.
            </p>
          )}
          {data?.device && !data.templates.length && (
            <p role="status">
              Nenhum template ativo casa com {data.device.manufacturer}{" "}
              {data.device.model} ({data.device.firmware}). Cadastre um em Rede
              óptica › ACS - Template.
            </p>
          )}
          {data?.device && data.templates.length > 0 && (
            <>
              <p className="profile-footnote">
                Roteador: {data.device.manufacturer} · {data.device.model} ·
                firmware {data.device.firmware} ·{" "}
                {dataModelLabel(data.device.data_model)}
              </p>
              <div className="erp-columns">
                <FormField
                  label="Template a aplicar"
                  hint="Ordenados do mais específico ao mais genérico."
                >
                  <select
                    className="commercial-select"
                    required
                    value={template}
                    onChange={(event) => {
                      setTemplate(event.target.value);
                      setPreview(null);
                    }}
                  >
                    {data.templates.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.id === data.suggested_id ? " (sugerido)" : ""}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField
                  label="Nome da rede Wi-Fi do template"
                  hint="Usado por {{wifi_ssid}}."
                >
                  <Input
                    maxLength={32}
                    value={ssid}
                    onChange={(event) => {
                      setSsid(event.target.value);
                      setPreview(null);
                    }}
                  />
                </FormField>
                <FormField
                  label="Senha do Wi-Fi do template"
                  hint="Usada por {{wifi_senha}}; de 8 a 63 caracteres, nunca exibida."
                >
                  <Input
                    type="password"
                    maxLength={63}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setPreview(null);
                    }}
                  />
                </FormField>
              </div>
              <ActionButton
                disabled={!template}
                onClick={async () =>
                  setPreview(
                    acsPreviewSchema.parse(
                      await api(`/contracts/${contract}/cpe/template/preview`, {
                        body: body(),
                      }),
                    ),
                  )
                }
              >
                Pré-visualizar valores
              </ActionButton>
              {preview && <PreviewTable preview={preview} />}
              <MutationForm
                submit="Registrar aplicação do template"
                onCancel={onClose}
                onSubmit={async () => {
                  if (!template) throw new Error("Selecione o template.");
                  if (password && password.length < 8)
                    throw new Error(
                      "A senha do Wi-Fi deve ter pelo menos oito caracteres.",
                    );
                  await commands.send("template", body());
                  await onApplied();
                  onClose();
                }}
              >
                <p className="profile-footnote">
                  Uma resposta perdida não autoriza outra solicitação: a mesma
                  intenção é reaproveitada até a confirmação.
                </p>
              </MutationForm>
            </>
          )}
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}

function PreviewTable({ preview }: { preview: AcsPreview }) {
  const missing = preview.variables.filter((v) =>
    preview.missing.includes(v.name),
  );
  return (
    <div className="erp-stack" aria-label="Pré-visualização do template">
      {missing.length > 0 && (
        <p role="alert">
          Faltam valores: {missing.map((v) => v.label).join(", ")}.
        </p>
      )}
      {preview.matches === false && (
        <p role="alert">
          O template não corresponde ao fabricante, modelo ou firmware deste
          roteador.
        </p>
      )}
      {preview.compatible === false && (
        <p role="alert">
          O template usa outro modelo de dados TR-069 que o deste roteador.
        </p>
      )}
      {preview.ready && (
        <Badge variant="outline">Pronto para registrar a aplicação</Badge>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Parâmetro</TableHead>
            <TableHead>Valor resolvido</TableHead>
            <TableHead>Tipo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {preview.parameters.map((p) => (
            <TableRow key={p.path}>
              <TableCell>
                <code className="mono">{p.path}</code>
              </TableCell>
              <TableCell>
                {p.missing.length
                  ? `Falta ${p.missing.map((v) => `{{${v}}}`).join(", ")}`
                  : String(p.value)}
                {p.sensitive && (
                  <Badge variant="outline">Senha mascarada</Badge>
                )}
              </TableCell>
              <TableCell>{p.type}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
