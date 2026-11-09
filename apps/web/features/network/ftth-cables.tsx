import { useEffect, useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { useSearchParams } from "react-router-dom";
import { Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { ProfileFacts } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can, sessionScope } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { physicalSitesPageSchema } from "./physical-sites-models";
import {
  cableDetailSchema,
  cableKindLabel,
  cableKinds,
  cablePageSchema,
  endpointFields,
  endpointValue,
  formatMeters,
  formatPathText,
  parsePathText,
  pathLength,
  type Cable,
  type CableDetail,
  type CablePoint,
} from "./ftth-design-models";
import { CableOtdr, useCableRefresh } from "./ftth-otdr";

const limit = 20;
const popSchema = z.array(
  z.object({ id: z.string().uuid(), name: z.string(), active: z.boolean() }),
);
const boxOptionsSchema = z.array(
  z.object({ id: z.string().uuid(), name: z.string() }),
);
export function usePops() {
  const { me } = useSession();
  return useSWR(me ? ["erp-ftth-pops", sessionScope(me)] : null, async () =>
    popSchema.parse(await api("/pops")),
  );
}
const endpointLabel = (cable: Cable, side: "a" | "b") =>
  (side === "a"
    ? (cable.a_box_name ?? cable.a_site_name)
    : (cable.b_box_name ?? cable.b_site_name)) ?? "Sem ponta";

export function FiberCables() {
  const { me } = useSession();
  const write = can(me, "network:write");
  const [params, setParams] = useSearchParams();
  const pops = usePops();
  const refresh = useCableRefresh();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [pop, setPop] = useState("");
  const [status, setStatus] = useState("active");
  const [offset, setOffset] = useState(0);
  const [editor, setEditor] = useState<CableDetail | "create" | null>(null);
  const query = new URLSearchParams({
    status,
    limit: String(limit),
    offset: String(offset),
  });
  if (q) query.set("q", q);
  if (kind) query.set("kind", kind);
  if (pop) query.set("pop_id", pop);
  const result = useSWR(
    ["erp-ftth-cables", query.toString()],
    async ([, search]) =>
      cablePageSchema.parse(await api(`/ftth/cables?${search}`)),
  );
  useEffect(() => {
    if (result.data && offset > 0 && offset >= result.data.total)
      setOffset(
        Math.max(0, Math.ceil(result.data.total / limit) * limit - limit),
      );
  }, [offset, result.data]);
  const filter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setOffset(0);
  };
  const open = (id: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("cabo", id);
      return next;
    });
  const edit = async (id: string) =>
    setEditor(cableDetailSchema.parse(await api(`/ftth/cables/${id}`)));
  return (
    <Panel
      title="Cabos ópticos e traçado"
      description="Projeto cadastral de cabos por POP. O traçado e as fusões registram o projeto; não comprovam a conectividade física."
      action={
        write && <Button onClick={() => setEditor("create")}>Novo cabo</Button>
      }
    >
      <div className="erp-columns">
        <FormField label="Buscar cabos">
          <Input
            value={q}
            maxLength={100}
            onChange={(e) => filter(setQ, e.target.value)}
          />
        </FormField>
        <FormField label="Tipo de cabo do filtro">
          <select
            className="commercial-select"
            value={kind}
            onChange={(e) => filter(setKind, e.target.value)}
          >
            <option value="">Todos</option>
            {cableKinds.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="POP dos cabos">
          <select
            className="commercial-select"
            value={pop}
            onChange={(e) => filter(setPop, e.target.value)}
          >
            <option value="">Todos</option>
            {(pops.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Situação dos cabos">
          <select
            className="commercial-select"
            value={status}
            onChange={(e) => filter(setStatus, e.target.value)}
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
          title="Cabos cadastrados"
          description={`${result.data?.total ?? 0} cabo(s) encontrado(s).`}
          columns={[
            "Cabo",
            "Tipo / fibras",
            "POP",
            "Comprimento",
            "Pontas",
            "Situação",
          ]}
          empty="Nenhum cabo nesta consulta."
          rows={(result.data?.items ?? []).map((cable) => ({
            id: cable.id,
            cells: [
              cable.name,
              `${cableKindLabel(cable.kind)} · ${cable.fiber_count} FO`,
              cable.pop_name,
              formatMeters(cable.declared_length_m ?? cable.computed_length_m),
              `${endpointLabel(cable, "a")} → ${endpointLabel(cable, "b")}`,
              cable.active ? "Ativo" : "Arquivado",
            ],
            actions: (
              <div className="erp-inline-actions">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Ficha do cabo ${cable.name}`}
                  onClick={() => open(cable.id)}
                >
                  Ficha
                </Button>
                {write && (
                  <>
                    <ActionButton
                      label={`Editar cabo ${cable.name}`}
                      onClick={() => edit(cable.id)}
                    >
                      Editar
                    </ActionButton>
                    <ActionButton
                      label={`${cable.active ? "Arquivar" : "Reativar"} cabo ${cable.name}`}
                      confirm={
                        cable.active
                          ? `Arquivar o cabo ${cable.name}? Fusões e medições permanecem no histórico.`
                          : `Reativar o cabo ${cable.name}?`
                      }
                      onClick={async () => {
                        await api(`/ftth/cables/${cable.id}`, {
                          method: "PATCH",
                          body: { active: !cable.active },
                        });
                        await refresh();
                      }}
                    >
                      {cable.active ? "Arquivar" : "Reativar"}
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
            {result.data?.total
              ? `${Math.min(offset + 1, result.data.total)}–${Math.min(offset + limit, result.data.total)} de ${result.data.total}`
              : "0 de 0"}
          </span>
          <Button
            variant="outline"
            disabled={offset + limit >= (result.data?.total ?? 0)}
            onClick={() => setOffset(offset + limit)}
          >
            Próxima
          </Button>
        </div>
      </QueryBoundary>
      {editor && (
        <CableEditor
          cable={editor === "create" ? undefined : editor}
          pops={pops.data ?? []}
          onClose={() => setEditor(null)}
          onDone={async () => {
            setEditor(null);
            await refresh();
          }}
        />
      )}
      {params.get("cabo") && (
        <CableSheet
          id={params.get("cabo")!}
          onClose={() =>
            setParams(
              (previous) => {
                const next = new URLSearchParams(previous);
                next.delete("cabo");
                return next;
              },
              { replace: true },
            )
          }
        />
      )}
    </Panel>
  );
}

function CableEditor({
  cable,
  pops,
  onClose,
  onDone,
}: {
  cable?: CableDetail;
  pops: { id: string; name: string; active: boolean }[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [values, setValues] = useState({
    pop_id: cable?.pop_id ?? "",
    name: cable?.name ?? "",
    kind: cable?.kind ?? "aerial",
    fiber_count: String(cable?.fiber_count ?? 12),
    a: endpointValue(cable?.a_box_id ?? null, cable?.a_site_id ?? null),
    b: endpointValue(cable?.b_box_id ?? null, cable?.b_site_id ?? null),
    path: cable ? formatPathText(cable.path) : "",
    declared: cable?.declared_length_m?.toString() ?? "",
    notes: cable?.notes ?? "",
  });
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((previous) => ({ ...previous, [key]: value }));
  const boxes = useSWR("erp-ftth-box-options", async () =>
    boxOptionsSchema.parse(await api("/ftth/boxes")),
  );
  const sites = useSWR(
    values.pop_id ? ["erp-ftth-site-options", values.pop_id] : null,
    async ([, popId]) =>
      physicalSitesPageSchema.parse(
        await api(`/network/sites?status=active&limit=100&pop_id=${popId}`),
      ),
  );
  let estimate = "Informe ao menos duas coordenadas.";
  try {
    estimate = `Comprimento estimado: ${formatMeters(pathLength(parsePathText(values.path)))} (o servidor recalcula ao salvar).`;
  } catch {
    // O texto ainda incompleto não impede a edição; o envio valida de novo.
  }
  const endpoint = (side: "a" | "b", label: string) => (
    <FormField label={label}>
      <select
        className="commercial-select"
        value={values[side]}
        onChange={(e) => set(side)(e.target.value)}
      >
        <option value="">Sem ponta registrada</option>
        <optgroup label="Caixas ópticas">
          {(boxes.data ?? []).map((box) => (
            <option key={box.id} value={`box:${box.id}`}>
              {box.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Locais do POP">
          {(sites.data?.items ?? []).map((site) => (
            <option key={site.id} value={`site:${site.id}`}>
              {site.name}
            </option>
          ))}
        </optgroup>
      </select>
    </FormField>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>{cable ? "Editar cabo" : "Novo cabo"}</DialogTitle>
          <DialogDescription>
            Traçado por coordenadas; o comprimento é calculado pelo servidor.
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={boxes.isLoading}
          error={boxes.error ?? sites.error}
          retry={() => {
            void boxes.mutate();
            void sites.mutate();
          }}
        >
          <MutationForm
            onCancel={onClose}
            onSubmit={async () => {
              const path: CablePoint[] = parsePathText(values.path);
              const name = values.name.trim();
              if (Array.from(name).length < 2 || Array.from(name).length > 120)
                throw new Error("O nome deve ter de 2 a 120 caracteres.");
              const fibers = Number(values.fiber_count);
              if (!Number.isInteger(fibers) || fibers < 1 || fibers > 288)
                throw new Error("O cabo deve ter de 1 a 288 fibras.");
              const declared = values.declared.trim()
                ? Number(values.declared.replace(",", "."))
                : null;
              if (
                declared !== null &&
                (!Number.isFinite(declared) ||
                  declared <= 0 ||
                  declared > 1000000)
              )
                throw new Error("Informe um comprimento entre 0 e 1.000 km.");
              const body: Record<string, unknown> = {
                pop_id: values.pop_id,
                name,
                kind: values.kind,
                fiber_count: fibers,
                ...endpointFields("a", values.a),
                ...endpointFields("b", values.b),
                path,
                declared_length_m: declared,
                notes: values.notes,
              };
              // Correções comuns não reenviam o POP inalterado (pode estar inativo).
              if (cable && cable.pop_id === values.pop_id) delete body.pop_id;
              await api(cable ? `/ftth/cables/${cable.id}` : "/ftth/cables", {
                method: cable ? "PATCH" : "POST",
                body,
              });
              await onDone();
            }}
          >
            <div className="erp-columns">
              <FormField label="POP do cabo">
                <select
                  className="commercial-select"
                  required
                  value={values.pop_id}
                  onChange={(e) =>
                    setValues((previous) => ({
                      ...previous,
                      pop_id: e.target.value,
                      a: previous.a.startsWith("site:") ? "" : previous.a,
                      b: previous.b.startsWith("site:") ? "" : previous.b,
                    }))
                  }
                >
                  <option value="">Selecione</option>
                  {pops
                    .filter((p) => p.active || p.id === cable?.pop_id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.active ? "" : " (inativo)"}
                      </option>
                    ))}
                </select>
              </FormField>
              <FormField label="Nome do cabo">
                <Input
                  required
                  maxLength={120}
                  value={values.name}
                  onChange={(e) => set("name")(e.target.value)}
                />
              </FormField>
              <FormField label="Tipo do cabo">
                <select
                  className="commercial-select"
                  value={values.kind}
                  onChange={(e) => set("kind")(e.target.value)}
                >
                  {cableKinds.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Número de fibras">
                <Input
                  type="number"
                  min={1}
                  max={288}
                  required
                  value={values.fiber_count}
                  onChange={(e) => set("fiber_count")(e.target.value)}
                />
              </FormField>
              {endpoint("a", "Ponta A do cabo")}
              {endpoint("b", "Ponta B do cabo")}
              <FormField
                label="Comprimento informado (m)"
                hint="Opcional; medida de campo ou do projeto."
              >
                <Input
                  inputMode="decimal"
                  value={values.declared}
                  onChange={(e) => set("declared")(e.target.value)}
                />
              </FormField>
            </div>
            <FormField
              label="Traçado do cabo"
              hint={`Uma coordenada por linha, "latitude, longitude" com ponto decimal; de 2 a 500 pontos. ${estimate}`}
            >
              <Textarea
                required
                rows={6}
                value={values.path}
                onChange={(e) => set("path")(e.target.value)}
              />
            </FormField>
            <FormField label="Observações do cabo">
              <Textarea
                maxLength={500}
                value={values.notes}
                onChange={(e) => set("notes")(e.target.value)}
              />
            </FormField>
          </MutationForm>
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}

export function CablePathDiagram({
  path,
  label,
}: {
  path: CablePoint[];
  label: string;
}) {
  const width = 600,
    height = 260,
    pad = 24;
  const lats = path.map((p) => p.lat),
    lngs = path.map((p) => p.lng);
  const minLat = Math.min(...lats),
    maxLat = Math.max(...lats),
    minLng = Math.min(...lngs),
    maxLng = Math.max(...lngs);
  const correction = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * correction, 0.00001),
    spanY = Math.max(maxLat - minLat, 0.00001);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const x = (p: CablePoint) =>
    width / 2 + (p.lng - (minLng + maxLng) / 2) * correction * scale;
  const y = (p: CablePoint) =>
    height / 2 - (p.lat - (minLat + maxLat) / 2) * scale;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full rounded-lg border bg-muted/20"
      role="img"
      aria-label={label}
    >
      <polyline
        points={path.map((p) => `${x(p)},${y(p)}`).join(" ")}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={3}
        strokeLinejoin="round"
      />
      {[path[0], path[path.length - 1]].map((p, index) => (
        <g key={index}>
          <circle
            cx={x(p)}
            cy={y(p)}
            r={6}
            fill={index ? "var(--info)" : "var(--success)"}
          />
          <text
            x={x(p) + 9}
            y={y(p) + 4}
            fontSize={12}
            fill="var(--foreground)"
          >
            {index ? "B" : "A"}
          </text>
        </g>
      ))}
    </svg>
  );
}

function CableSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const result = useSWR(["erp-ftth-cable", id], async () =>
    cableDetailSchema.parse(await api(`/ftth/cables/${id}`)),
  );
  const c = result.data;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="ticket-sheet">
        <SheetHeader>
          <SheetTitle>{c ? `${c.name} · cabo` : "Ficha do cabo"}</SheetTitle>
          <SheetDescription>
            Traçado, pontas e medições OTDR registrados no projeto.
          </SheetDescription>
        </SheetHeader>
        <div className="sheet-content-body erp-stack">
          <QueryBoundary
            loading={result.isLoading}
            error={result.error}
            retry={() => result.mutate()}
          >
            {c && (
              <>
                <ProfileFacts
                  items={[
                    ["POP", c.pop_name],
                    ["Tipo", cableKindLabel(c.kind)],
                    ["Fibras", c.fiber_count],
                    [
                      "Comprimento calculado",
                      formatMeters(c.computed_length_m),
                    ],
                    [
                      "Comprimento informado",
                      c.declared_length_m == null
                        ? "Não informado"
                        : formatMeters(c.declared_length_m),
                    ],
                    ["Ponta A", endpointLabel(c, "a")],
                    ["Ponta B", endpointLabel(c, "b")],
                    ["Fibras fundidas", c.fusion_count],
                    ["Situação", c.active ? "Ativo" : "Arquivado"],
                  ]}
                />
                <CablePathDiagram
                  path={c.path}
                  label={`Traçado do cabo ${c.name}`}
                />
                <p className="profile-footnote">
                  {c.path.length} ponto(s) · norte para cima · A em verde, B em
                  azul. Desenho do cadastro, sem prova de trajeto físico.
                </p>
                {c.notes && <p className="profile-footnote">{c.notes}</p>}
                <CableOtdr cable={c} />
              </>
            )}
          </QueryBoundary>
        </div>
      </SheetContent>
    </Sheet>
  );
}
