import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Mutações exclusivamente no harness descartável indicado explicitamente.
const base = process.env.BASE;
assert.ok(
  base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base),
  "Informe BASE com a URL local do laboratório descartável.",
);
const output = new URL(
  "../docs/integracao-v0/evidencias/correcoes/",
  import.meta.url,
);
const baseline = new URL("./visual-baselines/operacional/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const contexts = [];
const checks = [];
function check(message) {
  checks.push(message);
  console.log(message);
}
const visuals = [];
const errors = [];
async function context() {
  const ctx = await browser.newContext({
    viewport: { width: 1342, height: 805 },
    timezoneId: "America/Fortaleza",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  contexts.push(ctx);
  return ctx;
}
async function json(res) {
  assert.ok(res.ok(), `${res.status()} ${await res.text()}`);
  return res.json();
}
async function command(ctx, path, body, method = "POST") {
  return json(
    await ctx.request.fetch(`${base}/api${path}`, {
      method,
      data: body,
      headers: { "X-Nexo-CSRF": "1" },
    }),
  );
}
async function login(ctx, email, password = "demo1234") {
  return command(ctx, "/auth/login", { email, password });
}
async function inspect(ctx, path) {
  return json(await ctx.request.get(`${base}/api${path}`));
}
async function snapshot(
  ctx,
  name,
  path,
  {
    width = 1342,
    height = 805,
    theme = "light",
    ready = "Assinantes",
    empty = false,
    error = false,
  } = {},
) {
  if (process.env.V0_OPERATIONAL_VISUAL !== "1") return;
  console.log("Captura operacional:", name);
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  await ctx.addCookies([{ name: "nexo-appearance", value: theme, url: base }]);
  await p.setViewportSize({ width, height });
  // Somente a captura normaliza datas variáveis; comandos e assertions usam o Go real.
  if (path.includes("ficha="))
    await p.route("**/api/subscribers/*", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.created_at) body.created_at = "2026-10-17T12:00:00Z";
      if (body.contracts)
        body.contracts = body.contracts.map((contract) => ({
          ...contract,
          start_date: "2026-10-17",
        }));
      await route.fulfill({ response, json: body });
    });
  if (error)
    await p.route("**/api/subscribers?**", (r) =>
      r.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"Servidor temporariamente indisponível"}',
      }),
    );
  await p.goto(`${base}${path}`);
  await p.getByRole("heading", { name: ready, exact: true }).waitFor();
  if (error)
    await p
      .getByText("Servidor temporariamente indisponível", { exact: true })
      .first()
      .waitFor();
  else if (empty)
    await p
      .getByText("Nenhum assinante encontrado.", { exact: true })
      .waitFor();
  else if (!path.includes("ficha="))
    await p
      .getByRole("button", { name: /Abrir ficha de/ })
      .first()
      .waitFor();
  if (path.includes("ficha="))
    await p
      .getByRole("alert")
      .filter({ hasText: "Alerta de atendimento persistido no Go" })
      .waitFor();
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(350);
  const bytes = await p.screenshot({
    animations: "disabled",
    mask: [
      p.locator("td:first-child"),
      p.locator(".subscriber-sheet-header .eyebrow"),
    ],
    path: new URL(`${name}.png`, output).pathname,
  });
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (process.env.UPDATE_V0_OPERATIONAL_VISUAL === "1") {
    await mkdir(baseline, { recursive: true });
    await writeFile(new URL(`${name}.png`, baseline), bytes);
  }
  const expected = createHash("sha256")
    .update(await readFile(new URL(`${name}.png`, baseline)))
    .digest("hex");
  visuals.push({ name, identical: actual === expected, actual, expected });
  assert.equal(
    actual,
    expected,
    `${name}: regressão visual operacional; examine as capturas, sem atualizar a referência automaticamente.`,
  );
  await p.close();
  console.log("Captura aprovada:", name);
}

