import { chromium } from "playwright";
import assert from "node:assert/strict";
import { csrf } from "./csrf.mjs";

const base = process.env.BASE ?? "http://127.0.0.1:3000";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const admin = await browser.newContext();
const subscriber = await browser.newContext();
const staffPage = await admin.newPage();
const portalPage = await subscriber.newPage();
const token = Date.now();
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwaDgAAAJUAXHIMWMAAAAAAElFTkSuQmCC",
  "base64",
);
async function request(ctx, path, method = "GET", data) {
  const response = await ctx.request.fetch(`${base}/api${path}`, {
    method,
    headers: await csrf(ctx, base),
    ...(data === undefined ? {} : { data }),
  });
  assert.ok(response.ok(), `${method} ${path}: ${await response.text()}`);
  return response;
}
let original, originalLogo;
try {
  await request(admin, "/auth/login", "POST", {
    email: "admin@alfa.demo",
    password: "demo1234",
  });
  original = await (await request(admin, "/tenant-branding")).json();
  if (original.logo)
    originalLogo = (
      await (await request(admin, "/tenant-branding/logo")).body()
    ).toString("base64");
  const person = await (
    await request(admin, "/subscribers", "POST", {
      name: `Assinante marca ${token}`,
    })
  ).json();
  const email = `marca-${token}@example.invalid`;
  await request(admin, `/subscribers/${person.id}/portal-access`, "POST", {
    email,
    password: "portal-validacao-123",
  });
  await request(subscriber, "/auth/login", "POST", {
    email,
    password: "portal-validacao-123",
  });
  const defaultName = (await (await request(subscriber, "/me")).json()).tenant.name;
  await staffPage.goto(`${base}/configuracoes`);
  const panel = staffPage
    .locator("section, article, div")
    .filter({
      has: staffPage.getByRole("heading", {
        name: "Marca no portal do assinante",
      }),
    })
    .filter({ has: staffPage.getByLabel("Nome de exibição") })
    .last();
  await panel.getByLabel("Nome de exibição").fill("Marca sintética");
  await panel
    .getByLabel("Logotipo")
    .setInputFiles({
      name: "sintetico.png",
      mimeType: "image/png",
      buffer: png,
    });
  await panel.getByAltText("Prévia do logotipo").waitFor();
  await panel.getByRole("button", { name: "Salvar", exact: true }).click();
  await staffPage.waitForFunction(
    async () =>
      (await (await fetch("/api/tenant-branding")).json()).display_name ===
      "Marca sintética",
  );
  await portalPage.goto(`${base}/portal`);
  await portalPage
    .getByLabel("Identidade do provedor")
    .getByText("Marca sintética")
    .waitFor();
  const logo = portalPage.getByAltText("Logotipo de Marca sintética");
  await logo.waitFor();
  await logo.evaluate((image) => {
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)
      return;
    return new Promise((resolve, reject) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", () => reject(new Error("Logotipo não carregou")), { once: true });
      if (image.complete)
        reject(new Error("Logotipo não carregou"));
    });
  });
  assert.ok(await logo.evaluate((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0));
  await panel.getByRole("button", { name: "Usar nome do provedor" }).click();
  await panel.getByRole("button", { name: "Remover logotipo" }).click();
  await panel.getByRole("button", { name: "Salvar", exact: true }).click();
  await staffPage.waitForFunction(async () => {
    const b = await (await fetch("/api/tenant-branding")).json();
    return b.display_name === null && b.logo === null;
  });
  const brandingReload = portalPage.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/tenant-branding" && response.ok(),
  );
  await portalPage.reload();
  await brandingReload;
  const identity = portalPage.getByLabel("Identidade do provedor");
  await identity.getByText(defaultName, { exact: true }).waitFor();
  await identity.locator("img").waitFor({ state: "hidden" });
  assert.equal(await identity.locator("img").count(), 0);
  console.log("Marca salva, exibida ao assinante e removida.");
} finally {
  if (original)
    await request(
      admin,
      "/settings/portal-branding",
      "PUT",
      originalLogo
        ? {
            display_name: original.display_name,
            logo_action: "replace",
            logo_content_base64: originalLogo,
          }
        : { display_name: original.display_name, logo_action: "remove" },
    );
  await admin.close();
  await subscriber.close();
  await browser.close();
}
