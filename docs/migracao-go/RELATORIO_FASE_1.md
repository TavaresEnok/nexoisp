# Relatório da fase 1 — 16/10/2026

Estado: **implementação entregue em laboratório; fase 1 pendente no portão de desempenho**. Ramo `migracao-go/fase-1`. Não foram iniciadas as fases 0 ou 2.

## Entregas

- API em `apps/api-go`: chi/Huma, pgx/sqlc, serialização compatível, validação Zod, CSV, autenticação por Bearer/cookie, suporte, MFA pendente, permissões, módulos, POPs, limite por sessão e auditoria.
- Apenas as três leituras previstas, com HEAD implícito equivalente ao Fastify. Saúde, métricas e OpenAPI em outro listener.
- Cache Ristretto de 5 segundos, índices por usuário/tenant, expiração da sessão, geração para impedir reinserção concorrente após invalidação e desligamento do cache quando LISTEN cai.
- 53 migrations copiadas sem mudar o SQL, manifest de hashes, adoção goose, invalidação e diretório de células com RLS. CLI `bootstrap`, `baseline`, `up` e `verificar`.
- Harness independente do proxy, esperado calculado como dono com filtros explícitos, comparação HTTP, auditoria, testes de cache, pool de uma conexão e 17 mutações. `./nexo contrato up|run|mutacoes|migrations|carga|down`.
- Workflow `.github/workflows/go.yml` com paridade, deriva, sqlc reproduzível, lint, testes com detector de concorrência, contrato, migrations e mutações. Os checks foram exercitados localmente; o workflow remoto ainda não foi executado.

## Ajustes em relação ao prompt

1. `session_get` continua inalterada. A migration 55 adiciona `nexo_go_session_get`, restrita ao papel Go e incluindo `expires_at`.
2. `bootstrap --init-app-role` cria `nexo_app` somente se ausente em cluster novo; sem a opção, recusa sua ausência. Não redefine senha do papel Node existente. `baseline` recusa banco parcial, nomes desconhecidos e adoção repetida.
3. `tenant_cells` recebe RLS, leitura escopada, função restrita para carregar metadados do diretório e notificações de atualização.
4. CSRF e módulo são exercitados no middleware de teste; portal é exercitado diretamente com RLS. Os três GETs do núcleo não permitem demonstrar essas proteções apenas por HTTP público. Nenhuma rota adicional de negócio foi criada.
5. Os efeitos `export.csv` e `access.denied` são conferidos no banco apesar de as rotas serem GET. `auditoria_fora_da_tx` não se aplica: essas duas ações já são transações próprias no Fastify.
6. Os mutantes com dono/BYPASSRLS precisam ser recusados na partida; nenhum caso funcional privilegiado é executado no servidor Go.
7. A espera pelo pool segue o comportamento do `pg.Pool` do produto e o cancelamento da requisição. Um timeout exclusivo do Go foi removido após a medição revelar diferença sob contenção.
8. A métrica de notificação usa o instante do gatilho até o processamento, uma cota superior de commit até invalidação. Os testes também observam o efeito após a confirmação do commit. Não foi ativado `track_commit_timestamp`.

## Evidências

| Verificação | Resultado |
|---|---|
| Contrato HTTP + esperado do banco | **591/591**, zero divergências |
| Cache/invalidação real | **12/12** |
| Mutações aplicáveis | **17/17 detectadas** |
| Testes Go com detector de concorrência | aprovados, incluindo RLS/portal/POP e pool de 1 conexão |
| Lint | zero problemas; uma importação deliberada de pool fora de `internal/db` foi recusada |
| sqlc | regeneração sem diferença no código versionado |
| Cópias das migrations | 53/53, SQL e hashes idênticos |
| Imagem Docker | build e 6 verificações de portas/rotas aprovados |
| Proteção da árvore anterior | 207 arquivos conferidos, nenhuma alteração da fase em API Node/web |

As execuções completas permanecem em `tests/contrato/relatorios/`, sem credenciais nos relatórios. Evidências consolidadas estão em [`evidencias-fase-1/verificacoes.json`](evidencias-fase-1/verificacoes.json), com os detalhes de contrato, cache, migrations, imagem e cada mutação no mesmo diretório. O `go.mod` e `go.sum` fixam as dependências; ferramentas utilizadas: Go 1.27.2, sqlc 1.31.1 e golangci-lint 2.14.0.

