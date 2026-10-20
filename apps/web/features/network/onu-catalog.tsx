import { useState } from "react";
import useSWR from "swr";
import { useLocation } from "react-router-dom";
import { z } from "zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { OnuCatalog } from "@/components/onu-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OnuModel, OnuTemplate } from "@/lib/technical-catalog";
import { RecordEditor } from "@/features/shared/record-editor";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { shortCode } from "@/features/shared/format";
import { useCreateRequest } from "@/features/shared/create-request";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";

const mode = z.enum(["Bridge", "Router"]);
const modelSchema = z.object({
  id: z.string(),
  code: z.string(),
  vendor: z.string(),
  description: z.string(),
  ports: z.string(),
  wifi: z.string(),
  mode,
  profile: z.string(),
  compatible_olts: z.array(z.string()),
  notes: z.string(),
  updated_at: z.string(),
});
const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  mode,
  compatible_olts: z.array(z.string()),
  gpon: z.string(),
  wan: z.string(),
  notes: z.string(),
  model_ids: z.array(z.string()),
  updated_at: z.string(),
});
type ModelRow = z.infer<typeof modelSchema>;
type TemplateRow = z.infer<typeof templateSchema>;

const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const toModel = (row: ModelRow): OnuModel => ({
  id: row.id,
  code: row.code,
  vendor: row.vendor,
  description: row.description || "Sem descrição",
  ports: row.ports || "Não informado",
  wifi: row.wifi || "Não informado",
  mode: row.mode,
  profile: row.profile || "Não informado",
  compatibleOlts: row.compatible_olts,
  notes: row.notes,
});
const toTemplate = (row: TemplateRow): OnuTemplate => ({
  id: row.id,
  name: row.name,
  vendor: row.vendor,
  mode: row.mode,
  modelIds: row.model_ids,
  compatibleOlts: row.compatible_olts,
  gpon: row.gpon,
  wan: row.wan,
  notes: row.notes,
});

