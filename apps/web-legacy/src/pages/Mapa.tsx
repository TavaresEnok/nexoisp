import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLoad } from '../api';
import { Badge, Card, Page, toast, toastError } from '../ui';

/**
 * Mapa da operação: contratos, caixas ópticas e POPs. Blocos do OpenStreetMap, sem biblioteca de terceiros no painel.
 * Os blocos são pedidos ao servidor do OpenStreetMap pelo navegador de quem abre a tela (ele vê a região consultada);
 * os dados dos assinantes só trafegam entre o painel e o NexoISP.
 */
const TILE = 256;
const world = (lat: number, lng: number, z: number) => {
  const n = TILE * 2 ** z, s = Math.sin((lat * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
};
const unworld = (x: number, y: number, z: number) => {
  const n = TILE * 2 ** z;
  return { lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI, lng: (x / n) * 360 - 180 };
};
const STATE: Record<string, [string, string]> = { active: ['Ativo', 'green'], suspended: ['Suspenso', 'amber'], ended: ['Encerrado', 'gray'] };
const stateOf = (p: any) => (p.status === 'ended' ? 'ended' : p.policy === 'suspended' ? 'suspended' : 'active');

export function Mapa() {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [view, setView] = useState({ lat: -14.2, lng: -51.9, z: 4 });
  const [layers, setLayers] = useState({ contracts: true, boxes: true, pops: true });
  const [status, setStatus] = useState('');
  const [pts, setPts] = useState<any>({});
  const [sel, setSel] = useState<any>(null);
  const [place, setPlace] = useState<{ id: string; label: string; kind: 'contracts' | 'pops' } | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const cov = useLoad<any>('/map/coverage');
  const pops = useLoad<any[]>('/pops');
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [fitted, setFitted] = useState(false);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  // abre no retângulo que contém o que já foi posicionado
  useEffect(() => {
    const k = cov.data?.contracts;
    if (fitted || !k || k.south == null) return;
    setFitted(true);
    const lat = (k.south + k.north) / 2, lng = (k.west + k.east) / 2;
    const span = Math.max(k.north - k.south, (k.east - k.west) * 0.6, 0.002);
    setView({ lat, lng, z: Math.max(3, Math.min(17, Math.floor(Math.log2(360 / (span * 1.4))) - 1)) });
  }, [cov.data, fitted]);

  const c0 = world(view.lat, view.lng, view.z);
  const toScreen = (lat: number, lng: number) => { const p = world(lat, lng, view.z); return { x: p.x - c0.x + size.w / 2, y: p.y - c0.y + size.h / 2 }; };
  const bounds = useCallback(() => {
    const a = unworld(c0.x - size.w / 2, c0.y - size.h / 2, view.z), b = unworld(c0.x + size.w / 2, c0.y + size.h / 2, view.z);
    return { north: a.lat, west: a.lng, south: b.lat, east: b.lng };
  }, [c0.x, c0.y, size.w, size.h, view.z]);

  const key = JSON.stringify([view, size, layers, status]);
  useEffect(() => {
    const t = setTimeout(async () => {
      const b = bounds();
      const on = Object.entries(layers).filter(([, v]) => v).map(([k]) => k).join(',');
      if (!on) return setPts({});
      try {
        setPts(await api(`/map/points?south=${b.south}&north=${b.north}&west=${b.west}&east=${b.east}&layers=${on}${status ? `&status=${status}` : ''}`));
      } catch (e) { toastError(e); }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const zoomAt = (dz: number) => setView((v) => ({ ...v, z: Math.max(2, Math.min(19, v.z + dz)) }));
  const tiles: { x: number; y: number; tx: number; ty: number }[] = [];
  {
    const n = 2 ** view.z, x0 = Math.floor((c0.x - size.w / 2) / TILE), x1 = Math.floor((c0.x + size.w / 2) / TILE);
    const y0 = Math.max(0, Math.floor((c0.y - size.h / 2) / TILE)), y1 = Math.min(n - 1, Math.floor((c0.y + size.h / 2) / TILE));
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++)
      tiles.push({ tx: ((tx % n) + n) % n, ty, x: tx * TILE - c0.x + size.w / 2, y: ty * TILE - c0.y + size.h / 2 });
  }

  const search = async () => {
    if (q.trim().length < 2) return;
    try { setFound(await api(`/contracts?q=${encodeURIComponent(q.trim())}&limit=8`)); } catch (e) { toastError(e); }
  };
  const clickMap = async (e: React.MouseEvent) => {
    if (drag.current?.moved || !place || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const p = unworld(c0.x - size.w / 2 + (e.clientX - r.left), c0.y - size.h / 2 + (e.clientY - r.top), view.z);
    const body = { latitude: Number(p.lat.toFixed(6)), longitude: Number(p.lng.toFixed(6)) };
    try {
      await api(`/${place.kind}/${place.id}/location`, { method: 'PUT', body });
      toast(`${place.label} posicionado em ${body.latitude}, ${body.longitude}`);
      setPlace(null); cov.reload(); setPts((x: any) => ({ ...x })); setFitted(true);
      setView((v) => ({ ...v }));
    } catch (er) { toastError(er); }
  };

  const dot = (cls: string, p: { lat: number; lng: number }, onClick: () => void, label: string) => {
    const s = toScreen(p.lat, p.lng);
    if (s.x < -10 || s.y < -10 || s.x > size.w + 10 || s.y > size.h + 10) return null;
    return <button key={`${cls}${label}${p.lat}${p.lng}`} className={`map-dot ${cls}`} style={{ left: s.x, top: s.y }} aria-label={label} title={label}
      onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) onClick(); }} />;
  };

  const k = cov.data?.contracts;
  return (
    <Page title="Mapa" sub="Contratos, caixas ópticas e POPs. Arraste para mover, role para aproximar.">
      <div className="map-layout">
        <div>
          <div className="row" style={{ marginBottom: 8 }}>
            {([['contracts', 'Contratos'], ['boxes', 'Caixas ópticas'], ['pops', 'POPs']] as const).map(([id, l]) => (
              <label key={id} className="check"><input type="checkbox" checked={layers[id]} onChange={(e) => setLayers({ ...layers, [id]: e.target.checked })} />{l}</label>))}
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação do contrato">
              <option value="">Todas as situações</option><option value="active">Ativos</option><option value="suspended">Suspensos</option><option value="ended">Encerrados</option>
            </select>
          </div>
          <div ref={box} className={`map ${place ? 'placing' : ''}`}
            onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => {
              const d = drag.current; if (!d) return;
              const dx = e.clientX - d.x, dy = e.clientY - d.y;
              if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
              d.moved = true; d.x = e.clientX; d.y = e.clientY;
              const p = unworld(c0.x - dx, c0.y - dy, view.z);
              setView((v) => ({ ...v, lat: Math.max(-85, Math.min(85, p.lat)), lng: p.lng }));
            }}
            onPointerUp={() => setTimeout(() => { drag.current = null; }, 0)}
            onWheel={(e) => zoomAt(e.deltaY < 0 ? 1 : -1)}
            onClick={clickMap}>
            {tiles.map((t) => <img key={`${view.z}/${t.tx}/${t.ty}/${t.x}`} className="tile" alt="" draggable={false} referrerPolicy="no-referrer"
              src={`https://tile.openstreetmap.org/${view.z}/${t.tx}/${t.ty}.png`} style={{ left: t.x, top: t.y }} />)}
            {pts.boxes?.map((b: any) => dot('box', b, () => setSel({ kind: 'box', ...b }), `Caixa ${b.name}`))}
            {pts.pops?.map((p: any) => dot('pop', p, () => setSel({ kind: 'pop', ...p }), `POP ${p.name}`))}
            {pts.contracts?.map((p: any) => dot(`ct ${stateOf(p)}`, p, () => setSel({ kind: 'contract', ...p }), p.subscriber_name))}
            <div className="map-zoom">
              <button onClick={(e) => { e.stopPropagation(); zoomAt(1); }} aria-label="Aproximar">+</button>
              <button onClick={(e) => { e.stopPropagation(); zoomAt(-1); }} aria-label="Afastar">−</button>
            </div>
            <div className="map-attr">© colaboradores do <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></div>
            {place && <div className="map-hint">Clique no mapa para posicionar: <b>{place.label}</b> <button className="sm" onClick={(e) => { e.stopPropagation(); setPlace(null); }}>Cancelar</button></div>}
          </div>
          {pts.contracts_truncated && <div className="state small">Há mais de 3.000 contratos nesta área; aproxime o mapa para ver todos.</div>}
        </div>
        <div>
          <Card title="Cobertura">
            {k ? (<>
              <div>{k.located} de {k.total} contratos ativos com localização.</div>
              <div className="small muted">Caixas ópticas: {cov.data.boxes.located}/{cov.data.boxes.total} · POPs: {cov.data.pops.located}/{cov.data.pops.total}</div>
            </>) : '…'}
          </Card>
          {sel && (
            <Card title={sel.kind === 'contract' ? sel.subscriber_name : sel.name} actions={<button className="sm" onClick={() => setSel(null)}>Fechar</button>}>
              {sel.kind === 'contract' && (<>
                <Badge tone={STATE[stateOf(sel)][1] as any}>{STATE[stateOf(sel)][0]}</Badge>
                <div className="small" style={{ margin: '8px 0' }}>{sel.address || 'sem endereço de instalação'}</div>
                <div className="row">
                  <Link className="btn sm" to={`/contratos/${sel.id}`}>Abrir contrato</Link>
                  <button className="sm" onClick={() => setPlace({ id: sel.id, label: sel.subscriber_name, kind: 'contracts' })}>Mover</button>
                </div>
              </>)}
              {sel.kind === 'box' && <div className="small">{sel.kind === 'box' && (sel.ports ? `${sel.ports} portas` : '')}{sel.address ? ` · ${sel.address}` : ''}<div><Link to="/ftth">Abrir rede óptica</Link></div></div>}
              {sel.kind === 'pop' && <div className="small">{sel.city ?? ''}<div><button className="sm" onClick={() => setPlace({ id: sel.id, label: `POP ${sel.name}`, kind: 'pops' })}>Mover</button></div></div>}
            </Card>
          )}
          <Card title="Posicionar">
            <div className="small muted" style={{ marginBottom: 6 }}>Procure o contrato (nome ou CPF/CNPJ) e clique no mapa onde fica a instalação.</div>
            <div className="row"><input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="Nome do assinante" aria-label="Procurar contrato" /><button className="sm" onClick={search}>Buscar</button></div>
            {found.map((c) => (
              <div key={c.id} className="row" style={{ marginTop: 6, justifyContent: 'space-between' }}>
                <span className="small">{c.subscriber_name}{c.latitude != null ? ' ✓' : ''}</span>
                <button className="sm" onClick={() => { setPlace({ id: c.id, label: c.subscriber_name, kind: 'contracts' }); setSel(null); }}>Posicionar</button>
              </div>))}
            <div className="small muted" style={{ marginTop: 10 }}>POPs:</div>
            {pops.data?.filter((p) => p.active).map((p) => (
              <div key={p.id} className="row" style={{ marginTop: 4, justifyContent: 'space-between' }}>
                <span className="small">{p.name}</span>
                <button className="sm" onClick={() => setPlace({ id: p.id, label: `POP ${p.name}`, kind: 'pops' })}>Posicionar</button>
              </div>))}
          </Card>
        </div>
      </div>
    </Page>
  );
}