Os dois caminhos de migration já convergiram para o mesmo `pg_dump --schema-only`, excluindo apenas controles de migration e os marcadores aleatórios `restrict` do cliente. O Fastify aplicou zero migrations após o goose em ambos os caminhos. A adoção de banco parcial foi recusada.

## Medição

Perfil: 300 mil assinantes sintéticos, 40 provedores, quatro APIs de 1 CPU com pool de 10, 45% detalhe de assinante / 40% contrato / 15% listagem, 1.000 requisições/s oferecidas, 50% cookie, usuários com e sem POP restrito e provedores com e sem módulos. Três repetições de 30 segundos por candidato após aquecimento de 15 segundos.

O PostgreSQL recebe 30 CPUs, conforme a configuração efetiva do piloto original. Uma primeira tentativa com apenas 4 CPUs foi descartada como comparação principal. A carga usa k6 diretamente nas quatro portas locais, sem o balanceador do piloto; CPU é medida por cgroup durante a execução inteira e percentis pelo k6. Provedores têm o mesmo peso nas fixtures, embora a população siga Zipf. Essas diferenças limitam a comparação com os números históricos do piloto.

Resultado final: **carga inválida nas nove rodadas**, por `dropped_iterations > 0`. Foram oferecidas aproximadamente 30.000 requisições por rodada; as conclusões abaixo incluem o período de drenagem do k6 depois dos 30 segundos de chegada. Todos os HTTPs concluídos tiveram status esperado, mas isso não compensa as requisições não iniciadas.

Os números abaixo são descritivos da saturação e **não comprovam ganho ou equivalência**. Médias ± desvio padrão amostral de três repetições:

| Candidato | CPU API (ms/req) | CPU PostgreSQL (ms/req) | P95 (ms) | P99 (ms) | Concluídas/rodada, média |
|---|---:|---:|---:|---:|---:|
| Fastify atual | 6,31 ± 0,65 | 164,57 ± 4,24 | 6.765 ± 374 | 10.129 ± 552 | 6.643 |
| Go `force_custom_plan` | 2,74 ± 0,34 | 145,99 ± 2,14 | 5.897 ± 192 | 8.335 ± 1.106 | 7.232 |
| Go `auto` | 2,28 ± 0,24 | 154,79 ± 2,96 | 5.968 ± 141 | 8.823 ± 410 | 7.529 |

O acerto médio do cache ficou em aproximadamente 53% nas duas configurações Go. Os histogramas registraram espera de pool acima do maior bucket finito (3,2768 s) nos percentis altos. A mistura inclui aproximadamente 20% de fixtures com restrição de POP. Veja [`carga-resumo.json`](evidencias-fase-1/carga-resumo.json), [`carga-medicoes.json`](evidencias-fase-1/carga-medicoes.json) e [`pool-cache-carga.json`](evidencias-fase-1/pool-cache-carga.json).

Na última janela do Fastify, a consulta de total da listagem teve média de aproximadamente 664 ms e a consulta da página, 420 ms; `session_get` ficou em cerca de 2 ms. São tempos de instrução, não CPU por SQL. Isso localiza a investigação na listagem/contagem sob as políticas de POP. O retrato está em [`consultas-ultima-janela.json`](evidencias-fase-1/consultas-ultima-janela.json). Não foi alterado SQL/política de negócio para contornar o resultado.

O hash agregado dos fontes Go atuais confere com o registrado na medição final. Tentativas anteriores, incluindo a configuração inicial de 4 CPUs de banco e a versão com timeout exclusivo do pool Go, foram descartadas da tabela; seus brutos continuam disponíveis localmente.

As execuções com POP restrito saturaram inclusive o Fastify. Requisições perdidas tornam inválida a conclusão de equivalência de desempenho, independentemente dos números isolados de CPU. A fase 2 permanece impedida até obter uma carga válida e cumprir o critério de desempenho.

## Escopo preservado e pendências

Nenhum arquivo de `apps/api/` ou `apps/web/` foi alterado pela fase. Foram comparados os hashes de 207 arquivos com o estado inicial. Alterações anteriores em autenticação, banco e infraestrutura foram preservadas e não incluídas nos commits da implementação. A decisão D1 não foi utilizada.

Não foram alterados proxy de produção, tráfego, login/logout/MFA do produto, escritas de negócio, workers ou componentes fora do escopo. Não foi feita otimização das políticas RLS originais para tentar aprovar a medição.

A liberação depende do portão de desempenho, da revisão das alterações e da execução remota do CI. As próximas fases exigem nova autorização, conforme o plano.
