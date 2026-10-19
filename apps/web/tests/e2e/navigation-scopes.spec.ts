import { test, expect } from "@playwright/test";
import { navigationPages } from "../../lib/navigation";
import { resolveNavigationRoute } from "../../lib/navigation-route";
import { readFileSync } from "node:fs";

const isDemoMode = JSON.parse(readFileSync(new URL("../../execution.config.json", import.meta.url), "utf8")).mode === "demo";
const scopes = navigationPages.filter(node => resolveNavigationRoute(node.href).kind === "scope");
const modules = [...new Set(scopes.map(node => node.moduleHref))];

test.describe("escopos previstos: navegação sem falsa implementação", () => {
  test.skip(!isDemoMode, "Auditoria limitada ao modo demonstrativo explícito.");

  for (const moduleHref of modules) {
    test(`escopos do módulo ${moduleHref}`, async ({ page }, testInfo) => {
      const nodes = scopes.filter(node => node.moduleHref === moduleHref);
      test.setTimeout(Math.max(45_000, nodes.length * 15_000));
      const operationalRequests: string[] = [];
      const runtimeErrors: string[] = [];
      const results: { href: string; label: string; status: number | undefined }[] = [];
      page.on("request", request => {
        if (/\/(?:api\/(?:workspace|auth)(?:\/|$)|eve\/v1(?:\/|$))/.test(new URL(request.url()).pathname)) operationalRequests.push(request.url());
      });
      page.on("pageerror", error => runtimeErrors.push(error.message));
      for (const node of nodes) {
        await test.step(node.href, async () => {
          const response = await page.goto(node.href, { waitUntil: "domcontentloaded" });
          expect(response?.ok(), node.href).toBe(true);
          const main = page.locator("main");
          await expect(main.getByRole("heading", { name: node.label, exact: true })).toBeVisible();
          await expect(main.getByText("Implementação funcional pendente", { exact: true })).toBeVisible();
          await expect(main.getByRole("link", { name: "Ver cobertura e evidências" })).toHaveAttribute("href", "/acompanhamento");
          await expect(main.locator("form")).toHaveCount(0);
          results.push({ href: node.href, label: node.label, status: response?.status() });
        });
      }
      expect(operationalRequests).toEqual([]);
      expect(runtimeErrors).toEqual([]);
      await testInfo.attach("escopos-auditados", { body: JSON.stringify({ moduleHref, results, operationalRequests, runtimeErrors }, null, 2), contentType: "application/json" });
    });
  }
});
