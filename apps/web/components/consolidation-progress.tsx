"use client";

import { useQueryState } from "@/lib/use-query-state";
import Link from "@/platform/navigation/link";
import { ArrowUpRight, Download, FileSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Panel, PageHeading, DemoNotice } from "@/components/workspace-ui";
import { EmptyState } from "@/components/workspace-feedback";
import { features, filterFeatures } from "@/lib/consolidation/features";
import { exportCsv } from "@/lib/format";

type Source = { id: string; name: string; fileCount: number; treeSha256: string; evidenceCount: number };
export function ConsolidationProgress({ sources, totalFiles, archiveHash }: { sources: Source[]; totalFiles: number; archiveHash: string }) {
  const [query, setQuery] = useQueryState("busca", "");
  const [stage, setStage] = useQueryState("etapa", "Todos", ["Todos", "Consulta parcial", "Núcleo preparado", "Pendente"]);
  const rows = filterFeatures(query, stage);
  const coreCount = features.filter(feature => feature.stage === "Núcleo preparado").length;
  const summaries = [
    [String(sources.length), "origens identificadas", `${totalFiles} arquivos no ZIP original`],
    [String(features.length), "escopos rastreados", "Inventário preservado da primeira base"],
    [String(coreCount), "núcleos preparados", "Regras com testes, ainda sem escrita nas telas"],
    [String(features.filter(feature => Object.values(feature.acceptance).every(Boolean)).length), "escopos completos", "Exige os quatro critérios de aceite comprovados"],
  ];
  return (
    <div className="flex flex-col gap-6 [&>.page-heading]:mb-0">
      <PageHeading eyebrow="DA ORIGEM À EVIDÊNCIA" title="Consolidar é comprovar." description="O que veio de cada versão, o que existe hoje e o que ainda precisa funcionar de ponta a ponta." actions={<Button variant="outline" onClick={() => exportCsv("nexo-matriz-de-consolidacao", ["ID", "Escopo", "Origens", "Etapa", "Tela atual", "Implementação", "Testes", "Pendências"], rows.map(feature => [feature.id, feature.name, feature.origins.join(", "), feature.stage, feature.route ?? "Sem tela", feature.implementation.join("; "), feature.tests.join("; "), feature.remaining]))}><Download data-icon="inline-start" />Exportar matriz</Button>} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summaries.map(([value, title, detail]) => <Panel key={title} title={title} description={detail}><p className="font-mono text-3xl font-semibold tracking-tight">{value}</p></Panel>)}
      </div>
      <Panel title="Etapas diferentes. Critérios explícitos." description="Uma tela no menu não é uma funcionalidade concluída.">
        <div className="grid gap-5 md:grid-cols-3">
          {[
            ["Consulta parcial", "Há uma tela de consulta, filtros ou exportação. Isso não comprova o escopo completo da origem."],
            ["Núcleo preparado", "As regras têm testes e um repositório transacional testado no Neon. As telas continuam somente leitura; faltam sessão autenticada e ações de escrita conectadas."],
            ["Pendente", "O recurso está registrado para não se perder, mas ainda não foi implementado nesta versão."],
          ].map(([title, detail]) => <div key={title} className="flex flex-col items-start gap-2"><Badge variant="outline">{title}</Badge><p className="text-sm leading-relaxed text-muted-foreground">{detail}</p></div>)}
        </div>
      </Panel>
      <Panel title="Matriz de consolidação" description="Abra um escopo para conferir arquivos, testes e trabalho restante." action={<Badge variant="secondary" data-testid="coverage-count" aria-live="polite">{rows.length} de {features.length} escopos</Badge>} className="list-panel">
        <div className="flex flex-col gap-4 p-5">
          <Field><FieldLabel htmlFor="coverage-search">Buscar escopo, ID ou origem</FieldLabel><Input id="coverage-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Ex.: assinantes, C01, 8022…" /></Field>
        </div>
        <Tabs value={stage} onValueChange={value => setStage(String(value))}>
          <div className="px-5 pb-3">
            <TabsList variant="line" className="max-w-full overflow-x-auto" aria-label="Etapa da consolidação">
              {["Todos", "Consulta parcial", "Núcleo preparado", "Pendente"].map(value => <TabsTrigger key={value} value={value}>{value}</TabsTrigger>)}
            </TabsList>
          </div>
          <TabsContent key={stage} value={stage}>
        {rows.length ? <Table>
          <TableHeader><TableRow><TableHead>ID</TableHead><TableHead>Escopo e evidências</TableHead><TableHead>Etapa</TableHead><TableHead>Origens</TableHead><TableHead><span className="sr-only">Tela de consulta</span></TableHead></TableRow></TableHeader>
          <TableBody>{rows.map(feature => <TableRow key={feature.id}>
            <TableCell className="align-top font-mono">{feature.id}</TableCell>
            <TableCell className="min-w-64 max-w-xl whitespace-normal align-top">
              <details><summary className="cursor-pointer font-medium">{feature.name}</summary>
                <div className="flex flex-col gap-3 py-3 text-sm">
                  <p>{feature.scope}</p>
                  <p><strong>{feature.disposition}:</strong> {feature.decision}</p>
                  <ul className="flex flex-col gap-1" aria-label="Critérios de aceite">{[["Interface disponível", feature.acceptance.interface], ["Regras de negócio testadas", feature.acceptance.businessRules], ["Persistência autorizada por sessão", feature.acceptance.authorizedPersistence], ["Percurso completo verificado", feature.acceptance.endToEnd]].map(([label, verified]) => <li key={String(label)}>{verified ? "Comprovado" : "Não comprovado"} · {label}</li>)}</ul>
                  <p className="text-muted-foreground">{feature.remaining}</p>
                  <div><strong>Implementação atual</strong>{feature.implementation.length ? feature.implementation.map(path => <p key={path} className="break-all font-mono text-xs">{path}</p>) : <p className="text-muted-foreground">Sem implementação.</p>}</div>
                  <div><strong>Testes de referência</strong>{feature.tests.length ? feature.tests.map(path => <p key={path} className="break-all font-mono text-xs">{path}</p>) : <p className="text-muted-foreground">Sem evidência automatizada específica.</p>}</div>
                  <p className="text-muted-foreground">Rota prevista no inventário original: <code className="break-all">{feature.originalRoute}</code>. Não significa que essa rota exista nesta versão.</p>
                </div>
              </details>
            </TableCell>
            <TableCell className="align-top"><Badge variant={feature.stage === "Núcleo preparado" ? "secondary" : "outline"}>{feature.stage}</Badge></TableCell>
            <TableCell className="max-w-40 whitespace-normal align-top font-mono text-xs">{feature.origins.join(" · ")}</TableCell>
            <TableCell className="align-top">{feature.route ? <Link href={feature.route} className={buttonVariants({ variant: "ghost", size: "sm" })} aria-label={`Consultar ${feature.name}`}>Consultar<ArrowUpRight data-icon="inline-end" /></Link> : <span className="text-xs text-muted-foreground">Sem tela</span>}</TableCell>
          </TableRow>)}</TableBody>
        </Table> : <EmptyState icon={FileSearch} title="Nenhum escopo corresponde aos filtros."><Button variant="outline" onClick={() => { setQuery(""); setStage("Todos"); }}>Limpar filtros</Button></EmptyState>}
          </TabsContent>
        </Tabs>
      </Panel>
      <Panel title="Nove origens. Evidência preservada." description="Identificação estática dos projetos anexados, com contagem de arquivos e SHA-256 de cada árvore. Não é uma validação visual ou funcional das nove versões.">
        <div className="grid gap-4 md:grid-cols-3">
          {sources.map(source => <details key={source.id} className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">{source.name}<span className="ml-2 text-xs text-muted-foreground">{source.fileCount} arquivos</span></summary>
            <div className="mt-3 flex flex-col gap-2 text-xs text-muted-foreground"><p>{source.evidenceCount} arquivos de interface e domínio identificados no manifesto.</p><p>SHA-256 da árvore:</p><code className="break-all">{source.treeSha256}</code></div>
          </details>)}
        </div>
        <details className="mt-5 text-xs text-muted-foreground"><summary className="cursor-pointer">Ver método e identificação do ZIP</summary><div className="mt-3 flex flex-col gap-2"><p>SHA-256 do arquivo original:</p><code className="break-all">{archiveHash}</code><p>Manifesto: lib/consolidation/sources.json. Reprodução: scripts/inspect-sources.py. O hash da árvore usa linhas caminho:sha256 ordenadas, separadas por LF, sem LF final.</p></div></details>
      </Panel>
      <DemoNotice>O cenário público permanece intacto e somente leitura. O repositório privado foi testado no Neon com rollback dos dados sintéticos, mas não há sessão autenticada nem rota pública de execução de comandos. Equipamentos, bancos de cobrança e canais externos não foram acionados. A consolidação integral ainda não foi concluída.</DemoNotice>
    </div>
  );
}
