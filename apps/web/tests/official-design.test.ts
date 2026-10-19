import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const original = path.resolve("../../docs/novo-design-nexoISP");
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function files(directory: string): string[] { return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]); }
test("todos os componentes ui e os estilos oficiais preservam o código original do v0", () => {
 for (const file of [...files("components/ui"), "src/globals.css", "src/fonts.css"]) assert.equal(hash(file), hash(path.join(original, file)), file);
});
test("código da referência original continua integralmente preservado", () => {
 const manifest = JSON.parse(readFileSync("../../docs/integracao-v0/referencia-v0.sha256.json", "utf8")) as Record<string,string>;
 for (const [file, checksum] of Object.entries(manifest)) assert.equal(hash(path.join(original, file)), checksum, file);
});
test("aplicação oficial não importa páginas, componentes ou estilos do frontend antigo", () => {
 for (const directory of ["src", "components", "features", "data", "platform", "application"]) for (const file of files(directory).filter(file => /\.[jt]sx?$/.test(file))) assert.doesNotMatch(readFileSync(file, "utf8"), /(?:from\s*|import\s*\()["'][^"']*(?:web-legacy|legacy\/src|styles\.css)/, file);
});