// Catálogo de referência do provedor (FTTx - ONU Tipo e FTTx - ONU Template do v0).
export function OnuCatalogPage() {
  const { me } = useSession();
  const location = useLocation();
  const write = can(me, "network:write");
  const tab = location.pathname.endsWith("fttx-onu-template")
    ? "templates"
    : "models";
  const models = useSWR("erp-onu-models", async () =>
    z.array(modelSchema).parse(await api("/olt/onu-models")),
  );
  const templates = useSWR("erp-onu-templates", async () =>
    z.array(templateSchema).parse(await api("/olt/onu-templates")),
  );
  const [model, setModel] = useState<ModelRow | "new" | null>(null);
  const [template, setTemplate] = useState<TemplateRow | "new" | null>(null);
  useCreateRequest("modelo", () => setModel("new"), write);
  useCreateRequest("template", () => setTemplate("new"), write);
  const refresh = async () => {
    await Promise.all([models.mutate(), templates.mutate()]);
  };
  const rows = [...(models.data ?? []), ...(templates.data ?? [])];
  const asOf =
    rows
      .map((row) => row.updated_at)
      .sort()
      .at(-1) ?? new Date().toISOString();
  return (
    <QueryBoundary
      loading={models.isLoading || templates.isLoading}
      error={models.error ?? templates.error}
      retry={() => void refresh()}
    >
      <OnuCatalog
        catalog={{
          asOf,
          models: (models.data ?? []).map(toModel),
          templates: (templates.data ?? []).map(toTemplate),
        }}
        initialTab={tab}
        operational={{
          noticeTitle: "Referência técnica do provedor",
          notice:
            "Catálogo cadastrado pela equipe. Compatibilidade e parâmetros são documentação: nada é enviado à OLT nem altera ONUs, e a compatibilidade de referência não substitui homologação. O testador apenas substitui variáveis no texto.",
          sample: "Catálogo técnico do provedor · sem comandos remotos",
          badge: write ? "Cadastro do provedor" : "Somente leitura",
          formatId: shortCode,
          actions: write && (
            <>
              <Button variant="outline" onClick={() => setTemplate("new")}>
                <Plus data-icon="inline-start" />
                Novo template
              </Button>
              <Button onClick={() => setModel("new")}>
                <Plus data-icon="inline-start" />
                Novo modelo
              </Button>
            </>
          ),
          modelActions: (item) => {
            const row = models.data?.find(
              (candidate) => candidate.id === item.id,
            );
            return (
              write &&
              row && (
                <div className="erp-inline-actions">
                  <Button variant="outline" onClick={() => setModel(row)}>
                    Editar modelo
                  </Button>
                  <ActionButton
                    confirm={`Excluir o modelo ${row.code} do catálogo?`}
                    onClick={async () => {
                      await api(`/olt/onu-models/${row.id}`, {
                        method: "DELETE",
                      });
                      toast.success(
                        "Modelo excluído. Feche a ficha para atualizar.",
                      );
                      await refresh();
                    }}
                  >
                    Excluir modelo
                  </ActionButton>
                </div>
              )
            );
          },
          templateActions: (item) => {
            const row = templates.data?.find(
              (candidate) => candidate.id === item.id,
            );
            return (
              write &&
              row && (
                <div className="erp-inline-actions">
                  <Button variant="outline" onClick={() => setTemplate(row)}>
                    Editar template
                  </Button>
                  <ActionButton
                    confirm={`Excluir o template ${row.name}?`}
                    onClick={async () => {
                      await api(`/olt/onu-templates/${row.id}`, {
                        method: "DELETE",
                      });
                      toast.success(
                        "Template excluído. Feche a ficha para atualizar.",
                      );
                      await refresh();
                    }}
                  >
                    Excluir template
                  </ActionButton>
                </div>
              )
            );
          },
        }}
      />
      {model && (
        <RecordEditor
          title={
            model === "new" ? "Novo modelo de ONU" : "Editar modelo de ONU"
          }
          description="Referência técnica do provedor; não altera ONUs nem a OLT."
          initial={{
            code: model === "new" ? "" : model.code,
            vendor: model === "new" ? "" : model.vendor,
            mode: model === "new" ? "Bridge" : model.mode,
            description: model === "new" ? "" : model.description,
            ports: model === "new" ? "" : model.ports,
            wifi: model === "new" ? "" : model.wifi,
            profile: model === "new" ? "" : model.profile,
            compatible_olts:
              model === "new" ? "" : model.compatible_olts.join("\n"),
            notes: model === "new" ? "" : model.notes,
          }}
          fields={[
            {
              key: "code",
              label: "Código do modelo",
              required: true,
              maxLength: 80,
            },
            {
              key: "vendor",
              label: "Fabricante",
              required: true,
              maxLength: 80,
            },
            {
              key: "mode",
              label: "Modo de operação",
              type: "select",
              options: [
                { value: "Bridge", label: "Bridge" },
                { value: "Router", label: "Router" },
              ],
            },
            {
              key: "description",
              label: "Descrição comercial",
              maxLength: 500,
            },
            { key: "ports", label: "Portas", maxLength: 120 },
            { key: "wifi", label: "Wi-Fi", maxLength: 120 },
            {
              key: "profile",
              label: "Perfil de provisionamento",
              maxLength: 120,
            },
            {
              key: "compatible_olts",
              label: "OLTs compatíveis (uma por linha)",
              type: "textarea",
              hint: "Referência; não representa homologação.",
            },
            {
              key: "notes",
              label: "Observações",
              type: "textarea",
              maxLength: 2000,
            },
          ]}
          submit={model === "new" ? "Cadastrar modelo" : "Salvar modelo"}
          onClose={() => setModel(null)}
          onSubmit={async (values) => {
            const body = {
              ...values,
              compatible_olts: lines(values.compatible_olts),
            };
            await api(
              model === "new"
                ? "/olt/onu-models"
                : `/olt/onu-models/${model.id}`,
              { method: model === "new" ? "POST" : "PATCH", body },
            );
            setModel(null);
            await refresh();
          }}
        />
      )}
      {template && (
        <TemplateEditor
          template={template === "new" ? null : template}
          models={models.data ?? []}
          onClose={() => setTemplate(null)}
          onDone={async () => {
            setTemplate(null);
            await refresh();
          }}
        />
      )}
    </QueryBoundary>
  );
}

