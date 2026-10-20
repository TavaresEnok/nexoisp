import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

// Registra, por verificação, as chamadas à API feitas pelas páginas dos
// cenários. Cada linha impressa por um cenário encerra um trecho: as chamadas
// feitas desde a linha anterior pertencem a ela. Chamadas de preparação via
// context.request não entram, porque não passam pela interface.
const output = new URL("../docs/integracao-v0/evidencias/rastreio/", import.meta.url);
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
let scenario = null;
let pending = new Set();
let steps = [];

const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...options) => {
    const context = await newContext(...options);
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return;
      pending.add(`${request.method()} ${url.pathname.replace(uuid, ":id")}`);
    });
    return context;
  };
  return browser;
};
const log = console.log.bind(console);
console.log = (...args) => {
  const text = args.map(String).join(" ").trim();
  if (scenario && text && pending.size) {
    steps.push({ check: text, requests: [...pending].sort() });
    pending = new Set();
  }
  log(...args);
};

export function begin(name) {
  scenario = name;
  pending = new Set();
  steps = [];
}
export async function end() {
  if (!scenario) return;
  if (pending.size) steps.push({ check: "(sem verificação posterior)", requests: [...pending].sort() });
  await mkdir(output, { recursive: true });
  await writeFile(
    new URL(`${scenario.replace(/\.mjs$/, "")}.json`, output),
    JSON.stringify({ scenario, recorded_at: new Date().toISOString(), steps }, null, 2) + "\n",
  );
  scenario = null;
}
