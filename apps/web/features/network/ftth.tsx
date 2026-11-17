import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PageHeading, Panel } from "@/components/workspace-ui";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QueryBoundary } from "@/features/shared/feedback";
import { RecordEditor } from "@/features/shared/record-editor";
import { MutationForm, FormField } from "@/features/shared/form";
import { can } from "@/features/session/model";
import { useSession } from "@/features/session/provider";
import { api } from "@/platform/erp-client";
import { normalize } from "@/lib/format";
import { useDevices } from "./queries";
import { FiberCables } from "./ftth-cables";
import { KmlImport } from "./ftth-kml";
import { boxHref, Kpi, Meter } from "./kit";
const designTabs = [
  ["caixas", "Caixas"],
  ["cabos", "Cabos"],
  ["kml", "Importar KML"],
] as const;
const coordinate = z.coerce.number().nullable();
export const boxSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(["cto", "ceo"]),
  ports: z.coerce.number().int(),
  parent_id: z.string().nullable(),
  parent_name: z.string().nullable(),
  device_id: z.string().nullable(),
  device_name: z.string().nullable(),
  pon_port: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  latitude: coordinate,
  longitude: coordinate,
  used: z.coerce.number(),
  children: z.coerce.number(),
});
export type FiberBox = z.infer<typeof boxSchema>;
const dropSchema = z.object({
  id: z.string().uuid(),
  port: z.number(),
  contract_id: z.string().nullable(),
  subscriber_name: z.string().nullable(),
  note: z.string().nullable(),
});
export const detailSchema = boxSchema.extend({ drops: z.array(dropSchema) });
export function useFiberRefresh() {
  const { mutate } = useSWRConfig();
  return () =>
    mutate(
      (key) =>
        key === "erp-ftth-boxes" ||
        key === "erp-noc" ||
        (Array.isArray(key) &&
          ["erp-ftth-box", "erp-contract-ftth", "erp-map"].includes(key[0])) ||
        key === "erp-ftth-box-page",
    );
}
export function FiberDirectory() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const result = useSWR("erp-ftth-boxes", async () =>
    z.array(boxSchema).parse(await api("/ftth/boxes")),
  );
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState("list");
  const [query, setQuery] = useState("");
  const refresh = useFiberRefresh();
  const write = can(me, "network:write");
  const requested = params.get("aba");
  const tab =
    requested === "cabos" || (requested === "kml" && write)
      ? requested
      : "caixas";
  // Links antigos (?caixa=<id>) abrem a página da caixa.
  const legacy = params.get("caixa");
  useEffect(() => {
    if (legacy) navigate(boxHref(legacy), { replace: true });
  }, [legacy, navigate]);
  const boxes = result.data ?? [];
  const rows = boxes
    .filter((box) =>
      normalize(
        `${box.name} ${box.address ?? ""} ${box.device_name ?? ""} ${box.pon_port ?? ""}`,
      ).includes(normalize(query)),
    )
    .sort(
      (a, b) =>
        Number(a.kind === "cto") - Number(b.kind === "cto") ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  const ctos = boxes.filter((b) => b.kind === "cto");
  const total = ctos.reduce((sum, b) => sum + b.ports, 0);
  const used = ctos.reduce((sum, b) => sum + b.used, 0);
  const full = ctos.filter((b) => b.used >= b.ports).length;
  const changeTab = (value: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === "caixas") next.delete("aba");
      else next.set("aba", value);
      next.delete("cabo");
      return next;
    });
  return (
    <>
      <PageHeading
        title="Planta óptica"
        description="Caixas, cabos e fusões da rede de fibra."
        actions={
          tab === "caixas" &&
          write && <Button onClick={() => setCreating(true)}>Nova caixa</Button>
        }
      />
      <Tabs
        className="view-tabs"
        value={tab}
        onValueChange={(value) => changeTab(String(value))}
      >
        <TabsList variant="line" aria-label="Planta óptica">
          {designTabs
            .filter(([value]) => value !== "kml" || write)
            .map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
        </TabsList>
      </Tabs>
      {tab === "cabos" && <FiberCables />}
      {tab === "kml" && <KmlImport />}
      {tab === "caixas" && (
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          <div className="metrics-grid">
            <Kpi
              label="Caixas"
              value={boxes.length}
              detail={`${ctos.length} CTO · ${boxes.length - ctos.length} CEO`}
            />
            <Kpi
              label="Portas ocupadas"
              value={`${used} / ${total}`}
              detail="Nas CTOs"
            />
            <Kpi
              label="Ocupação"
              value={total ? `${Math.round((used / total) * 100)}%` : "—"}
              detail={<Meter value={used} total={total} label=" " />}
            />
            <Kpi label="CTOs lotadas" value={full} detail="Sem porta livre" />
          </div>
          <Panel
            title="Caixas"
            description={`${rows.length} de ${boxes.length}`}
          >
            <div className="list-toolbar">
              <Tabs
                value={view}
                onValueChange={(value) => setView(String(value))}
              >
                <TabsList variant="line">
                  <TabsTrigger value="list">Lista</TabsTrigger>
                  <TabsTrigger value="map">Esquema</TabsTrigger>
                </TabsList>
              </Tabs>
              <Input
                aria-label="Buscar caixa"
                className="max-w-xs"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Nome, endereço ou PON"
              />
            </div>
            {view === "map" ? (
              <FiberDiagram
                boxes={rows}
                onOpen={(id) => navigate(boxHref(id))}
              />
            ) : rows.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    {["Caixa", "Origem", "Endereço", "Ocupação"].map(
                      (label) => (
                        <TableHead key={label}>{label}</TableHead>
                      ),
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((box) => (
                    <TableRow
                      key={box.id}
                      className="cursor-pointer"
                      onClick={() => navigate(boxHref(box.id))}
                    >
                      <TableCell>
                        <Link
                          className="font-medium hover:underline"
                          to={boxHref(box.id)}
                        >
                          {box.name}
                        </Link>
                        <small className="table-subline">
                          {box.kind === "cto" ? "CTO" : "CEO"}
                          {box.children
                            ? ` · ${box.children} caixa(s) depois`
                            : ""}
                        </small>
                      </TableCell>
                      <TableCell>
                        {box.device_name
                          ? `${box.device_name} · ${box.pon_port ?? "—"}`
                          : "—"}
                        <small className="table-subline">
                          {box.parent_name
                            ? `Depois de ${box.parent_name}`
                            : "Início do ramal"}
                        </small>
                      </TableCell>
                      <TableCell>{box.address || "—"}</TableCell>
                      <TableCell>
                        {box.kind === "cto" ? (
                          <Meter value={box.used} total={box.ports} />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {box.ports} fibras
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="profile-footnote">Nenhuma caixa nesta busca.</p>
            )}
          </Panel>
        </QueryBoundary>
      )}
      {creating && (
        <BoxEditor
          boxes={boxes}
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
    </>
  );
}
export function BoxEditor({
  box,
  boxes,
  onClose,
  onDone,
}: {
  box?: FiberBox;
  boxes: FiberBox[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const devices = useDevices();
  return (
    <RecordEditor
      title={box ? "Editar caixa óptica" : "Nova caixa óptica"}
      loading={devices.isLoading}
      error={devices.error}
      retry={() => devices.mutate()}
      initial={{
        name: box?.name ?? "",
        kind: box?.kind ?? "cto",
        ports: String(box?.ports ?? 8),
        parent_id: box?.parent_id ?? "",
        device_id: box?.device_id ?? "",
        pon_port: box?.pon_port ?? "",
        address: box?.address ?? "",
        notes: box?.notes ?? "",
        latitude: box?.latitude == null ? "" : String(box.latitude),
        longitude: box?.longitude == null ? "" : String(box.longitude),
      }}
      fields={[
        {
          key: "name",
          label: "Identificação da caixa",
          required: true,
          maxLength: 80,
        },
        {
          key: "kind",
          label: "Tipo de caixa",
          type: "select",
          options: [
            { value: "cto", label: "CTO · terminação óptica" },
            { value: "ceo", label: "CEO · emenda óptica" },
          ],
        },
        {
          key: "ports",
          label: "Portas da caixa",
          type: "number",
          required: true,
          min: 1,
          max: 144,
        },
        {
          key: "parent_id",
          label: "Caixa anterior",
          type: "select",
          options: [
            { value: "", label: "Sem caixa anterior" },
            ...boxes
              .filter((b) => b.id !== box?.id)
              .map((b) => ({ value: b.id, label: b.name })),
          ],
        },
        {
          key: "device_id",
          label: "OLT vinculada",
          type: "select",
          options: [
            { value: "", label: "Sem OLT informada" },
            ...(devices.data ?? [])
              .filter((d) => d.driver.startsWith("olt"))
              .map((d) => ({ value: d.id, label: d.name })),
          ],
        },
        {
          key: "pon_port",
          label: "Porta PON da caixa",
          maxLength: 15,
          hint: "Exemplo: 0/1/3",
        },
        { key: "address", label: "Endereço ou referência", maxLength: 200 },
        {
          key: "notes",
          label: "Observações da caixa",
          type: "textarea",
          maxLength: 500,
        },
        { key: "latitude", label: "Latitude da caixa" },
        { key: "longitude", label: "Longitude da caixa" },
      ]}
      onClose={onClose}
      onSubmit={async (values) => {
        if (Boolean(values.latitude) !== Boolean(values.longitude))
          throw new Error("Informe latitude e longitude juntas.");
        const latitude =
          values.latitude === ""
            ? null
            : Number(values.latitude.replace(",", "."));
        const longitude =
          values.longitude === ""
            ? null
            : Number(values.longitude.replace(",", "."));
        if (
          (latitude !== null && !Number.isFinite(latitude)) ||
          (longitude !== null && !Number.isFinite(longitude))
        )
          throw new Error("Informe coordenadas válidas.");
        await api(box ? `/ftth/boxes/${box.id}` : "/ftth/boxes", {
          method: box ? "PATCH" : "POST",
          body: {
            ...values,
            ports: Number(values.ports),
            parent_id: values.parent_id || null,
            device_id: values.device_id || null,
            latitude,
            longitude,
          },
        });
        await onDone();
      }}
    />
  );
}
export function DropEditor({
  boxId,
  port,
  onClose,
  onDone,
}: {
  boxId: string;
  port: number;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [contract, setContract] = useState("");
  const [note, setNote] = useState("");
  const contracts = useSWR(
    query.trim().length >= 2 ? ["erp-ftth-contract-pick", query.trim()] : null,
    ([, q]) =>
      api<{ id: string; subscriber_name: string; plan_name: string }[]>(
        `/contracts?status=active&limit=20&q=${encodeURIComponent(q)}`,
      ),
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
          <DialogTitle>Ocupar porta {port}</DialogTitle>
          <DialogDescription>
            Vincule um contrato ou registre uma reserva com anotação.
          </DialogDescription>
        </DialogHeader>
        <MutationForm
          onCancel={onClose}
          onSubmit={async () => {
            if (!contract && !note.trim())
              throw new Error(
                "Informe uma anotação para a reserva sem contrato.",
              );
            await api(`/ftth/boxes/${boxId}/drops`, {
              body: {
                port,
                contract_id: contract || null,
                note: note.trim() || null,
              },
            });
            await onDone();
          }}
        >
          <FormField label="Buscar contrato para a porta">
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setContract("");
              }}
            />
          </FormField>
          <FormField label="Contrato da porta">
            <select
              className="commercial-select"
              value={contract}
              onChange={(event) => setContract(event.target.value)}
            >
              <option value="">Reserva sem contrato</option>
              {contracts.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.subscriber_name} · {c.plan_name} · {c.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </FormField>
          <QueryBoundary
            loading={contracts.isLoading}
            error={contracts.error}
            retry={() => contracts.mutate()}
          >
            {null}
          </QueryBoundary>
          <FormField
            label="Anotação da porta"
            hint="Obrigatória para reserva sem contrato."
          >
            <Input
              required={!contract}
              maxLength={200}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </FormField>
        </MutationForm>
      </DialogContent>
    </Dialog>
  );
}
export function FiberDiagram({
  boxes,
  onOpen,
}: {
  boxes: FiberBox[];
  onOpen: (id: string) => void;
}) {
  const pts = boxes.filter(
    (box): box is FiberBox & { latitude: number; longitude: number } =>
      box.latitude !== null && box.longitude !== null,
  );
  if (!pts.length)
    return (
      <p className="profile-footnote">
        Nenhuma caixa tem coordenadas. Edite a identificação para informar
        latitude e longitude.
      </p>
    );
  const width = 1000,
    height = 560,
    pad = 60;
  const minLat = Math.min(...pts.map((p) => p.latitude)),
    maxLat = Math.max(...pts.map((p) => p.latitude)),
    minLng = Math.min(...pts.map((p) => p.longitude)),
    maxLng = Math.max(...pts.map((p) => p.longitude));
  const correction = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * correction, 0.00001),
    spanY = Math.max(maxLat - minLat, 0.00001);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const x = (p: (typeof pts)[number]) =>
    width / 2 + (p.longitude - (minLng + maxLng) / 2) * correction * scale;
  const y = (p: (typeof pts)[number]) =>
    height / 2 - (p.latitude - (minLat + maxLat) / 2) * scale;
  const byId = new Map(pts.map((p) => [p.id, p]));
  return (
    <>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full rounded-lg border bg-muted/20"
        role="group"
        aria-label="Esquema das caixas ópticas"
      >
        {pts.map((p) => {
          const parent = p.parent_id ? byId.get(p.parent_id) : null;
          return parent ? (
            <line
              key={`line-${p.id}`}
              x1={x(p)}
              y1={y(p)}
              x2={x(parent)}
              y2={y(parent)}
              stroke="var(--border)"
              strokeWidth={2}
            />
          ) : null;
        })}
        {pts.map((p) => (
          <g
            key={p.id}
            role="button"
            tabIndex={0}
            aria-label={`Portas de ${p.name}`}
            onClick={() => onOpen(p.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(p.id);
              }
            }}
          >
            <title>
              {p.name} · {p.used} de {p.ports} portas ocupadas
            </title>
            {p.kind === "ceo" ? (
              <rect
                x={x(p) - 9}
                y={y(p) - 9}
                width={18}
                height={18}
                fill={
                  p.used >= p.ports ? "var(--destructive)" : "var(--primary)"
                }
              />
            ) : (
              <circle
                cx={x(p)}
                cy={y(p)}
                r={10}
                fill={
                  p.used >= p.ports ? "var(--destructive)" : "var(--primary)"
                }
              />
            )}
            <text
              x={x(p) + 14}
              y={y(p) + 4}
              fontSize={13}
              fill="var(--foreground)"
            >
              {p.name} ({p.used}/{p.ports})
            </text>
          </g>
        ))}
      </svg>
      <p className="profile-footnote">
        Norte para cima · círculo: CTO · quadrado: CEO · linhas indicam a caixa
        anterior e não o trajeto físico do cabo. {boxes.length - pts.length}{" "}
        caixa(s) sem coordenadas fora do desenho. O traçado dos cabos, as fusões
        e as medições OTDR ficam na aba Cabos e na ficha de cada caixa.
      </p>
    </>
  );
}
export function ContractFiber({ id }: { id: string }) {
  const navigate = useNavigate();
  const result = useSWR(["erp-contract-ftth", id], () =>
    api<{
      drop: {
        box_id: string;
        box_name: string;
        port: number;
        device_name: string | null;
        pon_port: string | null;
      } | null;
    }>(`/contracts/${id}/ftth`),
  );
  const drop = result.data?.drop;
  return (
    <ProfileSection title="Rede óptica do contrato">
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {drop ? (
          <ProfileFacts
            items={[
              ["Caixa / porta", `${drop.box_name} · porta ${drop.port}`],
              [
                "OLT / PON",
                `${drop.device_name || "Não informada"} · ${drop.pon_port || "Não informada"}`,
              ],
            ]}
          />
        ) : (
          <p className="profile-footnote">
            Sem porta óptica registrada para este contrato.
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(drop ? boxHref(drop.box_id) : "/rede/ftth")}
        >
          {drop ? "Abrir caixa" : "Planta óptica"}
        </Button>
      </QueryBoundary>
    </ProfileSection>
  );
}
