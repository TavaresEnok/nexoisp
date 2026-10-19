import test from "node:test";
import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { NavigationProvider, usePathname, useRouter, useSearchParams, type NavigationAdapter } from "../platform/navigation/react";
import { useQueryState, useReplaceQueryValues } from "../lib/use-query-state";
import { useNetworkFilters } from "../lib/use-network-filters";
import { updateQueryHref } from "../platform/navigation/query";

function Probe() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  router.push("/contratos");
  return <p>{pathname}:{params.get("busca")}</p>;
}
test("componentes leem localização e navegam com adaptador sem Next", () => {
  const destinations: string[] = [];
  const adapter: NavigationAdapter = { pathname: "/assinantes", search: "busca=Mariana", getSearch: () => "busca=Mariana", push: href => { destinations.push(href); }, replace: () => {}, refresh: () => {}, replaceQuery: () => {} };
  assert.equal(renderToStaticMarkup(<NavigationProvider adapter={adapter}><Probe /></NavigationProvider>), "<p>/assinantes:Mariana</p>");
  assert.deepEqual(destinations, ["/contratos"]);
});

function FilterProbe() {
  const [query, setQuery] = useQueryState("busca", "");
  const [status, setStatus] = useQueryState("situacao", "Todos", ["Todos", "Ativo"]);
  const [, setFilters] = useNetworkFilters({ visibility: "online" });
  const replaceQuery = useReplaceQueryValues();
  setQuery(previous => `${previous} Oliveira`);
  setStatus("Ativo");
  setFilters(previous => ({ ...previous, pop: "POP Centro" }));
  setFilters(previous => ({ ...previous, nas: "NAS Centro" }));
  replaceQuery({ ficha: "sub-1", abaFicha: "cadastro" });
  return <p>{query}:{status}</p>;
}

test("filtros, updates funcionais e ficha usam só o adaptador e compõem a URL mais recente", () => {
  let href = "/assinantes?busca=Mariana&keep=1#table";
  const adapter: NavigationAdapter = {
    pathname: "/assinantes", search: "busca=Mariana&keep=1",
    getSearch: () => new URL(href, "https://test.invalid").search,
    push: () => {}, replace: () => {}, refresh: () => {},
    replaceQuery: values => { href = updateQueryHref(href, values); },
  };
  assert.equal(renderToStaticMarkup(<NavigationProvider adapter={adapter}><FilterProbe /></NavigationProvider>), "<p>Mariana:Todos</p>");
  const url = new URL(href, "https://test.invalid");
  assert.equal(url.searchParams.get("busca"), "Mariana Oliveira");
  assert.equal(url.searchParams.get("situacao"), "Ativo");
  assert.equal(url.searchParams.get("rede_pop"), "POP Centro");
  assert.equal(url.searchParams.get("rede_nas"), "NAS Centro");
  assert.equal(url.searchParams.get("rede_visibility"), "online");
  assert.equal(url.searchParams.get("ficha"), "sub-1");
  assert.equal(url.searchParams.get("abaFicha"), "cadastro");
  assert.equal(url.searchParams.get("keep"), "1");
  assert.equal(url.hash, "#table");
});

function PageFilterProbe() {
 const [,search] = useQueryState("busca", "", undefined, { resetPage: true });
 const replace = useReplaceQueryValues();
 search("Titular"); replace({ fatura: "fatura-real" });
 return null;
}
test("busca paginada reinicia a página na mesma navegação e preserva a ficha aberta em seguida", () => {
 let href = "/financeiro/faturas?pagina=2&keep=1";
 const calls: unknown[] = [];
 const adapter: NavigationAdapter = { pathname:"/financeiro/faturas",search:"pagina=2&keep=1",getSearch:()=>new URL(href,"https://test.invalid").search,push:()=>{},replace:()=>{},refresh:()=>{},replaceQuery: values=>{calls.push(values);href=updateQueryHref(href,values);} };
 renderToStaticMarkup(<NavigationProvider adapter={adapter}><PageFilterProbe /></NavigationProvider>);
 assert.deepEqual(calls,[{busca:"Titular",pagina:null},{fatura:"fatura-real"}]);
 const params=new URL(href,"https://test.invalid").searchParams;
 assert.equal(params.has("pagina"),false);assert.equal(params.get("fatura"),"fatura-real");assert.equal(params.get("keep"),"1");
});
