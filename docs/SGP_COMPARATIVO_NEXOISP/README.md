# Auditoria comparativa SGP → NexoISP

Auditoria iniciada em 17/10/2026, sobre o código local posterior a `945ccd7`, incluindo alterações locais. O dossiê agora é independente de `docs/SGP/`: os originais foram arquivados fora do projeto, após conferência dos 1.207 arquivos. A [consolidação e retirada](consolidacao.md) registra a revisão e a localização da cópia privada. Este trabalho **não certifica equivalência integral nem prontidão de produção**.

## Resultados e navegação

| Artefato | Conteúdo |
|---|---|
| [Diagnóstico](diagnostico.md) | O que existe no NexoISP, lacunas de domínio e limites das evidências |
| [Matriz de capacidades](matriz_capacidades.csv) | 45 capacidades revisadas, arquivos, rotas, persistência, diferenças, prioridade, aceite e validação |
| [Matriz de superfícies](matriz_superficies.csv) | 388 rotas, 480 entradas de menu, 334 operações estruturais e 44 formulários internos, individualizados |
| [Campos dos formulários adicionais](campos_44_formularios.csv) | 956 controles revisados: destinação, correspondência parcial ou lacuna, proposta, aceite e limites |
| [Revisão dos 101 menus](revisao_101_menus.csv) | Cada título sem rota associado a tema e decisão, sem presumir operação |
| [Formulários revisados](formularios_revisados.json) | Escopo e especificação proposta de cada um dos 44 formulários |
| [Evidências consolidadas](evidencias.md) | Conhecimento relevante, limites e origem das conclusões |
| [Evidências estruturadas](evidencias_sanitizadas.json) | 1.246 referências independentes dos espelhos, sem registros ou valores |
| [Resumo da revisão de campos](resumo_revisao_campos.json) | Controles por destinação; revisão documental não equivale a regra aprovada |
| [Rotas NexoISP](rotas_nexo.csv) | Inventário nativo de operações e capacidades candidatas; presença não comprova execução |
| [Backlog e dependências](backlog.md) | Entregas encerradas, próximos fluxos e decisões necessárias |
| [Decisões](decisoes.md) | Critérios de implementação, separação de sistemas e proteção dos materiais |
| [Melhorias e validação](melhorias-e-validacao.md) | Problema, solução, preservação de capacidade, medição e resultados |
| [Registro de execução](execucao.json) | Comandos, resultados reais, escopo e limitações dos ensaios |
| [Originais inspecionados](originais_inspecionados.json) | Estrutura extraída diretamente dos 286 HTML das duas coletas, sem copiar valores ou registros |
| [Hashes das fontes](fontes_sha256.json) | Inventário histórico dos 1.207 arquivos; confere a cópia privada opcional |
| [Resumo do inventário](resumo_inventario.json) | Contagens e estado atual da consolidação |
| [Retirada dos originais](retirada_fontes.json) | Recibo da cópia privada, hash, permissões e remoção local |
| [Manifesto do dossiê](manifesto_consolidado.json) | Integridade dos artefatos versionáveis após a retirada das fontes |

As matrizes CSV podem ser abertas em planilha. Caminhos da coluna `frontend` partem de `apps/web/src/pages` (exceto `App.tsx`, na raiz de `src`); caminhos de `backend` partem de `apps/api-go/internal`, salvo os que começam em `services`, `scripts`, `tools`, `docs` ou `cmd`.

## O que as contagens significam

Não há 1.246 funcionalidades homologadas: há 1.246 superfícies, com repetição de rotas, ações e variantes. As 956 ocorrências incluem controles ocultos e subformulários; não são 956 entidades nem requisitos aprovados. As 45 capacidades são agrupamentos de análise, não o inventário definitivo do SGP.

A matriz de capacidades contém revisão semântica de fluxos selecionados. A associação das superfícies a capacidades é **triagem por domínio**; não transfere o resultado de um teste para todas as páginas do grupo. Os 101 títulos sem rota foram revisados individualmente, com associação temática e limites. Os 956 controles receberam destinação documental; correspondências parciais têm destino e evidência no código. Campos restantes têm proposta/questão explícita, inclusive descarte da representação técnica. Regras fiscais, comerciais, de rede e conectores ainda dependem de especificação/aprovação: essa pendência foi preservada, não declarada implementada.

Classificações utilizadas: implementado e verificado; implementado, mas ainda não verificado; parcialmente implementado; apenas interface/mock/simulação; ausente; não aplicável com justificativa; dependente de especificação adicional. Um estado verificado vale somente para o cenário descrito na própria linha.

## Reprodução

```bash
python3 scripts/auditoria-sgp.py --check  # valida matrizes, decisões, referências e hashes do dossiê; não usa originais
python3 tests/contrato/sgp_auditoria.py   # API + PostgreSQL sintéticos; não lê .env do produto
```

Depois de uma edição documental revisada, `python3 scripts/auditoria-sgp.py --atualizar-manifesto` atualiza os hashes. O script não volta a coletar o SGP nem inventa novos resultados. A cópia privada só é necessária para consulta histórica excepcional; o desenvolvimento e a validação normal não dependem dela. Não reutilizar credenciais/cookies do arquivo, executar seus scripts ou importar registros como fixtures. Os hashes fixam o material recebido, sem provar sua autenticidade anterior.
