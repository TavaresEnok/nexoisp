"use client";

import { useEffect, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap, ZoomControl } from "react-leaflet";
import { latLngBounds } from "leaflet";
import { LocateFixed, Layers, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hasLocation, type NetworkSubscriber } from "@/lib/network-query";
import { useWorkspace } from "@/features/workspace/context";
import "leaflet/dist/leaflet.css";
import styles from "./network-explorer.module.css";

function ViewControls({ rows, selectedId }: { rows: NetworkSubscriber[]; selectedId: string | null }) {
  const map = useMap();
  const located = rows.filter(hasLocation);
  const fit = () => { if (located.length) map.fitBounds(latLngBounds(located.map(s => [s.access.latitude, s.access.longitude])), { padding: [65, 65], maxZoom: 16 }); else map.setView([-14.235, -51.9253], 4); };
  const signature = located.map(s => `${s.id}:${s.access.latitude}:${s.access.longitude}`).join("|");
  useEffect(() => { fit(); }, [map, signature]);
  useEffect(() => { const selected = located.find(s => s.id === selectedId); if (selected) map.flyTo([selected.access.latitude, selected.access.longitude], 17, { duration: .5 }); }, [map, selectedId, signature]);
  useEffect(() => { const observer = new ResizeObserver(() => map.invalidateSize()); observer.observe(map.getContainer()); return () => observer.disconnect(); }, [map]);
  return <div className={styles.recenter}><Button variant="outline" size="icon" onClick={fit} aria-label="Centralizar instalações"><LocateFixed /></Button></div>;
}

export default function NetworkLeafletMap({ rows, selectedId }: { rows: NetworkSubscriber[]; selectedId: string | null }) {
  const { openSubscriber } = useWorkspace();
  const [satellite, setSatellite] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/${satellite ? "World_Imagery" : "World_Street_Map"}/MapServer/tile/{z}/{y}/{x}`;
  return <><MapContainer className={styles.leaflet} center={[-14.235, -51.9253]} zoom={4} zoomControl={false} aria-label="Mapa das instalações de clientes"><TileLayer key={url} url={url} maxZoom={19} attribution={satellite ? 'Tiles &copy; Esri, Maxar, Earthstar Geographics' : 'Tiles &copy; Esri, HERE, Garmin, USGS &middot; &copy; OpenStreetMap contributors'} eventHandlers={{ tileerror: () => setFailed(true) }} /><ZoomControl position="bottomright" /><ViewControls rows={rows} selectedId={selectedId} />{rows.filter(hasLocation).map(s => <CircleMarker key={s.id} center={[s.access.latitude, s.access.longitude]} radius={selectedId === s.id ? 10 : 7} pathOptions={{ fillColor: s.connection === "Online" ? "#22c55e" : "#94a3b8", fillOpacity: 1, color: "#ffffff", weight: 2 }}><Popup><div className={styles.popup}><span className={styles.overline}>{s.connection === "Online" ? "ONLINE" : "OFFLINE"} · {s.code}</span><strong>{s.name}</strong><p><MapPin size={13} />{s.address}</p><dl><div><dt>Plano</dt><dd>{s.plan}</dd></div><div><dt>POP</dt><dd>{s.pop}</dd></div><div><dt>Login</dt><dd>{s.access.login || "Não informado"}</dd></div></dl><Button size="sm" onClick={() => openSubscriber(s.id)}>Abrir assinante</Button></div></Popup></CircleMarker>)}</MapContainer><div className={styles.layerControl}><Button variant="outline" size="sm" onClick={() => { setFailed(false); setSatellite(v => !v); }}><Layers data-icon="inline-start" />{satellite ? "Ver mapa" : "Satélite"}</Button></div>{failed && <div className={styles.tileError} role="status">Alguns blocos do mapa não carregaram. Verifique a conexão ou troque a camada.</div>}</>;
}
