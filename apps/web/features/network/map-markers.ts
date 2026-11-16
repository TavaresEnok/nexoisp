// Marcadores do mapa operacional: forma = tipo, cor = situação. Usado pelo mapa (Leaflet) e pela legenda,
// para os dois ficarem idênticos. Sem dependência do Leaflet (a legenda carrega antes do mapa).
// Ícones: desenhos do lucide (ISC), os mesmos da interface.

export const MAP_COLORS = {
  online: "#15803d",
  offline: "#dc2626",
  suspended: "#d97706",
  ended: "#6b7280",
  box: "#1d4ed8",
  pop: "#111827",
  cable: "#1d4ed8",
} as const;

export type ContractState = "online" | "offline" | "suspended" | "ended";

const BOX_GLYPH =
  '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>';
const POP_GLYPH =
  '<path d="M10 12h4"/><path d="M10 8h4"/><path d="M14 21v-3a2 2 0 0 0-4 0v3"/><path d="M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2"/><path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/>';

const shadow = "box-shadow:0 1px 4px rgba(0,0,0,.45)";

/** Cliente: círculo sólido com borda branca; encerrado fica vazado. */
export function contractMarkerHtml(state: ContractState, size: number): string {
  const fill = state === "ended" ? "#ffffff" : MAP_COLORS[state];
  const border = state === "ended" ? MAP_COLORS.ended : "#ffffff";
  return `<div style="box-sizing:border-box;width:${size}px;height:${size}px;border-radius:50%;background:${fill};border:2.5px solid ${border};${shadow}"></div>`;
}

/** Caixa óptica e POP: quadrado sólido com ícone branco; POP é maior e escuro. */
export function infraMarkerHtml(kind: "boxes" | "pops", size: number): string {
  const glyph = kind === "pops" ? POP_GLYPH : BOX_GLYPH;
  const bg = kind === "pops" ? MAP_COLORS.pop : MAP_COLORS.box;
  const icon = Math.round(size * 0.62);
  return `<div style="box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:6px;background:${bg};border:2px solid #ffffff;${shadow}"><svg xmlns="http://www.w3.org/2000/svg" width="${icon}" height="${icon}" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></div>`;
}
