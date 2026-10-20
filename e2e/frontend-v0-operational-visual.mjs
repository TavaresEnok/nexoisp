import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { csrf } from "./csrf.mjs";

// Prova visual das telas conectadas (achado D2 da auditoria independente).
//
// 1. Estrutura: para cada tela com par na demonstração do v0, mede a fração das
//    classes da página original (CSS global, CSS Modules e utilitários dos
//    componentes do v0) que também aparecem na tela conectada. O valor medido
//    fica em estrutura.json como piso; uma queda acima da tolerância reprova.
//    O recorte das classes definidas em src/globals.css é registrado à parte.
// 2. Regressão: captura as telas conectadas num provedor próprio, com relógio do
//    navegador fixo, datas da API normalizadas e códigos derivados de UUID
//    mascarados, e compara pixel a pixel com as referências (até 0,05% de
//    pixels alterados, margem para antisserrilhamento). Isso prova
//    estabilidade visual da operação; não prova igualdade pixel a pixel com o
//    v0, porque os dados são outros. A igualdade com o v0 original é provada
//    para a demonstração em frontend-v0-visual.mjs.
const base = process.env.BASE;
assert.ok(
  base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base),
  "Informe BASE com a URL local do laboratório descartável.",
);
const update = process.env.UPDATE_V0_OPERATIONAL_VISUAL === "1";
const root = new URL("./visual-baselines/operacional/", import.meta.url);
const screens = new URL("./telas/", root);
const output = new URL(
  "../docs/integracao-v0/evidencias/visual-operacional/",
  import.meta.url,
);
await mkdir(output, { recursive: true });
await mkdir(screens, { recursive: true });

