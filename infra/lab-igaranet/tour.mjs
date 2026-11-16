// Roteiro de verificação da interface do IgaraNet num navegador real (imagem do Playwright deste servidor).
// Uso: ver docs/lab-igaranet.md, seção "Verificar pela interface".
import { chromium } from "playwright";
import crypto from "node:crypto";
const B = "http://127.0.0.1:18380";
function totp(secret) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase()) bits += a.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac("sha1", key).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, "0");
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(B + "/login");
await page.locator('input[type="email"]').fill(process.env.EMAIL);
await page.locator('input[type="password"]').fill(process.env.SENHA);
await page.locator('button[type="submit"]').click();
await page.waitForTimeout(1500);
const code = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]');
if (await code.count()) { await code.first().fill(totp(process.env.TOTP)); await page.locator('button[type="submit"]').click(); }
await page.waitForTimeout(2500);
console.log("após login:", page.url());
for (const [nome, rota] of (process.env.ROTAS || "").split(",").map(x => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)])) {
  await page.goto(B + rota); await page.waitForTimeout(4000);
  if (process.env.ABA) { await page.getByRole("tab", { name: process.env.ABA }).click(); await page.waitForTimeout(3000); }
  if (process.env.ROLAR) { const el = page.getByText(process.env.ROLAR, { exact: false }).first(); await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(800); }
  if (process.env.CLICAR) {
    await page.getByRole("button", { name: process.env.CLICAR }).click();
    await page.getByRole("button", { name: "Confirmar" }).click();
    console.log("clicado:", process.env.CLICAR, new Date().toISOString());
    await page.waitForTimeout(12000);
    const el = page.getByText(process.env.ROLAR, { exact: false }).first(); await el.scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: `/out/${nome}.png`, fullPage: false });
  const txt = (await page.locator(process.env.ABA ? "[role=dialog]" : "main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 700);
  console.log(`== ${nome} ${rota}\n${txt}\n`);
}
await browser.close();
