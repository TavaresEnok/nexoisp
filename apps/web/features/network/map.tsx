import { useState, lazy, Suspense } from "react";
import useSWR from "swr";
import { z } from "zod";
import { Check, Layers, ListFilter, MapPin, Radio, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/workspace-ui";
import { ProfileFacts } from "@/components/subscriber-profile-sections";
import { QueryBoundary } from "@/features/shared/feedback";
import { MutationForm, FormField } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { RecordEditor } from "@/features/shared/record-editor";
import { useSession } from "@/features/session/provider";
import { can, hasModule } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import styles from "@/components/network-explorer.module.css";
import { MapExplorerFrame, MapListPanel } from "@/components/network-explorer";
const MapCanvas = lazy(() => import("./map-canvas"));
const point = z.object({
  id: z.string().uuid(),
  lat: z.coerce.number(),
  lng: z.coerce.number(),
});
const contractPoint = point.extend({
  subscriber_name: z.string(),
  status: z.string(),
  policy: z.string().nullable(),
  address: z.string().nullable(),
});
const simplePoint = point.extend({
  name: z.string(),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  ports: z.number().optional(),
});
const pointsSchema = z.object({
  contracts: z.array(contractPoint).optional(),
  contracts_truncated: z.boolean().optional(),
  boxes: z.array(simplePoint).optional(),
  pops: z.array(simplePoint).optional(),
});
const coverageSchema = z.object({
  contracts: z.object({
    total: z.coerce.number(),
    located: z.coerce.number(),
    south: z.coerce.number().nullable(),
    north: z.coerce.number().nullable(),
    west: z.coerce.number().nullable(),
    east: z.coerce.number().nullable(),
  }),
  boxes: z.object({ total: z.coerce.number(), located: z.coerce.number() }),
  pops: z.object({ total: z.coerce.number(), located: z.coerce.number() }),
});
export type MapBounds = {
  south: number;
  north: number;
  west: number;
  east: number;
};
export type OperationalMapPoint = {
  id: string;
  lat: number;
  lng: number;
  name: string;
  kind: "contracts" | "boxes" | "pops";
  state: string;
  address: string;
};
export type MapPlacement = {
  id: string;
  name: string;
  kind: "contracts" | "pops";
};
export function NetworkMap() {
  const { me } = useSession();
  const navigate = useNavigate();
  const coverage = useSWR("erp-map-coverage", async () =>
    coverageSchema.parse(await api("/map/coverage")),
  );
  const [bounds, setBounds] = useState<MapBounds>({
    south: -85,
    north: 85,
    west: -180,
    east: 180,
  });
  const [layers, setLayers] = useState({
    contracts: true,
    boxes: hasModule(me, "ftth"),
    pops: true,
  });
  const [status, setStatus] = useState("");
  const [list, setList] = useState(false);
  const [selected, setSelected] = useState<OperationalMapPoint | null>(null);
  const [placing, setPlacing] = useState<MapPlacement | null>(null);
  const [coordinate, setCoordinate] = useState<MapPlacement | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const enabled = Object.entries(layers)
    .filter(([, on]) => on)
    .map(([key]) => key)
    .join(",");
  const points = useSWR(
    enabled
      ? [
          "erp-map",
          bounds.south,
          bounds.north,
          bounds.west,
          bounds.east,
          enabled,
          status,
        ]
      : null,
    async () =>
      pointsSchema.parse(
        await api(
          `/map/points?${new URLSearchParams({ ...Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, String(value)])), layers: enabled, ...(status ? { status } : {}) })}`,
        ),
      ),
  );
  const found = useSWR(
    search.length >= 2 ? ["erp-map-contract-pick", search] : null,
    ([, q]) =>
      api<{ id: string; subscriber_name: string; plan_name: string }[]>(
        `/contracts?limit=8&q=${encodeURIComponent(q)}`,
      ),
  );
  const pops = useSWR(can(me, "network:write") ? "erp-map-pops" : null, () =>
    api<{ id: string; name: string }[]>("/pops"),
  );
  const rows: OperationalMapPoint[] = [
    ...(points.data?.contracts ?? []).map((p) => ({
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      name: p.subscriber_name,
      kind: "contracts" as const,
      state:
        p.status === "ended"
          ? "Encerrado"
          : p.policy === "suspended"
            ? "Suspenso"
            : "Vigente",
      address: p.address || "Endereço não informado",
    })),
    ...(points.data?.boxes ?? []).map((p) => ({
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      kind: "boxes" as const,
      state: "Caixa óptica",
      address: p.address || "Endereço não informado",
    })),
    ...(points.data?.pops ?? []).map((p) => ({
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      kind: "pops" as const,
      state: "POP",
      address: p.city || "Cidade não informada",
    })),
  ];
  const refresh = async () => {
    await Promise.all([points.mutate(), coverage.mutate()]);
  };
  const saveLocation = async (
    place: MapPlacement,
    latitude: number | null,
    longitude: number | null,
  ) => {
    await api(`/${place.kind}/${place.id}/location`, {
      method: "PUT",
      body: { latitude, longitude },
    });
    setPlacing(null);
    setCoordinate(null);
    setSelected(null);
    await refresh();
  };
  const canMove = (kind: OperationalMapPoint["kind"]) =>
    kind === "contracts"
      ? can(me, "contracts:write")
      : kind === "pops" && can(me, "network:write");
  const initial = coverage.data?.contracts;
  return (
    <MapExplorerFrame
      description="Localize contratos, caixas ópticas e POPs com coordenadas registradas."
      actions={
        <Button
          size="sm"
          variant="outline"
          onClick={() => navigate("/rede/online")}
        >
          <Radio />
          Online agora
        </Button>
      }
      controls={
        <div className="erp-inline-actions">
          {(["contracts", "boxes", "pops"] as const)
            .filter((key) => key !== "boxes" || hasModule(me, "ftth"))
            .map((key) => (
              <Button
                key={key}
                size="sm"
                variant={layers[key] ? "secondary" : "outline"}
                aria-pressed={layers[key]}
                onClick={() =>
                  setLayers((previous) => ({
                    ...previous,
                    [key]: !previous[key],
                  }))
                }
              >
                {layers[key] ? (
                  <Check data-icon="inline-start" />
                ) : (
                  <Layers data-icon="inline-start" />
                )}
                {
                  {
                    contracts: "Contratos",
                    boxes: "Caixas ópticas",
                    pops: "POPs",
                  }[key]
                }
              </Button>
            ))}
        </div>
      }
      toolbar={
        <>
          <div className={styles.mapCounts}>
            <span>{rows.length} ponto(s) na área consultada</span>
          </div>
          <select
            className="commercial-select"
            aria-label="Situação dos contratos no mapa"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setSelected(null);
            }}
          >
            <option value="">Todas as situações</option>
            <option value="active">Vigentes</option>
            <option value="suspended">Suspensos</option>
            <option value="ended">Encerrados</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setList((value) => !value)}
          >
            <ListFilter data-icon="inline-start" />
            {list ? "Ocultar lista" : "Ver pontos no mapa"}
          </Button>
        </>
      }
      canvas={
        <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
          <MapCanvas
            rows={rows}
            selectedId={selected?.id ?? null}
            bounds={
              initial?.south != null &&
              initial.north != null &&
              initial.west != null &&
              initial.east != null
                ? {
                    south: initial.south,
                    north: initial.north,
                    west: initial.west,
                    east: initial.east,
                  }
                : null
            }
            onBounds={setBounds}
            onSelect={setSelected}
            placing={placing}
            onPlace={async (lat, lng) => {
              if (placing) await saveLocation(placing, lat, lng);
            }}
          />
        </Suspense>
      }
      list={
        <>
          {list && (
            <MapListPanel
              heading={`${rows.length} ponto(s)`}
              label="Pontos da rede encontrados"
              closeLabel="Fechar lista de pontos"
              onClose={() => setList(false)}
            >
              {rows.map((row) => (
                <button
                  key={`${row.kind}/${row.id}`}
                  className={styles.locationRow}
                  onClick={() => setSelected(row)}
                >
                  <MapPin size={15} />
                  <span>
                    <strong>{row.name}</strong>
                    <small>{row.state}</small>
                    <small>{row.address}</small>
                  </span>
                </button>
              ))}
            </MapListPanel>
          )}
        </>
      }
      overlay={
        <>
          {placing && (
            <div className={styles.legend}>
              <span>Clique no mapa para posicionar {placing.name}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPlacing(null)}
              >
                Cancelar posicionamento
              </Button>
            </div>
          )}
        </>
      }
      footer={
        <>
          <span>Arraste para mover · use + e − para aproximar</span>
          <span>Coordenadas cadastradas · sem geocodificação automática</span>
        </>
      }
    >
      <QueryBoundary
        loading={points.isLoading}
        error={points.error}
        retry={() => points.mutate()}
      >
        {points.data?.contracts_truncated && (
          <p role="status">
            Mais de 3.000 contratos nesta área. Aproxime o mapa para consultar
            os demais.
          </p>
        )}
      </QueryBoundary>
      <QueryBoundary
        loading={coverage.isLoading}
        error={coverage.error}
        retry={() => coverage.mutate()}
      >
        {coverage.data && (
          <Panel title="Cobertura geográfica">
            <ProfileFacts
              items={[
                [
                  "Contratos vigentes localizados",
                  `${coverage.data.contracts.located} / ${coverage.data.contracts.total}`,
                ],
                [
                  "Caixas localizadas",
                  `${coverage.data.boxes.located} / ${coverage.data.boxes.total}`,
                ],
                [
                  "POPs localizados",
                  `${coverage.data.pops.located} / ${coverage.data.pops.total}`,
                ],
              ]}
            />
          </Panel>
        )}
      </QueryBoundary>
      {selected && (
        <Panel
          title={selected.name}
          description={selected.address}
          action={
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              Fechar ponto
            </Button>
          }
        >
          <Badge variant="outline">{selected.state}</Badge>
          <ProfileFacts
            items={[
              ["Latitude", selected.lat],
              ["Longitude", selected.lng],
            ]}
          />
          <div className="erp-inline-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                navigate(
                  selected.kind === "contracts"
                    ? `/contratos?contrato=${selected.id}`
                    : selected.kind === "boxes"
                      ? `/rede/ftth/fttx-cto?caixa=${selected.id}`
                      : "/pops",
                )
              }
            >
              Abrir cadastro do ponto
            </Button>
            {canMove(selected.kind) && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setPlacing({
                      id: selected.id,
                      name: selected.name,
                      kind: selected.kind as "contracts" | "pops",
                    })
                  }
                >
                  Mover ponto no mapa
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setCoordinate({
                      id: selected.id,
                      name: selected.name,
                      kind: selected.kind as "contracts" | "pops",
                    })
                  }
                >
                  Informar coordenadas do ponto
                </Button>
                <ActionButton
                  danger
                  confirm="Remover as coordenadas deste registro? O cadastro e seus vínculos permanecem."
                  onClick={() =>
                    saveLocation(
                      {
                        id: selected.id,
                        name: selected.name,
                        kind: selected.kind as "contracts" | "pops",
                      },
                      null,
                      null,
                    )
                  }
                >
                  Remover localização
                </ActionButton>
              </>
            )}
          </div>
        </Panel>
      )}
      {(can(me, "contracts:write") || can(me, "network:write")) && (
        <Panel
          title="Posicionar registros"
          description="Selecione um contrato ou POP e clique no mapa, ou informe coordenadas exatas."
        >
          {can(me, "contracts:write") && (
            <>
              <MutationForm
                submit="Buscar contrato no mapa"
                onSubmit={async () => {
                  if (query.trim().length < 2)
                    throw new Error("Digite pelo menos dois caracteres.");
                  setSearch(query.trim());
                }}
              >
                <FormField label="Buscar instalação para posicionar">
                  <Input
                    maxLength={80}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </FormField>
              </MutationForm>
              <QueryBoundary
                loading={found.isLoading}
                error={found.error}
                retry={() => found.mutate()}
              >
                {found.data?.map((contract) => (
                  <div className="erp-contract-card" key={contract.id}>
                    <strong>
                      {contract.subscriber_name} · {contract.plan_name}
                    </strong>
                    <div className="erp-inline-actions">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setPlacing({
                            id: contract.id,
                            name: contract.subscriber_name,
                            kind: "contracts",
                          })
                        }
                      >
                        Posicionar contrato no mapa
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setCoordinate({
                            id: contract.id,
                            name: contract.subscriber_name,
                            kind: "contracts",
                          })
                        }
                      >
                        Informar coordenadas do contrato
                      </Button>
                    </div>
                  </div>
                ))}
              </QueryBoundary>
            </>
          )}
          {can(me, "network:write") && (
            <QueryBoundary
              loading={pops.isLoading}
              error={pops.error}
              retry={() => pops.mutate()}
            >
              {pops.data?.map((pop) => (
                <div key={pop.id} className="erp-contract-card">
                  <strong>{pop.name}</strong>
                  <div className="erp-inline-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPlacing({ id: pop.id, name: pop.name, kind: "pops" })
                      }
                    >
                      Posicionar POP no mapa
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setCoordinate({
                          id: pop.id,
                          name: pop.name,
                          kind: "pops",
                        })
                      }
                    >
                      Informar coordenadas do POP
                    </Button>
                  </div>
                </div>
              ))}
            </QueryBoundary>
          )}
        </Panel>
      )}
      <p className={styles.source}>
        Os blocos de fundo são solicitados ao OpenStreetMap e revelam a região
        visualizada. Cadastros permanecem entre o navegador e o NexoISP.
        Coordenadas não comprovam caminho físico da fibra ou conectividade
        atual.
      </p>
      {coordinate && (
        <RecordEditor
          title="Coordenadas do registro"
          description={coordinate.name}
          initial={{ latitude: "", longitude: "" }}
          fields={[
            { key: "latitude", label: "Latitude do registro", required: true },
            {
              key: "longitude",
              label: "Longitude do registro",
              required: true,
            },
          ]}
          onClose={() => setCoordinate(null)}
          onSubmit={async (values) => {
            const lat = Number(values.latitude.replace(",", ".")),
              lng = Number(values.longitude.replace(",", "."));
            if (
              !Number.isFinite(lat) ||
              !Number.isFinite(lng) ||
              lat < -90 ||
              lat > 90 ||
              lng < -180 ||
              lng > 180
            )
              throw new Error("Informe latitude e longitude válidas.");
            await saveLocation(coordinate, lat, lng);
          }}
        />
      )}
    </MapExplorerFrame>
  );
}
