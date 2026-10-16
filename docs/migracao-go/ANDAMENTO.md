# Migração em execução — 16/10/2026

Autorização vigente: prosseguir por todas as fases sem novas perguntas. D1 (adaptação dos testes) e D2 (desligamento das rotinas Node quando substituídas) estão autorizadas no plano. A autorização amplia a implementação; não substitui as medições, os ensaios e o tempo de observação exigidos para declarar a virada operacional concluída.

## Implementação disponível neste ponto

- 344 rotas com implementação nativa Go: todas as fases do inventário. São 334 operações HTTP no OpenAPI e dez rotas de agentes no listener separado. O manifesto completo é `apps/api-go/rotas.json`; não há encaminhamento de negócio para o Node.
- Caddy com tabela versionada das 344 rotas, distinção por método e segmentos, canários de 1%, 10% e 50%, volta por recarga e logs JSON de rota/destino. Agentes continuam fora do proxy, conforme o plano.
- Sobreposição `infra/prod/docker-compose.go.yml` e imagem do Caddy com o build do painel. A tabela versionada permanece integralmente em `fastify`; os ensaios de roteamento são descartáveis.
- Registros de permissão ligados às operações, incluindo MFA pendente em `/api/me`, métricas por padrão de rota e HEAD equivalente. SQL das consultas revisadas e o template da página pública possuem extração reproduzível e verificação de deriva.
- Migration 57 otimiza a implementação de `subscriber_in_pops` com agregação e plano genérico local à função. Mantém o predicado de RLS e as verificações de escrita, incluindo cadastro com `INSERT ... RETURNING`. As 53 migrations congeladas permanecem intactas.
- O adaptador D1 em `apps/api/test/helpers.ts` aceita `NEXO_TEST_BASE_URL`. O backend de teste roda no processo do Vitest; assim os simuladores e as alterações locais de configuração continuam funcionando através do proxy. O contexto que reproduz `remoteAddress` é assinado com chave efêmera e existe apenas no adaptador de teste.

## Verificações já executadas

| Ensaio | Resultado |
|---|---|
| Fase 1 após expansão inicial | 591/591; cache 12/12 |
| Fase 2, respostas, filtros, CSV, portal e sentinelas | 794/794 |
| Primeiro lote de consultas simples F3 | 1.941/1.941 em 55 rotas |
| Leituras compostas, auxiliares e paginadas F3 | 1.098/1.098 em 30 rotas |
| Últimas 17 leituras F3: busca, linha do tempo, agenda, CGNAT, financeiro e RADIUS | 819/819, com dados positivos e oráculos independentes |
| Página pública de aviso | 12/12; bytes HTML, escape, cabeçalhos e HEAD |
| Predicado POP contra SQL independente | 39/39, incluindo INSERT/UPDATE com RETURNING |
| Caddy real: pesos e retorno | 100 requisições por estado; pesos exatos, método/caminho isolados e recarga exercitada |
| Regressão original através do Caddy | **41 arquivos, 192 testes aprovados** |
| Painel através do Caddy, Playwright original | teste de fumaça aprovado, com os cenários de painel e portal |
| Go e lint | compilação/testes aprovados; zero problemas no lint |
| Imagem Go e roteamento final | imagem Docker compilada; Caddy final validado pelo binário real |
| Consolidação das escritas | 20 verificações; inclui idempotência e baixa/estorno misturados com Fastify |
| Agente Python real contra Go | sincronização, assinatura Ed25519, reserva, execução e confirmação aprovadas |
| River real e RADIUS integrado | schema/migrations, provisionamento, accounting, cleanup e gateway assinado/idempotente aprovados em processo descartável |
| mTLS Go | CA, identidade, fixação e rejeição de conexão sem certificado aprovadas |
| Inventário final | 344/344 rotas presentes, sem extras; Compose final validado |

Os resultados das baterias extensas acima são históricos, anteriores às últimas escritas. Essas baterias não foram repetidas por rota: a pedido do usuário, a validação final foi concentrada nos fluxos críticos. Isso deixa a paridade exaustiva das novas rotas e as integrações externas para homologação.

Os relatórios completos locais ficam em `tests/contrato/relatorios/`. As evidências históricas da carga original continuam em `evidencias-fase-1/`.

## Implantação e critérios ainda pendentes

A implementação das escritas, identidade, integrações, API pública, importação, financeiro, agentes, executor RADIUS e rotinas River está disponível. A configuração final está preparada separadamente em `infra/prod/docker-compose.go-final.yml`; o procedimento e a volta à coexistência estão em [EXECUCAO_GO.md](EXECUCAO_GO.md). A configuração produtiva vigente não foi alterada.

O portão de desempenho da fase 1 ainda está pendente. A otimização da função POP reduziu uma consulta isolada do maior provedor sintético de aproximadamente 4,2 s para 2,9 s; isso não é uma nova prova de capacidade HTTP nem substitui o ensaio completo. A técnica final mantém a semântica de criação de assinantes e não adiciona função que enumere identificadores ocultos por POP.

Os sete dias de linha de base, canários, consolidação de 30 dias e fechamento mensal financeiro ainda não ocorreram. Nenhuma configuração produtiva foi recarregada nem há alegação de tráfego produtivo migrado. A implementação e os ensaios continuam no laboratório.
