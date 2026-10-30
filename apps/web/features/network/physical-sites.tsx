import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/features/shared/form";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { api, download } from "@/platform/erp-client";
import {
  physicalSiteSchema,
  physicalSitesPageSchema,
  siteKinds,
  type PhysicalSite,
  type SitePop,
} from "./physical-sites-models";

const limit = 20;
const kindLabel = (kind: string) =>
  siteKinds.find((item) => item.value === kind)?.label ?? kind;
export function PhysicalSites({
  scope,
  pops,
  write,
}: {
  scope: string;
  pops: SitePop[];
  write: boolean;
}) {
  const { mutate } = useSWRConfig();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [pop, setPop] = useState("");
  const [status, setStatus] = useState("active");
  const [offset, setOffset] = useState(0);
  const [editor, setEditor] = useState<PhysicalSite | "create" | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const params = new URLSearchParams({
    status,
    limit: String(limit),
    offset: String(offset),
  });
  if (q) params.set("q", q);
  if (kind) params.set("kind", kind);
  if (pop) params.set("pop_id", pop);
  const result = useSWR(
    ["network-sites", scope, params.toString()],
    async ([, , query]) =>
      physicalSitesPageSchema.parse(await api(`/network/sites?${query}`)),
  );
  const detail = useSWR(
    detailId ? ["network-site", scope, detailId] : null,
    async ([, , id]) =>
      physicalSiteSchema.parse(await api(`/network/sites/${id}`)),
  );
  useEffect(() => {
    if (result.data && offset > 0 && offset >= result.data.total) {
      setOffset(
        Math.max(0, Math.ceil(result.data.total / limit) * limit - limit),
      );
    }
  }, [offset, result.data]);
  const editing = editor && editor !== "create" ? editor : null;
  const refreshSites = () =>
    mutate(
      (key) =>
        Array.isArray(key) &&
        (key[0] === "network-sites" || key[0] === "network-site") &&
        key[1] === scope,
      undefined,
      { revalidate: true },
    );
  const updateFilter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setOffset(0);
  };
  return (
    <Panel title="Locais de infraestrutura">
      <p className="profile-footnote">
        Inventário cadastral de postes, torres e condomínios por POP; não atua
        na rede nem indica cobertura ou viabilidade.
      </p>
      <div className="erp-columns">
        <FormField label="Buscar locais">
          <Input
            value={q}
            maxLength={100}
            onChange={(e) => updateFilter(setQ, e.target.value)}
          />
        </FormField>
        <FormField label="Tipo de local">
          <select
            className="commercial-select"
            value={kind}
            onChange={(e) => updateFilter(setKind, e.target.value)}
          >
            <option value="">Todos</option>
            {siteKinds.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="POP do filtro">
          <select
            className="commercial-select"
            value={pop}
            onChange={(e) => updateFilter(setPop, e.target.value)}
          >
            <option value="">Todos</option>
            {pops.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Situação dos locais">
          <select
            className="commercial-select"
            value={status}
            onChange={(e) => updateFilter(setStatus, e.target.value)}
          >
            <option value="active">Ativos</option>
            <option value="archived">Arquivados</option>
            <option value="all">Todos</option>
          </select>
        </FormField>
      </div>
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        <OperationalCatalog
          title="Inventário passivo"
          description={`${result.data?.total ?? 0} local(is) encontrado(s).`}
          columns={["Local", "Tipo", "POP", "Cidade", "Situação"]}
          actions={
            <div className="erp-inline-actions">
              <ActionButton
                disabled={result.isLoading || !!result.error || !result.data}
                onClick={async () => {
                  await download(
                    `/network/sites/export.csv?${params.toString()}`,
                    "locais-infraestrutura-pagina.csv",
                  );
                }}
              >
                Exportar página CSV
              </ActionButton>
              {write && (
                <Button onClick={() => setEditor("create")}>Novo local</Button>
              )}
            </div>
          }
          rows={(result.data?.items ?? []).map((site) => ({
            id: site.id,
            cells: [
              site.name,
              kindLabel(site.kind),
              site.pop_name,
              site.city || "Não informada",
              site.active ? "Ativo" : "Arquivado",
            ],
            actions: (
              <div className="erp-inline-actions">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDetailId(site.id)}
                >
                  Consultar
                </Button>
                {write && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditor(site)}
                    >
                      Editar local
                    </Button>
                    <ActionButton
                      confirm={
                        site.active
                          ? `Arquivar ${site.name}? O histórico será mantido.`
                          : `Reativar ${site.name}?`
                      }
                      onClick={async () => {
                        await api(`/network/sites/${site.id}`, {
                          method: "PATCH",
                          body: { active: !site.active },
                        });
                        await refreshSites();
                      }}
                    >
                      {site.active ? "Arquivar" : "Reativar"}
                    </ActionButton>
                  </>
                )}
              </div>
            ),
          }))}
        />
        <div className="erp-inline-actions">
          <Button
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            Anterior
          </Button>
          <span>
            {result.data?.total && offset < result.data.total
              ? `${offset + 1}–${Math.min(offset + (result.data.items.length || limit), result.data.total)} de ${result.data.total}`
              : result.data?.total
                ? `Atualizando página · ${result.data.total} no total`
                : "0 de 0"}
          </span>
          <Button
            variant="outline"
            disabled={
              offset + limit > 100000 ||
              offset + limit >= (result.data?.total ?? 0)
            }
            onClick={() => setOffset(offset + limit)}
          >
            Próxima
          </Button>
        </div>
      </QueryBoundary>
      {detailId && (
        <RecordEditor
          title="Consultar local"
          initial={{}}
          fields={[]}
          loading={detail.isLoading}
          error={detail.error}
          retry={() => detail.mutate()}
          onClose={() => setDetailId(null)}
          onSubmit={async () => setDetailId(null)}
          submit="Fechar"
          description={
            detail.data
              ? `${kindLabel(detail.data.kind)}: ${detail.data.name} · POP: ${detail.data.pop_name} · Cidade: ${detail.data.city || "Não informada"} · Endereço: ${detail.data.address || "Não informado"} · Coordenadas: ${detail.data.latitude ?? "—"}, ${detail.data.longitude ?? "—"} · Observações: ${detail.data.notes || "Nenhuma"} · ${detail.data.active ? "Ativo" : "Arquivado"}`
              : "Consultando local."
          }
        />
      )}
      {editor && (
        <RecordEditor
          title={editing ? "Editar local" : "Novo local"}
          description="Cadastro passivo, sem atuação na rede."
          initial={{
            pop_id: editing?.pop_id ?? "",
            kind: editing?.kind ?? "pole",
            name: editing?.name ?? "",
            city: editing?.city ?? "",
            address: editing?.address ?? "",
            latitude: editing?.latitude?.toString() ?? "",
            longitude: editing?.longitude?.toString() ?? "",
            notes: editing?.notes ?? "",
          }}
          fields={[
            {
              key: "pop_id",
              label: "POP do local",
              type: "select",
              required: true,
              options: [
                { value: "", label: "Selecione" },
                ...pops
                  .filter((item) => item.active || item.id === editing?.pop_id)
                  .map((item) => ({
                    value: item.id,
                    label: `${item.name}${item.active ? "" : " (inativo)"}`,
                  })),
              ],
            },
            {
              key: "kind",
              label: "Tipo do local",
              type: "select",
              required: true,
              options: siteKinds,
            },
            {
              key: "name",
              label: "Nome do local",
              required: true,
              maxLength: 240,
            },
            { key: "city", label: "Cidade do local", maxLength: 200 },
            { key: "address", label: "Endereço do local", maxLength: 600 },
            {
              key: "latitude",
              label: "Latitude",
              hint: "Opcional; informe junto com a longitude.",
            },
            {
              key: "longitude",
              label: "Longitude",
              hint: "Opcional; informe junto com a latitude.",
            },
            {
              key: "notes",
              label: "Observações",
              type: "textarea",
              maxLength: 1000,
            },
          ]}
          onClose={() => setEditor(null)}
          onSubmit={async (values) => {
            const lat = values.latitude.trim(),
              lon = values.longitude.trim();
            if (Boolean(lat) !== Boolean(lon))
              throw new Error("Informe latitude e longitude juntas.");
            const latitude = lat ? Number(lat) : null,
              longitude = lon ? Number(lon) : null;
            if (
              (latitude !== null &&
                (!Number.isFinite(latitude) ||
                  latitude < -90 ||
                  latitude > 90)) ||
              (longitude !== null &&
                (!Number.isFinite(longitude) ||
                  longitude < -180 ||
                  longitude > 180))
            )
              throw new Error("Coordenadas inválidas.");
            const name = values.name.trim();
            if (Array.from(name).length < 2 || Array.from(name).length > 120)
              throw new Error("O nome deve ter de 2 a 120 caracteres.");
            if (Array.from(values.city.trim()).length > 100)
              throw new Error("A cidade deve ter até 100 caracteres.");
            if (Array.from(values.address.trim()).length > 300)
              throw new Error("O endereço deve ter até 300 caracteres.");
            if (Array.from(values.notes).length > 500)
              throw new Error("As observações devem ter até 500 caracteres.");
            const body = {
              pop_id: values.pop_id,
              kind: values.kind,
              name,
              city: values.city.trim() || null,
              address: values.address.trim() || null,
              latitude,
              longitude,
              notes: values.notes,
            };
            // Avoid reparenting an unchanged inactive POP on ordinary corrections.
            const patch =
              editing && body.pop_id === editing.pop_id
                ? (({ pop_id: _pop, ...rest }) => rest)(body)
                : body;
            await api(
              editing ? `/network/sites/${editing.id}` : "/network/sites",
              { method: editing ? "PATCH" : "POST", body: patch },
            );
            setEditor(null);
            await refreshSites();
          }}
        />
      )}
    </Panel>
  );
}
