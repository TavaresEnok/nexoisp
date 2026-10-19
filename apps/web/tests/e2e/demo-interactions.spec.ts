import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const isDemoMode = JSON.parse(readFileSync(new URL("../../execution.config.json", import.meta.url), "utf8")).mode === "demo";
const operationalRequests = new WeakMap<object, string[]>();

test.describe("integridade das interações demonstrativas existentes", () => {
  test.skip(!isDemoMode, "Exige modo demo explícito; não executa serviços originais.");

  test.beforeEach(async ({ page }) => {
    const requests: string[] = [];
    operationalRequests.set(page, requests);
    await page.route(/\/api(?:\/|$)|\/eve\/v1(?:\/|$)/, route => {
      requests.push(route.request().url());
      return route.abort();
    });
    await page.route("https://server.arcgisonline.com/**", route => route.abort());
  });

  test.afterEach(async ({ page }) => {
    expect(operationalRequests.get(page), "As jornadas locais não devem chamar APIs operacionais").toEqual([]);
  });

  test("consulta online valida CIDR, conserva rascunho entre abas e cancela sem alterar URL", async ({ page }) => {
    await page.goto("/rede/online");
    await page.getByRole("button", { name: "Fazer consulta", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "Conexão", exact: true }).click();
    await dialog.getByLabel("IP ou rede IPv4", { exact: true }).fill("999.1.1.1/40");
    await dialog.getByRole("button", { name: "Consultar online", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Informe um IPv4 válido");
    await expect(dialog.getByLabel("IP ou rede IPv4", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await dialog.getByLabel("IP ou rede IPv4", { exact: true }).fill("100.64.0.0/16");
    for (const name of ["Endereço", "Assinante", "ANATEL & tags", "Infraestrutura", "Conexão"]) {
      await dialog.getByRole("tab", { name, exact: true }).click();
      await expect(dialog.getByRole("tabpanel")).toBeVisible();
    }
    await expect(dialog.getByLabel("IP ou rede IPv4", { exact: true })).toHaveValue("100.64.0.0/16");
    await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page).not.toHaveURL(/rede_ip=/);
  });

  test("consulta aplica POP, sobrevive ao reload e remove o filtro", async ({ page }) => {
    await page.goto("/rede/online");
    await page.getByRole("button", { name: "Fazer consulta", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const pop = dialog.getByLabel("POP", { exact: true });
    const value = await pop.locator("option").nth(1).getAttribute("value");
    expect(value).toBeTruthy();
    await pop.selectOption(value!);
    await dialog.getByRole("button", { name: "Consultar online", exact: true }).click();
    await expect(page).toHaveURL(/rede_pop=/);
    await expect(page.locator("tbody tr").first()).toContainText(value!);
    await page.reload();
    await expect(page.getByRole("button", { name: "Remover filtro POP", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remover filtro POP", exact: true }).click();
    await expect(page).not.toHaveURL(/rede_pop=/);
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });

  test("rede sem resultados desativa exportação e permite limpar a busca", async ({ page }) => {
    await page.goto("/rede/online");
    await page.getByRole("textbox", { name: "Buscar conexões", exact: true }).fill("zzzz-sem-conexao");
    await expect(page.getByText("Nenhum acesso encontrado", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Exportar", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Limpar filtros", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Buscar conexões", exact: true })).toHaveValue("");
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });

  test("mapa mantém controles e aviso quando os tiles estão indisponíveis", async ({ page }) => {
    await page.goto("/rede/mapa");
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Alguns blocos do mapa não carregaram" })).toBeVisible();
    await page.getByRole("button", { name: "Satélite", exact: true }).click();
    await expect(page.getByRole("button", { name: "Ver mapa", exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Alguns blocos do mapa não carregaram" })).toBeVisible();
    await page.getByRole("button", { name: "Centralizar instalações", exact: true }).click();
    await page.locator(".leaflet-control-zoom-in").click();
    await page.locator(".leaflet-control-zoom-out").click();
    await expect(page.locator(".leaflet-container")).toBeVisible();
  });

  test("mapa filtra instalações, abre e fecha lista e recupera estado vazio", async ({ page }) => {
    await page.goto("/rede/mapa");
    await page.getByRole("button", { name: "Ver clientes", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Instalações encontradas" })).toBeVisible();
    await page.getByRole("textbox", { name: "Buscar instalações", exact: true }).fill("zzzz-sem-instalacao");
    await expect(page.getByText("Nenhuma instalação encontrada.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Fechar lista de instalações", exact: true }).click();
    await expect(page.getByText("Nenhum cliente nesta seleção", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Buscar instalações", exact: true })).toHaveValue("");
    await expect(page.getByText("Nenhum cliente nesta seleção", { exact: true })).not.toBeVisible();
  });

  test("consulta do mapa mantém opções indisponíveis honestas e persiste visibilidade", async ({ page }) => {
    await page.goto("/rede/mapa");
    await page.getByRole("button", { name: "Filtros do mapa", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Exibir pontos de interesse", { exact: true })).toBeDisabled();
    await dialog.getByRole("tab", { name: "ANATEL & tags", exact: true }).click();
    await expect(dialog.getByLabel("Dados detalhados para ANATEL", { exact: true })).toBeDisabled();
    await dialog.getByLabel("Exibição no mapa", { exact: true }).selectOption("offline");
    await dialog.getByRole("button", { name: "Aplicar no mapa", exact: true }).click();
    await expect(page).toHaveURL(/rede_visibility=offline/);
    await page.reload();
    await page.getByRole("button", { name: "Filtros do mapa", exact: true }).click();
    await expect(page.getByRole("dialog").getByLabel("Exibição no mapa", { exact: true })).toHaveValue("offline");
  });

  test("agenda alterna quadro, filtra status, pesquisa vazio e restaura seleção", async ({ page }) => {
    await page.goto("/ordens-de-servico");
    await page.getByRole("tab", { name: "Agenda", exact: true }).click();
    await expect(page).toHaveURL(/visualizacao=agenda/);
    for (const name of [/^Agendadas/, /^Em execução/, /^Atrasadas/, /^Concluídas/, /^Todas/]) {
      const tab = page.getByRole("tab", { name });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(".field-order").first()).toBeVisible();
    }
    await page.getByRole("textbox", { name: "Buscar ordens de serviço", exact: true }).fill("zzzz-sem-visita");
    await expect(page.getByText("Nenhuma visita nesta seleção.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Ver agenda completa", exact: true }).click();
    await expect(page.locator(".field-order")).toHaveCount(8);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Agenda", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Quadro de OS", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Quadro de OS", exact: true })).toHaveAttribute("aria-selected", "true");
  });

  test("técnico selecionado persiste em URL e contexto da OS abre a ficha", async ({ page }) => {
    await page.goto("/ordens-de-servico?visualizacao=agenda");
    const technician = page.locator(".technician-row").nth(1);
    await technician.click();
    await expect(technician).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/tecnico=/);
    await page.reload();
    await expect(page.locator(".technician-row").nth(1)).toHaveAttribute("aria-pressed", "true");
    await page.locator(".field-order").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Abrir contexto do assinante", exact: true }).click();
    await expect(page).toHaveURL(/ficha=sub-/);
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("ficha de impressão real carrega documento isolado sem observações internas", async ({ page }) => {
    await page.goto("/ordens-de-servico?visualizacao=agenda");
    await page.locator(".field-order").first().click();
    await page.getByRole("tab", { name: "Ficha para impressão", exact: true }).click();
    const frame = page.frameLocator('iframe[title^="Ficha de impressão da OS"]');
    await expect(frame.getByRole("heading", { name: "Ordem técnica de serviço", exact: true })).toBeVisible();
    await expect(frame.locator("body")).toContainText("FICHA DEMONSTRATIVA");
    await expect(frame.locator("body")).toContainText("Observações internas não integram esta ficha");
    await expect(frame.locator("body")).not.toContainText("Observação da visita");
    await expect(page.getByRole("button", { name: "Imprimir / salvar PDF", exact: true })).toBeEnabled();
    await page.emulateMedia({ media: "print" });
    await expect(frame.getByRole("heading", { name: "Ordem técnica de serviço", exact: true })).toBeVisible();
  });

  test("relatórios percorrem todas as categorias e alternam dicionário", async ({ page }) => {
    await page.goto("/relatorios");
    for (const name of ["Financeiro", "Rede", "Campo", "Atendimento", "Tudo"]) {
      const tab = page.getByRole("tab", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(".report-timeline > div").first()).toBeVisible();
    }
    await page.getByRole("tab", { name: "Dicionário de indicadores", exact: true }).click();
    await expect(page.getByRole("heading", { name: "O que cada número quer dizer", exact: true })).toBeVisible();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportar indicadores", exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^nexo-indicadores-demonstrativos.*\.csv$/);
    expect(await download.failure()).toBeNull();
  });

  for (const [label, value, error] of [
    ["VLAN", "4095", "VLAN deve ser um número inteiro entre 1 e 4094."],
    ["Slot", "32", "Slot fora do intervalo permitido."],
    ["PON", "256", "PON fora do intervalo permitido."],
    ["Serial da ONU", "INVALIDO", "Serial deve conter 4 letras e 8 hexadecimais, ou 16 hexadecimais."],
    ["Login PPPoE", "login com espaço", "Login aceita apenas letras, números, ponto, hífen, sublinhado e @, até 64 caracteres."],
  ]) {
    test(`testador CLI rejeita ${label} inválido e recupera com valores válidos`, async ({ page }) => {
      await page.goto("/rede/ftth/fttx-onu-template?tab=playground");
      const source = page.getByLabel("Template de entrada", { exact: true });
      await source.fill("vlan %vlan% slot %slot% pon %pon% serial %sn% login %login%");
      const field = page.getByLabel(label, { exact: true });
      const original = await field.inputValue();
      await field.fill(value);
      await page.getByRole("button", { name: "Validar e processar", exact: true }).click();
      await expect(page.getByText(error, { exact: true })).toBeVisible();
      await field.fill(original);
      await expect(page.getByText(error, { exact: true })).not.toBeVisible();
      await page.getByRole("button", { name: "Validar e processar", exact: true }).click();
      await expect(page.locator("pre")).toContainText("vlan 901 slot 0 pon 1 serial HWTC00000001 login assinante.lab");
      await expect(page.locator("pre")).not.toContainText("%vlan%");
    });
  }

  test("testador CLI rejeita template vazio e variável desconhecida sem modificar catálogo", async ({ page }) => {
    await page.goto("/rede/ftth/fttx-onu-template");
    await page.getByRole("tab", { name: "Testador CLI", exact: true }).click();
    const source = page.getByLabel("Template de entrada", { exact: true });
    await expect(source).toBeVisible();
    const original = await source.inputValue();
    expect(original).not.toBe("");
    await expect(page.locator(".source-footer")).toContainText("Catálogo técnico demonstrativo local · sem credenciais ou comandos remotos");
    await expect(page.locator("main")).not.toContainText("Catálogo técnico demonstrativo no Neon");
    await source.focus();
    await source.press("ControlOrMeta+A");
    await source.press("Backspace");
    await expect(source).toHaveValue("");
    await page.getByRole("button", { name: "Validar e processar", exact: true }).click();
    await expect(page.getByText("Informe um template para processar.", { exact: true })).toBeVisible();
    await source.fill("command %desconhecida%");
    await page.getByRole("button", { name: "Validar e processar", exact: true }).click();
    await expect(page.getByText("Variável não reconhecida: %desconhecida%.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(source).toHaveValue(original);
  });

  test("configurações não editam identidade nem anunciam serviços remotos ativos", async ({ page }) => {
    await page.goto("/configuracoes");
    await expect(page.getByLabel("Nome do provedor", { exact: true })).toHaveAttribute("readonly", "");
    await expect(page.getByLabel("Contato demonstrativo", { exact: true })).toHaveAttribute("readonly", "");
    await expect(page.getByText("Cenário demonstrativo local", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Entender a implantação", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("O protótipo não deve receber dados reais de clientes ainda.");
    await page.getByRole("button", { name: "Continuar explorando", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });
});