const css = await readFile(
  new URL("../apps/web/src/globals.css", import.meta.url),
  "utf8",
);
const vocabulary = [
  ...new Set(
    [...css.matchAll(/\.(-?[a-z][a-z0-9-]*)(?=[\s,.:{>[)])/g)].map((m) => m[1]),
  ),
];
const tolerance = 0.05;
const clock = new Date("2026-10-17T15:00:00Z");

// Telas comparadas lado a lado com o v0 na revisão de 20/10/2026.
const pairs = [
  ["inicio", "/", "/"],
  ["assinantes", "/assinantes", "/assinantes"],
  ["ficha", "/assinantes?ficha=sub-1", "/assinantes?ficha={SUB}"],
  ["ficha-cadastro", "/assinantes?ficha=sub-1&abaFicha=cadastro", "/assinantes?ficha={SUB}&abaFicha=cadastro"],
  ["ficha-financeiro", "/assinantes?ficha=sub-1&abaFicha=financeiro", "/assinantes?ficha={SUB}&abaFicha=financeiro"],
  ["ficha-conexao", "/assinantes?ficha=sub-1&abaFicha=conexao", "/assinantes?ficha={SUB}&abaFicha=conexao"],
  ["ficha-atendimento", "/assinantes?ficha=sub-1&abaFicha=atendimento", "/assinantes?ficha={SUB}&abaFicha=atendimento"],
  ["ficha-historico", "/assinantes?ficha=sub-1&abaFicha=historico", "/assinantes?ficha={SUB}&abaFicha=historico"],
  ["contratos", "/contratos", "/contratos"],
  ["planos", "/planos", "/planos"],
  ["faturas", "/financeiro/faturas", "/financeiro/faturas"],
  ["atendimentos", "/atendimentos", "/atendimentos"],
  ["ordens", "/ordens-de-servico", "/ordens-de-servico"],
  ["rede", "/rede/equipamentos", "/rede/equipamentos"],
  ["online", "/rede/online", "/rede/online"],
  ["mapa", "/rede/mapa", "/rede/mapa"],
  ["ftth", "/rede/ftth/fttx-cto", "/rede/ftth"],
  ["ipam", "/rede/enderecos-ip", "/rede/enderecos-ip"],
  ["cgnat", "/rede/enderecos-ip/planos-de-cgnat", "/rede/enderecos-ip/planos-de-cgnat"],
  ["consulta-ip", "/rede/consulta-ip", "/rede/consulta-ip"],
  ["configuracoes", "/configuracoes", "/configuracoes"],
];
// Telas sem par na demonstração: só regressão.
const operationalOnly = [
  ["contrato", "/contratos?contrato={CONTRACT}"],
  ["prospectos", "/prospectos"],
  ["agenda", "/agenda"],
  ["estoque", "/estoque"],
  ["usuarios", "/administracao/usuarios"],
  ["politica", "/financeiro/politica-de-cobranca"],
  ["noc", "/noc"],
  ["conta", "/conta"],
];
// Uma tela por área em tema escuro e no celular.
const areas = [
  ["faturas", "/financeiro/faturas"],
  ["ordens", "/ordens-de-servico"],
  ["rede", "/rede/equipamentos"],
  ["atendimentos", "/atendimentos"],
  ["usuarios", "/administracao/usuarios"],
  ["assinantes", "/assinantes"],
];

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const contexts = [];
const errors = [];
const structure = [];
const visuals = [];
async function context(options = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    timezoneId: "America/Fortaleza",
    locale: "pt-BR",
    reducedMotion: "reduce",
    ...options,
  });
  contexts.push(ctx);
  return ctx;
}
async function json(res) {
  assert.ok(res.ok(), `${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}
async function command(ctx, path, body, method = "POST") {
  return json(
    await ctx.request.fetch(`${base}/api${path}`, {
      method,
      data: body,
      headers: await csrf(ctx, base),
    }),
  );
}
const inspect = async (ctx, path) =>
  json(await ctx.request.get(`${base}/api${path}`));

// Provedor exclusivo da prova visual; reaproveitado quando já existe no harness.
async function dataset() {
  const operator = await context();
  await command(operator, "/auth/login", {
    email: "operador@nexoisp.demo",
    password: "demo1234",
  });
  const slug = "visual-v0";
  const email = "admin@visual-v0.invalid";
  const password = "validacao-visual-1234";
  let tenant = (await inspect(operator, "/tenants")).find((t) => t.slug === slug);
  if (!tenant) {
    await command(operator, "/tenants", {
      name: "Provedor Visual",
      slug,
      admin_name: "Administração Visual",
      admin_email: email,
      admin_password: password,
    });
    tenant = (await inspect(operator, "/tenants")).find((t) => t.slug === slug);
  }
  await command(
    operator,
    `/tenants/${tenant.id}`,
    { modules: ["crm", "field", "ipam", "ftth", "olt", "noc", "api", "notices", "messages"] },
    "PATCH",
  );
  const admin = await context();
  await command(admin, "/auth/login", { email, password });
  let [subscriber] = await inspect(admin, "/subscribers?q=Ana%20Visual");
  if (!subscriber) {
    subscriber = await command(admin, "/subscribers", {
      name: "Ana Visual Moreira",
      email: "ana@visual-v0.invalid",
      phone: "85988887777",
      address_street: "Rua das Flores",
      address_number: "120",
      address_district: "Centro",
      address_city: "Fortaleza",
      address_state: "CE",
    });
    await command(admin, "/subscribers", { name: "Bruno Visual Lima", email: "bruno@visual-v0.invalid" });
    const plan = await command(admin, "/plans", {
      name: "Fibra Visual 300",
      price_cents: 11990,
      down_kbps: 300000,
      up_kbps: 150000,
      profile_name: "visual300",
    });
    const contract = await command(admin, "/contracts", {
      subscriber_id: subscriber.id,
      plan_id: plan.id,
      due_day: 10,
      start_date: "2026-10-01",
    });
    await command(admin, "/invoices", {
      contract_id: contract.id,
      description: "Mensalidade de referência visual",
      amount_cents: 11990,
      due_date: "2026-11-10",
    });
    await command(admin, "/tickets", {
      subscriber_id: subscriber.id,
      subject: "Lentidão no período da noite",
      category: "technical",
      body: "Atendimento de referência visual",
    });
    await command(admin, "/work-orders", {
      subscriber_id: subscriber.id,
      contract_id: contract.id,
      kind: "repair",
      description: "Visita técnica de referência visual",
    });
    await command(admin, "/leads", { name: "Carla Visual Prospecto", phone: "85977776666" });
    await command(admin, `/subscribers/${subscriber.id}/portal-access`, {
      email: "portal@visual-v0.invalid",
      password,
    });
  }
  const [contract] = await inspect(admin, `/contracts?subscriber_id=${subscriber.id}`);
  const portal = await context();
  await command(portal, "/auth/login", { email: "portal@visual-v0.invalid", password });
  return { admin, portal, vars: { SUB: subscriber.id, CONTRACT: contract.id } };
}

async function open(ctx, path, { theme = "light", width = 1440, height = 900 } = {}) {
  await ctx.addCookies([{ name: "nexo-appearance", value: theme, url: base }]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(`${path}: ${error.message}`));
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(clock);
  // Datas da API variam a cada execução; somente a captura as normaliza.
  await page.route("**/api/**", async (route) => {
    const response = await route.fetch();
    if (!(response.headers()["content-type"] ?? "").includes("json"))
      return route.fulfill({ response });
    const body = (await response.text())
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "2026-10-17T12:00:00Z")
      .replace(/"\d{4}-\d{2}-\d{2}"/g, '"2026-10-17"');
    await route.fulfill({ response, body });
  });
  await page.goto(`${base}${path}`);
  await page.waitForLoadState("networkidle");
  await page.locator("h1").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  return page;
}
async function classes(page) {
  return page.evaluate(() => {
    const scope = [
      document.getElementById("main-content"),
      ...document.querySelectorAll('[role="dialog"]'),
    ].filter(Boolean);
    const found = new Set();
    for (const node of scope)
      for (const el of [node, ...node.querySelectorAll("*")])
        for (const name of el.classList) found.add(name);
    return [...found];
  });
}
async function capture(page, name) {
  const bytes = await page.screenshot({
    animations: "disabled",
    caret: "hide",
    mask: [
      page.getByText(/\b[0-9A-F]{8}\b/),
      page.locator("select").filter({ hasText: /\b[0-9A-F]{8}\b/ }),
      page.locator(".leaflet-tile-pane"),
    ],
    path: new URL(`${name}.png`, output).pathname,
  });
  const file = new URL(`${name}.png`, screens);
  if (update) await writeFile(file, bytes);
  const reference = await readFile(file);
  const changed = await pixelsChanged(page, reference, bytes);
  const total = (page.viewportSize().width * page.viewportSize().height) || 1;
  const identical = createHash("sha256").update(bytes).digest("hex") === createHash("sha256").update(reference).digest("hex");
  visuals.push({ name, identical, changed_pixels: changed, changed_ratio: Number((changed / total).toFixed(5)) });
  if (changed / total > maxChanged)
    errors.push(`${name}: regressão visual operacional (${changed} pixels alterados); examine docs/integracao-v0/evidencias/visual-operacional/${name}.png`);
}
// Antisserrilhamento varia alguns pixels entre execuções; mudança de layout
// altera milhares. Conta pixels cuja cor difere acima do limiar.
const maxChanged = 0.0005;
async function pixelsChanged(page, a, b) {
  const scratch = await page.context().newPage();
  const result = await scratch.evaluate(
    async ([a, b]) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = `data:image/png;base64,${src}`;
        });
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) return Number.MAX_SAFE_INTEGER;
      const pixels = (image) => {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [da, db] = [pixels(x), pixels(y)];
      let changed = 0;
      for (let i = 0; i < da.length; i += 4)
        if (Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2])) > 24) changed++;
      return changed;
    },
    [a.toString("base64"), b.toString("base64")],
  );
  await scratch.close();
  return result;
}

try {
  const { admin, portal, vars } = await dataset();
  const fill = (path) => path.replace(/\{(\w+)\}/g, (_, key) => vars[key]);
  const demo = await context();
  const floorFile = new URL("estrutura.json", root);
  const floor = update ? {} : JSON.parse(await readFile(floorFile, "utf8"));
  const v0 = new Set(vocabulary);
  for (const [name, demoPath, path] of pairs) {
    const reference = await open(demo, `/demonstracao${demoPath}`);
    const original = await classes(reference);
    await reference.close();
    const page = await open(admin, fill(path));
    const used = new Set(await classes(page));
    await capture(page, `${name}-claro`);
    await page.close();
    const shared = original.filter((c) => used.has(c));
    const ratio = original.length ? shared.length / original.length : 1;
    const global = original.filter((c) => v0.has(c));
    const missing = global.filter((c) => !used.has(c)).sort();
    structure.push({
      name,
      demo: demoPath,
      operational: path,
      v0_classes: original.length,
      shared: shared.length,
      ratio: Number(ratio.toFixed(3)),
      globals_css: { classes: global.length, shared: global.length - missing.length, missing },
    });
    if (update) floor[name] = Number(ratio.toFixed(3));
    else if (ratio + tolerance < floor[name])
      errors.push(`${name}: estrutura do v0 caiu de ${floor[name]} para ${ratio.toFixed(3)}; ausentes: ${missing.join(", ")}`);
    console.log(`${name}: ${shared.length}/${original.length} classes da página do v0; globals.css ${global.length - missing.length}/${global.length}`);
  }
  if (update) await writeFile(floorFile, JSON.stringify(floor, null, 2) + "\n");
  for (const [name, path] of operationalOnly) {
    const page = await open(admin, fill(path));
    await capture(page, `${name}-claro`);
    await page.close();
  }
  for (const [name, path] of areas) {
    for (const [variant, options] of [
      ["escuro", { theme: "dark" }],
      ["celular", { width: 390, height: 844 }],
    ]) {
      const page = await open(admin, path, options);
      if (variant === "celular")
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: rolagem horizontal no celular`);
      await capture(page, `${name}-${variant}`);
      await page.close();
    }
  }
  for (const [variant, options] of [
    ["claro", {}],
    ["escuro", { theme: "dark" }],
    ["celular", { width: 390, height: 844 }],
  ]) {
    const page = await open(portal, "/portal", options);
    await capture(page, `portal-${variant}`);
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    new URL("../docs/integracao-v0/evidencias/visual-operacional.json", import.meta.url),
    JSON.stringify(
      {
        ok: true,
        verified_at: new Date().toISOString(),
        proves: "Estrutura: fração das classes do v0 usadas na página demonstrativa que a tela conectada também usa, com piso registrado. Regressão: comparação pixel a pixel das telas conectadas (até 0,05% de pixels alterados) com relógio fixo, datas normalizadas e códigos de UUID mascarados. Não prova igualdade pixel a pixel com o v0, porque os dados diferem; a igualdade com o v0 original é provada para a demonstração.",
        backend: "Go/PostgreSQL isolados; provedor exclusivo visual-v0 com dados sintéticos",
        structure,
        visuals,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Estrutura em ${structure.length} telas; ${visuals.length} capturas dentro da tolerância.`);
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
}