function TemplateEditor({
  template,
  models,
  onClose,
  onDone,
}: {
  template: TemplateRow | null;
  models: ModelRow[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: template?.name ?? "",
    vendor: template?.vendor ?? "",
    mode: template?.mode ?? "Bridge",
    compatible_olts: template?.compatible_olts.join("\n") ?? "",
    gpon: template?.gpon ?? "",
    wan: template?.wan ?? "",
    notes: template?.notes ?? "",
  });
  const [selected, setSelected] = useState<string[]>(template?.model_ids ?? []);
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>
            {template ? "Editar template de ONU" : "Novo template de ONU"}
          </DialogTitle>
          <DialogDescription>
            Parâmetros GPON e WAN com variáveis %vlan%, %slot%, %pon%, %sn% e
            %login%. Documentação técnica; não é enviada à OLT.
          </DialogDescription>
        </DialogHeader>
        <MutationForm
          submit={template ? "Salvar template" : "Cadastrar template"}
          onCancel={onClose}
          onSubmit={async () => {
            await api(
              template
                ? `/olt/onu-templates/${template.id}`
                : "/olt/onu-templates",
              {
                method: template ? "PATCH" : "POST",
                body: {
                  ...form,
                  compatible_olts: lines(form.compatible_olts),
                  model_ids: selected,
                },
              },
            );
            await onDone();
          }}
        >
          <div className="erp-columns">
            <FormField label="Nome do template">
              <Input
                required
                minLength={2}
                maxLength={120}
                value={form.name}
                onChange={(event) => set("name")(event.target.value)}
              />
            </FormField>
            <FormField label="Fabricante">
              <Input
                required
                maxLength={80}
                value={form.vendor}
                onChange={(event) => set("vendor")(event.target.value)}
              />
            </FormField>
            <FormField label="Modo de operação">
              <select
                className="commercial-select"
                value={form.mode}
                onChange={(event) => set("mode")(event.target.value)}
              >
                <option>Bridge</option>
                <option>Router</option>
              </select>
            </FormField>
          </div>
          <fieldset>
            <legend>Modelos de ONU associados</legend>
            {models.length ? (
              <div className="erp-inline-actions">
                {models.map((item) => (
                  <label key={item.id} className="erp-inline-actions">
                    <input
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, item.id]
                            : current.filter((id) => id !== item.id),
                        )
                      }
                    />
                    {item.code}
                  </label>
                ))}
              </div>
            ) : (
              <p className="profile-footnote">
                Cadastre modelos para associá-los ao template.
              </p>
            )}
          </fieldset>
          <FormField label="OLTs compatíveis (uma por linha)">
            <Textarea
              value={form.compatible_olts}
              onChange={(event) => set("compatible_olts")(event.target.value)}
            />
          </FormField>
          <FormField label="Parâmetros GPON">
            <Textarea
              className="mono"
              maxLength={20000}
              value={form.gpon}
              onChange={(event) => set("gpon")(event.target.value)}
            />
          </FormField>
          <FormField label="Parâmetros WAN">
            <Textarea
              className="mono"
              maxLength={20000}
              value={form.wan}
              onChange={(event) => set("wan")(event.target.value)}
            />
          </FormField>
          <FormField label="Observações">
            <Textarea
              maxLength={2000}
              value={form.notes}
              onChange={(event) => set("notes")(event.target.value)}
            />
          </FormField>
        </MutationForm>
      </DialogContent>
    </Dialog>
  );
}