try {
  const operator = await context();
  const health = await inspect(operator, "/health");
  assert.equal(health.demo, true);
  await login(operator, "operador@nexoisp.demo");
  const suffix = Date.now();
  const email = `correcoes-${suffix}@example.invalid`;
  await command(operator, "/tenants", {
    name: "Validação do frontend oficial",
    slug: `correcoes-${suffix}`,
    admin_name: "Administrador da validação",
    admin_email: email,
    admin_password: "validacao-v0-1234",
  });
  const tenant = (await inspect(operator, "/tenants")).find(
    (t) => t.slug === `correcoes-${suffix}`,
  );
  const modules = [
    "crm",
    "field",
    "ipam",
    "ftth",
    "olt",
    "noc",
    "api",
    "notices",
    "messages",
  ];
  await command(operator, `/tenants/${tenant.id}`, { modules }, "PATCH");
  const admin = await context();
  await login(admin, email, "validacao-v0-1234");
  const page = await admin.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  const longName =
    "Assinante com nome extenso para validar apresentação de múltiplos contratos na interface oficial";
  const subscriber = await command(admin, "/subscribers", { name: longName });
  const referrer = await command(admin, "/subscribers", {
    name: "Indicador da validação",
  });
  const plan = await command(admin, "/plans", {
    name: "Fibra de validação",
    price_cents: 9990,
    down_kbps: 200000,
    up_kbps: 100000,
    profile_name: "validacao",
  });
  const contract = await command(admin, "/contracts", {
    subscriber_id: subscriber.id,
    plan_id: plan.id,
    due_day: 10,
    start_date: "2026-10-17",
  });
  await command(admin, "/contracts", {
    subscriber_id: subscriber.id,
    plan_id: plan.id,
    due_day: 15,
    start_date: "2026-10-18",
  });
  for (const path of [
    "/rede/equipamentos/concentradores",
    "/rede/ftth/fttx-olt",
  ]) {
    await page.goto(`${base}${path}`);
    await page
      .getByRole("heading", { name: "Monitoramento de rede", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "Recurso planejado", exact: true })
        .count(),
      0,
    );
  }
  check(
    "R01: submenus NAS e OLT abrem equipamento operacional em vez de planejado",
  );
  await command(admin, `/subscribers/${subscriber.id}/notes`, {
    body: "Alerta de atendimento persistido no Go",
    alert: true,
  });
  await command(admin, `/subscribers/${subscriber.id}/notes`, {
    body: "Anotação comum sem destaque",
    alert: false,
  });
  await page.goto(`${base}/assinantes`);
  await page
    .getByRole("button", { name: `Abrir ficha de ${longName}`, exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Alerta de atendimento persistido no Go" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("tab", { name: "Visão geral", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    await page
      .getByRole("alert")
      .filter({ hasText: "Anotação comum sem destaque" })
      .count(),
    0,
  );
  await page.goto(`${base}/assinantes?ficha=${subscriber.id}`);
  await page
    .getByRole("alert")
    .filter({ hasText: "Alerta de atendimento persistido no Go" })
    .waitFor();
  check(
    "R02: alerta aparece pela lista e URL direta na aba inicial; anotação comum não vira alerta",
  );
  await snapshot(admin, "assinantes-desktop-claro", "/assinantes");
  await snapshot(admin, "assinantes-desktop-escuro", "/assinantes", {
    theme: "dark",
  });
  await snapshot(admin, "assinantes-celular", "/assinantes", {
    width: 390,
    height: 844,
  });
  await snapshot(
    admin,
    "ficha-alerta-multiplos-contratos",
    `/assinantes?ficha=${subscriber.id}`,
    { ready: longName },
  );
  await snapshot(
    admin,
    "assinantes-vazio",
    "/assinantes?busca=sem-correspondencia-unica",
    { empty: true },
  );
  await snapshot(admin, "assinantes-erro", "/assinantes", { error: true });
  await admin.addCookies([
    { name: "nexo-appearance", value: "light", url: base },
  ]);
  await page.getByRole("tab", { name: "Cadastro", exact: true }).click();
  const alertRow = page
    .locator(".erp-contract-card")
    .filter({ hasText: "Alerta de atendimento persistido no Go" });
  await alertRow.getByRole("button", { name: "Arquivar", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Alerta de atendimento persistido no Go" })
    .waitFor({ state: "hidden" });
  check("R02: arquivamento atualiza também o alerta global da ficha");
  await page.goto(`${base}/contratos?contrato=${contract.id}`);
  await page.getByRole("tab", { name: "Instalação", exact: true }).click();
  await page
    .getByRole("button", { name: "Editar indicação", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Indicação do contrato",
    exact: true,
  });
  await dialog
    .getByLabel("Buscar assinante", { exact: true })
    .fill("Indicador");
  await dialog
    .getByLabel("Assinante selecionado", { exact: true })
    .selectOption(referrer.id);
  const savedReferral = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().endsWith("/referral"),
  );
  await dialog
    .getByRole("button", { name: "Salvar indicação", exact: true })
    .click();
  assert.equal((await savedReferral).status(), 200);
  await page
    .getByRole("button", { name: "Remover indicação", exact: true })
    .waitFor();
  assert.equal(
    (await inspect(admin, `/contracts/${contract.id}`))
      .referred_by_subscriber_id,
    referrer.id,
  );
  await page.goto(`${base}/relatorios/indicacoes`);
  await page
    .getByRole("heading", { name: "Relatório de indicações", exact: true })
    .waitFor();
  await page
    .locator(".premium-navigation")
    .getByRole("link", { name: /^Indicações/ })
    .waitFor();
  await page.getByText("Indicador da validação", { exact: true }).waitFor();
  check(
    "R04: indicação cadastrada pela interface, persistida e apresentada no relatório real",
  );
  await page.goto(`${base}/contratos?contrato=${contract.id}`);
  await page.getByRole("tab", { name: "Instalação", exact: true }).click();
  await page
    .getByRole("button", { name: "Editar indicação", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Indicação do contrato",
    exact: true,
  });
  await dialog
    .getByLabel("Buscar assinante", { exact: true })
    .fill("Assinante com nome extenso");
  await dialog
    .getByLabel("Assinante selecionado", { exact: true })
    .selectOption(subscriber.id);
  await dialog
    .getByRole("button", { name: "Salvar indicação", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "Escolha um assinante diferente do titular." })
    .waitFor();
  assert.equal(
    (await inspect(admin, `/contracts/${contract.id}`))
      .referred_by_subscriber_id,
    referrer.id,
  );
  const beta = await context();
  await login(beta, "admin@beta.demo");
  assert.equal(
    (
      await beta.request.put(`${base}/api/contracts/${contract.id}/referral`, {
        headers: { "X-Nexo-CSRF": "1" },
        data: { referrer_subscriber_id: null },
      })
    ).status(),
    400,
  );
  assert.equal(
    (await inspect(admin, `/contracts/${contract.id}`))
      .referred_by_subscriber_id,
    referrer.id,
  );
  const financeUser = await command(admin, "/users", {
    name: "Financeiro da validação",
    email: `financeiro-${suffix}@example.invalid`,
    password: "validacao-v0-1234",
    role: "finance",
  });
  const finance = await context();
  await login(
    finance,
    `financeiro-${suffix}@example.invalid`,
    "validacao-v0-1234",
  );
  assert.equal(
    (
      await finance.request.put(
        `${base}/api/contracts/${contract.id}/referral`,
        {
          headers: { "X-Nexo-CSRF": "1" },
          data: { referrer_subscriber_id: null },
        },
      )
    ).status(),
    403,
  );
  const fp = await finance.newPage();
  await fp.goto(`${base}/relatorios/indicacoes`);
  await fp.getByText("Indicador da validação", { exact: true }).waitFor();
  check(
    "R04: financeiro consulta sem poder alterar; outro provedor não altera indicação",
  );
  await page.goto(`${base}/contratos?contrato=${contract.id}`);
  await page.getByRole("tab", { name: "Instalação", exact: true }).click();
  await page
    .getByRole("button", { name: "Remover indicação", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Confirme a ação", exact: true })
    .getByRole("button", { name: "Confirmar", exact: true })
    .click();
  await page.getByText("Sem indicação registrada.", { exact: true }).waitFor();
  assert.equal(
    (await inspect(admin, `/contracts/${contract.id}`))
      .referred_by_subscriber_id,
    null,
  );
  check("R04: remoção da indicação pela interface preserva o contrato");
  await page
    .getByRole("button", { name: "Editar etiquetas", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Etiquetas do contrato",
    exact: true,
  });
  await dialog
    .getByLabel("Nova etiqueta", { exact: true })
    .fill("Etiqueta para excluir");
  await dialog
    .getByRole("button", { name: "Criar etiqueta", exact: true })
    .click();
  await dialog
    .getByRole("button", {
      name: "Excluir etiqueta Etiqueta para excluir",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "Confirme a ação", exact: true })
    .getByRole("button", { name: "Confirmar", exact: true })
    .click();
  await dialog
    .getByRole("button", {
      name: "Excluir etiqueta Etiqueta para excluir",
      exact: true,
    })
    .waitFor({ state: "hidden" });
  assert.equal(
    (await inspect(admin, "/tags")).some(
      (t) => t.name === "Etiqueta para excluir",
    ),
    false,
  );
  check("R04/BE-27: exclusão global de etiqueta confirmada e persistida");
  const lead = await command(admin, "/leads", {
    name: "Prospecto para cadastro existente",
    phone: "85999990000",
  });
  await page.goto(`${base}/prospectos?prospecto=${lead.id}`);
  await page
    .getByRole("button", {
      name: "Vincular a assinante existente",
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Vincular prospecto a assinante existente",
    exact: true,
  });
  await dialog
    .getByLabel("Buscar assinante", { exact: true })
    .fill("Indicador");
  await dialog
    .getByLabel("Assinante selecionado", { exact: true })
    .selectOption(referrer.id);
  await dialog
    .getByRole("button", { name: "Confirmar vínculo", exact: true })
    .click();
  await page.waitForURL((url) => url.searchParams.get("ficha") === referrer.id);
  assert.equal(
    (await inspect(admin, `/leads/${lead.id}`)).subscriber_id,
    referrer.id,
  );
  check(
    "R04/BE-05: prospecto convertido para assinante existente sem duplicar cadastro",
  );
  const cause = await command(admin, "/catalogs", {
    kind: "root_cause",
    name: "Causa da validação",
  });
  const ticket = await command(admin, "/tickets", {
    subscriber_id: subscriber.id,
    subject: "Protocolo da revisão",
    category: "technical",
    body: "Verificar a classificação estruturada.",
  });
  await page.goto(`${base}/atendimentos?protocolo=${ticket.id}`);
  await page
    .getByRole("button", {
      name: "Editar classificação do atendimento",
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Classificação do atendimento",
    exact: true,
  });
  await dialog
    .getByLabel("Causa-raiz do protocolo", { exact: true })
    .selectOption(cause.id);
  await dialog
    .getByLabel("Prioridade do protocolo", { exact: true })
    .selectOption("high");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const storedTicket = await inspect(admin, `/tickets/${ticket.id}`);
  assert.equal(storedTicket.root_cause_id, cause.id);
  assert.equal(storedTicket.priority, "high");
  check(
    "R04/BE-05: causa-raiz e prioridade editadas na interface e relidas no Go",
  );
  await page.goto(`${base}/relatorios/cobranca`);
  const agingResponse = page.waitForResponse((r) =>
    r.url().includes(`/finance/reports/aging?plan_id=${plan.id}`),
  );
  await page
    .getByLabel("Plano da carteira", { exact: true })
    .selectOption(plan.id);
  assert.equal((await agingResponse).status(), 200);
  const pop = await command(admin, "/pops", { name: "POP da carteira" });
  const tag = await command(admin, "/tags", { name: "Carteira filtrada" });
  // Atualiza as opções compartilhadas ao abrir uma consulta nova.
  await page.reload();
  await page
    .getByLabel("Plano da carteira", { exact: true })
    .selectOption(plan.id);
  await page
    .getByLabel("POP da carteira", { exact: true })
    .selectOption(pop.id);
  const taggedAging = page.waitForResponse(
    (r) =>
      r.url().includes(`pop_id=${pop.id}`) && r.url().includes(`tag=${tag.id}`),
  );
  await page
    .getByLabel("Etiqueta da carteira", { exact: true })
    .selectOption(tag.id);
  assert.equal((await taggedAging).status(), 200);
  const exporting = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Exportar relatório CSV", exact: true })
    .click();
  assert.ok((await exporting).suggestedFilename().endsWith(".csv"));
  const company = await command(admin, "/companies", {
    name: "Empresa para exportação",
    document: "11222333000181",
  });
  await page.goto(`${base}/financeiro/faturas`);
  await page.getByRole("button", { name: "Contabilidade", exact: true }).click();
  await page
    .getByLabel("Empresa da exportação contábil", { exact: true })
    .selectOption(company.id);
  const accounting = page.waitForEvent("download");
  const accountingResponse = page.waitForResponse(
    (r) =>
      r.url().includes("/finance/export?") &&
      r.url().includes(`company_id=${company.id}`),
  );
  await page
    .getByRole("button", { name: "Baixar CSV contábil", exact: true })
    .click();
  assert.equal((await accountingResponse).status(), 200);
  await accounting;
  check(
    "R04/BE-09: filtros de carteira e empresa na exportação contábil chegam ao Go",
  );
  const agent = await command(admin, "/agents", {
    name: "Agente da validação",
  });
  const device = await command(admin, "/devices", {
    name: "Equipamento para editar",
    driver: "demo",
    agent_id: agent.id,
  });
  await page.goto(`${base}/rede/equipamentos?equipamento=${device.id}`);
  await page
    .getByRole("button", { name: "Editar equipamento", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Editar equipamento de rede",
    exact: true,
  });
  await dialog
    .getByLabel("Nome do equipamento", { exact: true })
    .fill("Equipamento editado");
  await dialog
    .getByLabel("Endereço de gerenciamento", { exact: true })
    .fill("192.0.2.42");
  await dialog
    .getByLabel("Porta de gerenciamento", { exact: true })
    .fill("8729");
  await dialog
    .getByLabel("Referência da credencial local", { exact: true })
    .fill("credencial-validacao");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    (await inspect(admin, "/devices")).find((d) => d.id === device.id).host,
    "192.0.2.42",
  );
  const editedDevice = (await inspect(admin, "/devices")).find(
    (d) => d.id === device.id,
  );
  assert.equal(editedDevice.api_port, 8729);
  assert.equal(editedDevice.credential_ref, "credencial-validacao");
  check(
    "R04/BE-07: propriedades do equipamento editadas e relidas sem comando em hardware",
  );
  for (const role of ["attendant", "noc"]) {
    const roleEmail = `${role}-${suffix}@example.invalid`;
    await command(admin, "/users", {
      name: `Perfil ${role}`,
      email: roleEmail,
      role,
      password: "validacao-v0-1234",
    });
    const ctx = await context();
    await login(ctx, roleEmail, "validacao-v0-1234");
    const p = await ctx.newPage();
    await p.goto(`${base}/contratos?contrato=${contract.id}`);
    await p.getByRole("tab", { name: "Instalação", exact: true }).click();
    await p.getByText("Sem indicação registrada.", { exact: true }).waitFor();
    assert.equal(
      await p
        .getByRole("button", { name: "Editar indicação", exact: true })
        .count(),
      role === "attendant" ? 1 : 0,
    );
    await p.goto(`${base}/relatorios/indicacoes`);
    await p
      .getByRole("heading", {
        name:
          role === "noc" ? "Acesso não disponível" : "Relatório de indicações",
        exact: true,
      })
      .waitFor();
    await p.close();
  }
  check(
    "R05: perfis atendimento e NOC respeitam escrita de indicação e leitura financeira",
  );
  for (const enabled of [[], ["crm"], ["field"]]) {
    await command(
      operator,
      `/tenants/${tenant.id}`,
      { modules: enabled },
      "PATCH",
    );
    const scope = await context();
    await login(scope, email, "validacao-v0-1234");
    const p = await scope.newPage();
    const blockedRequests = [];
    const forbidden = [];
    p.on("response", (response) => {
      if (response.status() === 403 && response.url().includes("/api/"))
        forbidden.push(response.url());
    });
    p.on("request", (r) => {
      if (
        new URL(r.url()).pathname.endsWith("/equipment") ||
        /\/api\/(sla-policies|reports\/sla)/.test(r.url())
      )
        blockedRequests.push(new URL(r.url()).pathname);
    });
    await p.goto(`${base}/contratos?contrato=${contract.id}`);
    await p.getByRole("tab", { name: "Instalação", exact: true }).click();
    await p
      .getByRole("button", { name: "Editar indicação", exact: true })
      .waitFor();
    await p.goto(`${base}/administracao/catalogos-sla?aba=sla`);
    await p.getByRole("tab", { name: "Catálogos", exact: true }).waitFor();
    if (!enabled.length) {
      assert.equal(
        await p.getByRole("tab", { name: "SLA", exact: true }).count(),
        0,
      );
      await p.waitForTimeout(300);
      assert.deepEqual(blockedRequests, []);
    } else {
      await p
        .getByRole("heading", { name: "Políticas de SLA", exact: false })
        .waitFor();
      assert.ok(blockedRequests.some((path) => path.endsWith("/sla-policies")));
      assert.equal(
        blockedRequests.some((path) => path.endsWith("/equipment")),
        enabled.includes("field"),
      );
    }
    assert.deepEqual(forbidden, [], `Consultas sem liberação: ${enabled}`);
    await p.close();
  }
  check(
    "R03/R05: matriz nenhum módulo / CRM / campo respeita controles e consultas, com habilitação positiva",
  );
  await command(operator, `/tenants/${tenant.id}`, { modules }, "PATCH");
  assert.deepEqual(errors, []);
  await writeFile(
    new URL("regressao.json", output),
    JSON.stringify(
      { ok: true, checks, visuals, runtimeErrors: errors },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ ok: true, checks, visuals }));
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
}
