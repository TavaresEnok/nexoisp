import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const isDemoMode = JSON.parse(readFileSync(new URL("../../execution.config.json", import.meta.url), "utf8")).mode === "demo";
import { navigationPages, navigationAliases } from "../../lib/navigation";

const specialPaths = ["/estrutura", "/busca", "/relatorios", "/configuracoes", "/acompanhamento", "/assistente", "/s", "/s/demo-session"];
const paths = [...new Set([...navigationPages.filter(page => page.view).map(page => page.href), ...navigationAliases.keys(), ...specialPaths])];

test.describe("validação independente do modo demo", () => {
  test.skip(!isDemoMode, "Esta suíte exige seleção explícita do modo demo; não testa serviços originais.");

  for (const path of paths) {
    test(`renderização hidratada: ${path}`, async ({ page }) => {
      const operationalRequests: string[] = [];
      page.on("request", request => {
        if (/\/(?:api\/(?:workspace|auth)(?:\/|\?|$)|eve\/v1(?:\/|\?|$))/.test(new URL(request.url()).pathname)) operationalRequests.push(request.url());
      });
      await page.goto(path);
      await expect(page.locator("main h1")).toBeVisible();
      await expect(page.locator("main")).not.toContainText("Consulta indisponível");
      expect(operationalRequests).toEqual([]);
    });
  }

  test("URL inexistente mostra o fallback e permite retornar", async ({ page }) => {
    await page.goto("/rota-que-nao-existe");
    await expect(page.getByRole("heading", { name: "Esta conexão ainda não existe." })).toBeVisible();
    await page.getByRole("link", { name: "Voltar à visão geral", exact: true }).click();
    await expect(page.getByRole("heading", { name: "A operação, em perspectiva." })).toBeVisible();
  });

  test("ficha inexistente apresenta aviso e visualização inválida usa o quadro", async ({ page }) => {
    await page.goto("/assinantes?ficha=inexistente&abaFicha=invalida");
    await expect(page.getByText("Assinante não encontrado", { exact: true })).toBeVisible();
    await page.goto("/ordens-de-servico?visualizacao=invalida");
    await expect(page.getByRole("tab", { name: "Quadro de OS", exact: true })).toHaveAttribute("aria-selected", "true");
  });

  test("filtro vazio, parâmetros inválidos e reset mantêm a consulta utilizável", async ({ page }) => {
    await page.goto("/assinantes?busca=zzzz-inexistente&situacao=invalida&conexao=invalida");
    await expect(page.getByText("Nenhuma conexão por aqui.", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: /^Todos/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Limpar filtros", exact: true }).first().click();
    await expect(page).not.toHaveURL(/busca=|situacao=|conexao=/);
    await expect(page.locator("tbody tr")).toHaveCount(8);
  });

  test("download contém o CSV demonstrativo efetivamente gerado", async ({ page }) => {
    await page.goto("/");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportar resumo", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("nexo-resumo-demonstrativo-2026-10-17.csv");
    const stream = await download.createReadStream();
    if (!stream) throw new Error("Download sem conteúdo legível.");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks).toString("utf8");
    expect(content).toContain('"Indicador";"Valor";"Origem"');
    expect(content).toContain('"Recebido no mês";"218420";"Cenário fictício"');
    expect(content.trim().split(/\r?\n/)).toHaveLength(7);
  });

  test("tooltip do gráfico e resize para mobile", async ({ page }) => {
    await page.goto("/");
    const chart = page.locator(".revenue-chart .recharts-surface");
    await expect(chart).toBeVisible();
    await chart.hover();
    await expect(page.locator(".recharts-tooltip-wrapper")).toBeVisible();
    await expect(page.locator(".recharts-tooltip-wrapper")).toContainText("Recebido");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await chart.boundingBox())?.width ?? 0).toBeLessThan(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test("clipboard concedido usa o navegador real", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/assinantes?ficha=sub-1&abaFicha=cadastro");
    await page.getByRole("button", { name: "Copiar e-mail", exact: true }).click();
    await expect(page.getByText("Copiado para a área de transferência.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("assinante1@example.com");
  });

  test("clipboard bloqueado pela política nativa informa falha", async ({ page }) => {
    await page.goto("/acompanhamento");
    await expect(page.locator("h1")).toBeVisible();
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.dataset.testClipboard = "";
      frame.allow = "clipboard-write 'none'; clipboard-read 'none'";
      frame.src = "/assinantes?ficha=sub-1&abaFicha=cadastro";
      frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:2147483647";
      document.body.append(frame);
    });
    const frame = page.frameLocator("iframe[data-test-clipboard]");
    await frame.getByRole("button", { name: "Copiar e-mail", exact: true }).click();
    await expect(frame.getByText("O navegador não permitiu copiar o texto.", { exact: true })).toBeVisible();
  });

  test("fechar a ficha por Escape devolve o foco ao acionador", async ({ page }) => {
    await page.goto("/assinantes?busca=Mariana");
    const trigger = page.getByRole("button", { name: "Abrir ficha de Mariana Oliveira", exact: true });
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });
});
