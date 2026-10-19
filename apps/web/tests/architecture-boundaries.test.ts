import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
function files(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(`${directory}/${entry.name}`) : /\.tsx?$/.test(entry.name) ? [`${directory}/${entry.name}`] : []);
}
test("núcleo puro e leitores demo não dependem de React, Next, Node, banco ou navegador", () => {
  const seen = new Set<string>();
  function inspect(relative: string) {
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = readFileSync(path.join(root, relative), "utf8");
    const runtime = source.replace(/(?:import|export)\s+type\s+[\s\S]*?from\s+["'][^"']+["'];?/g, "");
    assert.doesNotMatch(runtime, /\b(?:window|document|navigator)\./, relative);
    for (const match of runtime.matchAll(/(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      assert.doesNotMatch(specifier, /^(?:react(?:-dom)?(?:\/|$)|next(?:\/|$)|node:|pg$|drizzle-orm|server-only)|\/db(?:\/index)?$/, `${relative}: ${specifier}`);
      if (!specifier.startsWith(".") || specifier.endsWith(".json")) continue;
      const target = path.normalize(path.join(path.dirname(relative), specifier));
      const file = [target, `${target}.ts`, `${target}.tsx`].find(name => existsSync(path.join(root, name)));
      if (file && /\.tsx?$/.test(file)) inspect(file);
    }
  }
  [...files("domain"), ...files("application"), ...files("data/demo")].forEach(inspect);
});

test("componentes do workspace não importam mais Next diretamente", () => {
  for (const file of files("components").filter(file => !file.includes("/agent-ui/") && !file.includes("/ai-elements/"))) {
    assert.doesNotMatch(readFileSync(path.join(root, file), "utf8"), /from\s+["']next\//, file);
  }
});
