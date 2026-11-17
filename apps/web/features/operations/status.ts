import { canonicalErpPath } from "./navigation";
import { hasPage, pageList, pageTitles } from "./pages";
export function integrationStatus(pathname: string): "connected" | "pending" {
  return hasPage(canonicalErpPath(pathname)) ? "connected" : "pending";
}
export function operationalTitle(pathname: string): string | undefined {
  if (pageTitles[pathname]) return pageTitles[pathname];
  // Páginas internas (/rede/olts/<id>, /rede/caixas/<id>) herdam o título da página que as atende.
  const nested = pageList.find(
    (page) =>
      "nested" in page &&
      page.nested &&
      page.title &&
      pathname.startsWith(`${page.paths[0]}/`),
  );
  return nested?.title;
}
