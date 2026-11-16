import { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Marker,
  Polyline,
  Popup,
  useMap,
  useMapEvents,
  ZoomControl,
} from "react-leaflet";
import { divIcon, latLngBounds } from "leaflet";
import { LocateFixed } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type {
  MapBounds,
  MapCable,
  MapPlacement,
  OperationalMapPoint,
} from "./map";
import styles from "@/components/network-explorer.module.css";
import "leaflet/dist/leaflet.css";
type Props = {
  rows: OperationalMapPoint[];
  selectedId: string | null;
  bounds: MapBounds | null;
  onBounds: (bounds: MapBounds) => void;
  onSelect: (point: OperationalMapPoint) => void;
  placing: MapPlacement | null;
  onPlace: (lat: number, lng: number) => Promise<void>;
  lines?: MapCable[];
  describeLine?: (cable: MapCable) => string;
  onLine?: (cable: MapCable) => void;
};
function MapControls({
  rows,
  selectedId,
  bounds,
  onBounds,
  onPlace,
  placing,
}: Props) {
  const initialFit = useRef(false);
  const busy = useRef(false);
  const map = useMapEvents({
    moveend: () => {
      const b = map.getBounds();
      onBounds({
        south: Math.max(-85, b.getSouth()),
        north: Math.min(85, b.getNorth()),
        west: Math.max(-180, b.getWest()),
        east: Math.min(180, b.getEast()),
      });
    },
    click: async (event) => {
      if (!placing || busy.current) return;
      busy.current = true;
      try {
        await onPlace(
          Number(event.latlng.lat.toFixed(6)),
          Number(event.latlng.lng.toFixed(6)),
        );
        toast.success("Localização gravada no cadastro.");
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        busy.current = false;
      }
    },
  });
  const fit = () => {
    if (rows.length)
      map.fitBounds(latLngBounds(rows.map((p) => [p.lat, p.lng])), {
        padding: [65, 65],
        maxZoom: 16,
      });
    else if (bounds)
      map.fitBounds(
        [
          [bounds.south, bounds.west],
          [bounds.north, bounds.east],
        ],
        { padding: [65, 65], maxZoom: 16 },
      );
    else map.setView([-14.235, -51.9253], 4);
  };
  useEffect(() => {
    if (!initialFit.current && (bounds || rows.length)) {
      initialFit.current = true;
      fit();
    }
  }, [map, bounds, rows]);
  useEffect(() => {
    const selected = rows.find((row) => row.id === selectedId);
    if (selected)
      map.flyTo([selected.lat, selected.lng], 17, { duration: 0.5 });
  }, [map, selectedId]);
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return (
    <div className={styles.recenter}>
      <Button
        variant="outline"
        size="icon"
        aria-label="Centralizar pontos da rede"
        onClick={fit}
      >
        <LocateFixed />
      </Button>
    </div>
  );
}
// Caixa óptica e POP: quadrados neutros (preto no tema claro, branco no escuro). Cliente: círculo verde/cinza (v0).
function squareIcon(size: number, selected: boolean) {
  const s = selected ? size + 4 : size;
  return divIcon({
    className: "",
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
    popupAnchor: [0, -s / 2],
    html: `<span style="display:block;width:${s}px;height:${s}px;border-radius:2px;background:var(--foreground);border:2px solid var(--background);box-shadow:0 0 0 1px var(--foreground)"></span>`,
  });
}
const contractColor = (point: OperationalMapPoint) =>
  point.online ? "var(--success, #22c55e)" : "var(--map-offline, #94a3b8)";

export default function MapCanvas(props: Props) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      <MapContainer
        className={styles.leaflet}
        center={[-14.235, -51.9253]}
        zoom={4}
        zoomControl={false}
        aria-label="Mapa operacional da rede"
      >
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
          // A política de uso do OSM exige o Referer; o painel usa Referrer-Policy same-origin,
          // então só os blocos do mapa enviam a origem do site (sem caminho nem parâmetros).
          referrerPolicy="strict-origin-when-cross-origin"
          attribution="&copy; OpenStreetMap contributors"
          eventHandlers={{ tileerror: () => setFailed(true) }}
        />
        <ZoomControl position="bottomright" />
        <MapControls {...props} />
        {(props.lines ?? []).map((cable) => (
          <Polyline
            key={`cable/${cable.id}`}
            positions={cable.path.map(
              (p) => [p.lat, p.lng] as [number, number],
            )}
            pathOptions={{
              color: "var(--muted-foreground)",
              weight: 3,
              opacity: 0.9,
            }}
          >
            <Popup>
              <div className={styles.popup}>
                <span className={styles.overline}>Cabo óptico</span>
                <strong>{cable.name}</strong>
                <p>{props.describeLine?.(cable)}</p>
                {props.onLine && (
                  <Button size="sm" onClick={() => props.onLine?.(cable)}>
                    Abrir ficha do cabo
                  </Button>
                )}
              </div>
            </Popup>
          </Polyline>
        ))}
        {props.rows.map((point) =>
          point.kind === "contracts" ? (
            <CircleMarker
              key={`${point.kind}/${point.id}`}
              center={[point.lat, point.lng]}
              radius={point.id === props.selectedId ? 9 : 6}
              pathOptions={{
                fillColor: contractColor(point),
                fillOpacity: point.state === "Encerrado" ? 0 : 1,
                color:
                  point.state === "Encerrado"
                    ? "var(--map-offline, #94a3b8)"
                    : "#ffffff",
                weight: 2,
              }}
              eventHandlers={{ click: () => props.onSelect(point) }}
            >
              <Popup>
                <div className={styles.popup}>
                  <span className={styles.overline}>
                    {point.kind === "contracts"
                      ? `${point.online ? "Online" : "Offline"} · ${point.state}`
                      : point.state}
                  </span>
                  <strong>{point.name}</strong>
                  <p>{point.address}</p>
                  <Button size="sm" onClick={() => props.onSelect(point)}>
                    Detalhar ponto
                  </Button>
                </div>
              </Popup>
            </CircleMarker>
          ) : (
            <Marker
              key={`${point.kind}/${point.id}`}
              position={[point.lat, point.lng]}
              icon={squareIcon(
                point.kind === "pops" ? 14 : 10,
                point.id === props.selectedId,
              )}
              zIndexOffset={point.kind === "pops" ? 1000 : 500}
              eventHandlers={{ click: () => props.onSelect(point) }}
            >
              <Popup>
                <div className={styles.popup}>
                  <span className={styles.overline}>{point.state}</span>
                  <strong>{point.name}</strong>
                  <p>{point.address}</p>
                  <Button size="sm" onClick={() => props.onSelect(point)}>
                    Detalhar ponto
                  </Button>
                </div>
              </Popup>
            </Marker>
          ),
        )}
      </MapContainer>
      {failed && (
        <div role="status" className={styles.tileError}>
          Alguns blocos do mapa não carregaram. Os pontos cadastrados continuam
          disponíveis na lista.
        </div>
      )}
    </>
  );
}
