import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const base = process.env.BASE ?? "http://127.0.0.1:3000";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({
  viewport: { width: 1342, height: 805 },
  timezoneId: "America/Fortaleza",
});
const page = await context.newPage();
page.setDefaultTimeout(15000);

const checks = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (message) => {
  checks.push(message);
  console.log(message);
};

try {
  // 1. Login com administrador real da base semeada
  await page.goto(`${base}/login`);
  await page.getByLabel("E-mail", { exact: true }).fill("admin@alfa.demo");
  await page.getByLabel("Senha", { exact: true }).fill("demo1234");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  await page.getByText("O que merece sua atenção.", { exact: true }).waitFor();

  // 2. Favorito do catálogo permitido: adicionar, navegar, recarregar e remover
  const favSection = page.locator(".sidebar-favorites");
  await favSection.waitFor();
  await favSection
    .getByText("Nenhum favorito selecionado", { exact: true })
    .waitFor();

  // Adiciona a página de Contratos aos favoritos
  const subscribersArea = page.getByRole("button", { name: "Área de Assinantes", exact: true });
  if (await subscribersArea.getAttribute("aria-expanded") !== "true") await subscribersArea.click();
  const addContratosBtn = page.getByRole("button", {
    name: "Adicionar Contratos aos favoritos",
    exact: true,
  });
  await addContratosBtn.waitFor();
  await addContratosBtn.click();

  // Verifica que o botão mudou para estado ativo/remover
  const removeContratosBtn = page.locator(".sidebar-area-panel").getByRole("button", {
    name: "Remover Contratos dos favoritos",
    exact: true,
  });
  await removeContratosBtn.waitFor();
  assert.equal(await removeContratosBtn.getAttribute("aria-pressed"), "true");

  // Verifica presença do link na seção de favoritos e navega por ele
  const contratosFavLink = favSection.getByRole("link", {
    name: "Contratos",
    exact: true,
  });
  await contratosFavLink.waitFor();
  await contratosFavLink.click();
  await page.waitForURL((url) => url.pathname === "/contratos");

  // Recarrega a página e confirma persistência local no navegador
  await page.reload();
  await page.waitForURL((url) => url.pathname === "/contratos");
  await favSection
    .getByRole("link", { name: "Contratos", exact: true })
    .waitFor();

  // Remove o favorito diretamente pela ação na seção de favoritos
  await favSection
    .getByRole("button", {
      name: "Remover Contratos dos favoritos",
      exact: true,
    })
    .click();
  assert.equal(
    await favSection
      .getByRole("link", { name: "Contratos", exact: true })
      .count(),
    0,
  );
  await favSection
    .getByText("Nenhum favorito selecionado", { exact: true })
    .waitFor();

  // Adiciona a página de Planos aos favoritos para validação de isolamento posterior
  await page.goto(`${base}/`);
  await page
    .getByRole("heading", { name: "Nos bastidores da sua rede", exact: true })
    .waitFor();
  if (await subscribersArea.getAttribute("aria-expanded") !== "true") await subscribersArea.click();
  await page
    .getByRole("button", {
      name: "Adicionar Planos aos favoritos",
      exact: true,
    })
    .click();
  await favSection.getByRole("link", { name: "Planos", exact: true }).waitFor();

  check(
    "Favorito do catálogo operacional permitido pode ser adicionado, navega ao destino, persiste na recarga e é removido da barra lateral",
  );

  // 3. Seleção pessoal de blocos da visão geral (ErpOverview): ocultar, recarregar e restaurar padrão
  // Confirma presença inicial dos 3 blocos opcionais autorizados e das prioridades
  await page
    .getByRole("heading", { name: "Mais conexões. Novas possibilidades.", exact: true })
    .waitFor();
  await page
    .getByRole("heading", {
      name: "Ativações dos últimos doze meses",
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("heading", { name: "A agenda precisa andar", exact: true })
    .waitFor();
  await page.getByText("O que merece sua atenção.", { exact: true }).waitFor();

  // Abre modal de personalização do painel
  await page
    .getByRole("button", { name: "Personalizar painel da visão geral", exact: true })
    .click();
  const customizeDialog = page.getByRole("dialog");
  await customizeDialog
    .getByRole("heading", { name: "Personalizar painel", exact: true })
    .waitFor();

  // Desmarca o bloco de tendências de contrato (contract-trends)
  const trendsCheckbox = page.locator("#overview-pref-contract-trends");
  assert.equal(await trendsCheckbox.isChecked(), true);
  await trendsCheckbox.uncheck();
  assert.equal(await trendsCheckbox.isChecked(), false);

  // Fecha o modal e confirma que o bloco foi ocultado sem remover prioridades nem receita
  await customizeDialog
    .locator('[data-slot="dialog-footer"]')
    .getByRole("button", { name: "Fechar", exact: true })
    .click();
  await customizeDialog.waitFor({ state: "hidden" });
  assert.equal(
    await page
      .getByRole("heading", { name: "Ativações dos últimos doze meses" })
      .count(),
    0,
  );
  await page
    .getByRole("heading", { name: "Mais conexões. Novas possibilidades.", exact: true })
    .waitFor();
  await page.getByText("O que merece sua atenção.", { exact: true }).waitFor();

  // Recarrega a página: preferência persiste neste navegador e prioridades continuam
  await page.reload();
  await page.getByText("O que merece sua atenção.", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Ativações dos últimos doze meses" })
      .count(),
    0,
  );
  await page
    .getByRole("heading", { name: "Mais conexões. Novas possibilidades.", exact: true })
    .waitFor();
  await page.getByText("O que merece sua atenção.", { exact: true }).waitFor();

  // Restaura padrão e confirma reexibição do bloco
  await page
    .getByRole("button", { name: "Personalizar painel da visão geral", exact: true })
    .click();
  await customizeDialog
    .getByRole("button", { name: "Restaurar padrão", exact: true })
    .click();
  await customizeDialog
    .locator('[data-slot="dialog-footer"]')
    .getByRole("button", { name: "Fechar", exact: true })
    .click();
  await customizeDialog.waitFor({ state: "hidden" });
  await page
    .getByRole("heading", {
      name: "Ativações dos últimos doze meses",
      exact: true,
    })
    .waitFor();

  check(
    "Seleção pessoal da Visão geral oculta bloco opcional e persiste após recarga sem afetar prioridades nem indicadores; restauração restabelece os blocos autorizados",
  );

  // Deixa uma preferência diferente do padrão para testar o isolamento entre contas.
  await page.getByRole("button", { name: "Personalizar painel da visão geral", exact: true }).click();
  await page.locator("#overview-pref-revenue").uncheck();
  await customizeDialog.locator('[data-slot="dialog-footer"]').getByRole("button", { name: "Fechar", exact: true }).click();
  await customizeDialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("heading", { name: "Mais conexões. Novas possibilidades.", exact: true }).count(), 0);

  // 4. Logout e login de outra conta no MESMO contexto: não vaza preferências e recursos proibidos não aparecem
  // Logout da conta admin via interface
  await page
    .getByRole("button", { name: "Minha conta", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Sair", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/login");

  // Login da conta de financeiro (sem permissão de rede nem campo/OS)
  await page
    .getByLabel("E-mail", { exact: true })
    .fill("financeiro@alfa.demo");
  await page.getByLabel("Senha", { exact: true }).fill("demo1234");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  await page.getByText("O que merece sua atenção.", { exact: true }).waitFor();

  // Prova de isolamento: favoritos da conta admin (Planos) NÃO vazam para a conta de financeiro
  assert.equal(
    await favSection.getByRole("link", { name: "Planos", exact: true }).count(),
    0,
  );
  await favSection
    .getByText("Nenhum favorito selecionado", { exact: true })
    .waitFor();

  await page.getByRole("heading", { name: "Mais conexões. Novas possibilidades.", exact: true }).waitFor();

  // Prova de permissionamento: blocos que exigem permissões ausentes (rede e OS) não aparecem
  assert.equal(
    await page
      .getByRole("heading", { name: "Ativações dos últimos doze meses" })
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("heading", { name: "A agenda precisa andar" }).count(),
    0,
  );

  // No formulário de personalização, opções desautorizadas ficam desabilitadas
  await page
    .getByRole("button", { name: "Personalizar painel da visão geral", exact: true })
    .click();
  await customizeDialog
    .getByRole("heading", { name: "Personalizar painel", exact: true })
    .waitFor();
  assert.equal(
    await page.locator("#overview-pref-contract-trends").isDisabled(),
    true,
  );
  assert.equal(await page.locator("#overview-pref-agenda").isDisabled(), true);
  assert.equal(
    await page.locator("#overview-pref-revenue").isDisabled(),
    false,
  );
  await customizeDialog
    .locator('[data-slot="dialog-footer"]')
    .getByRole("button", { name: "Fechar", exact: true })
    .click();
  await customizeDialog.waitFor({ state: "hidden" });

  assert.deepEqual(errors, []);

  check(
    "Logout e novo login com outra conta no mesmo contexto isola preferências por escopo de sessão e restringe widgets e favoritos sem permissão",
  );

  await writeFile(
    new URL(
      `../docs/integracao-v0/evidencias/${process.env.WORKSPACE_PREFERENCES_EVIDENCE ?? "integracao-preferencias-workspace.json"}`,
      import.meta.url,
    ),
    JSON.stringify(
      {
        ok: true,
        base,
        verified_at: new Date().toISOString(),
        backend:
          "Go/PostgreSQL isolados; preferências no navegador por usuário e escopo de sessão",
        checks,
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  console.error(checks);
  console.error((await page.locator("body").innerText()).slice(-4000));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
