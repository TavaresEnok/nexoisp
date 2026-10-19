import { test, expect } from "@playwright/test";

test("alerta óptico chega ao monitoramento em atenção, não à lista online", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A operação, em perspectiva." })).toBeVisible();
  await page.getByRole("link", { name: /Sinal óptico degradado no POP Norte/ }).click();
  await expect(page).toHaveURL(/\/rede\/equipamentos\?filtro=atencao/);
  await expect(page.getByRole("heading", { name: "Monitoramento de rede" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Atenção", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("busca global encontra telefone e abre uma ficha compartilhável", async ({ page }) => {
  const response = await page.request.get("/api/workspace");
  expect(response.ok()).toBe(true);
  const data = await response.json();
  const subscriber = data.subscribers.find((item: { phone: string }) => item.phone.replace(/\D/g, "").length >= 8);
  expect(subscriber).toBeTruthy();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A operação, em perspectiva." })).toBeVisible();
  await page.getByRole("button", { name: "Buscar no workspace", exact: true }).click();
  await page.getByRole("textbox", { name: "Busca global", exact: true }).fill(subscriber.phone.replace(/\D/g, ""));
  await page.getByRole("button", { name: new RegExp(subscriber.name) }).click();
  await expect(page).toHaveURL(new RegExp(`ficha=${subscriber.id}`));
  await expect(page.getByRole("dialog").getByRole("heading", { name: subscriber.name })).toBeVisible();
  await page.getByRole("tab", { name: "Histórico", exact: true }).click();
  await expect(page).toHaveURL(/abaFicha=historico/);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Histórico", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Histórico e marcos do assinante" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page).not.toHaveURL(/ficha=/);
});

test("busca e situação dos assinantes sobrevivem ao recarregamento", async ({ page }) => {
  await page.goto("/assinantes");
  const search = page.getByRole("textbox", { name: "Buscar assinantes" });
  await expect(search).toBeVisible();
  await search.fill("Mariana");
  await expect(page).toHaveURL(/busca=Mariana/);
  await page.getByRole("tab", { name: /^Ativos/ }).click();
  await expect(page).toHaveURL(/situacao=Ativo/);
  await page.reload();
  await expect(search).toHaveValue("Mariana");
  await expect(page.getByRole("tab", { name: /^Ativos/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Abrir ficha de Mariana Oliveira" })).toBeVisible();
});

test("preferência de aparência persiste em cookie sem localStorage", async ({ page, context }) => {
  await page.goto("/acompanhamento");
  await expect(page.getByRole("heading", { name: "Consolidar é comprovar." })).toBeVisible();
  await page.getByRole("button", { name: "Ativar tema claro", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  const preference = (await context.cookies()).find(cookie => cookie.name === "nexo-appearance");
  expect(preference?.value).toBe("light");
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("falha da consulta não impede a navegação e não derruba páginas informativas", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/workspace", async route => {
    requests++;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Falha controlada no teste" }) });
  });
  await page.goto("/acompanhamento");
  await expect(page.getByRole("heading", { name: "Consolidar é comprovar." })).toBeVisible();
  expect(requests).toBe(0);
  await page.goto("/");
  await expect(page.getByText("Consulta indisponível", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toBeEnabled();
  await page.getByRole("link", { name: "Consolidação e evidências", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Consolidar é comprovar." })).toBeVisible();
});

test("catálogo técnico usa sua própria leitura sem carregar o cenário global", async ({ page }) => {
  let workspaceRequests = 0;
  await page.route("**/api/workspace", async route => { workspaceRequests++; await route.abort(); });
  await page.goto("/rede/enderecos-ip/blocos-de-enderecos");
  await expect(page.getByRole("heading", { name: "Endereçamento sob controle." })).toBeVisible();
  await expect(page.getByText("Consulta validada do Neon")).toBeVisible();
  expect(workspaceRequests).toBe(0);
});

test("ficha móvel mantém todas as abas dentro da área visível", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/assinantes?ficha=sub-1&abaFicha=historico");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Mariana Oliveira" })).toBeVisible();
  const tabs = dialog.getByRole("tab");
  await expect(tabs).toHaveCount(7);
  for (const tab of await tabs.all()) {
    const bounds = await tab.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
