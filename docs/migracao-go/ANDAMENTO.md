# Migração Go — estado em 16/10/2026

## Entrega de código

A migração do backend próprio está implementada: **346 rotas (336 HTTP e dez de agentes)**, autenticação, cadastros, financeiro, importação, operações de rede, ACS, RADIUS, rotinas River, administração e VPN usam Go. A conferência final comparou as **336 rotas HTTP registradas pelo Fastify real** com o inventário corrigido, sem faltas ou extras. O OpenAPI Go real também corresponde às 336 operações.

O inventário inicial omitia duas rotas dinâmicas: `PUT /api/subscribers/:id/custom` e `PUT /api/contracts/:id/custom`. Ambas foram implementadas com validação por definição, limpeza de valores, auditoria e isolamento. O extrator agora expande os templates conhecidos e recusa templates desconhecidos.

O Fastify está arquivado em `legacy/fastify`. Não pertence aos workspaces ativos nem às imagens/serviços padrão. As configurações legadas estão separadas em `docker-compose.fastify.yml` para comparação/retorno explícito. Node permanece no build do frontend React e nas ferramentas opcionais de compatibilidade. O agente Python e os serviços externos previstos no plano permanecem.

## O que foi fechado após a auditoria

- API e VPN padrão nos Compose de desenvolvimento/produção são Go; o Caddy serve o frontend e encaminha as 336 operações HTTP ao Go.
- `nexo-vpn` substitui `vpn.ts`: WireGuard, sincronização de peers, publicação da chave, L2TP/IPsec/PPP, relatórios e relay UDP.
- `nexo-db prepare` prepara banco novo ou adota legado completo, configura os papéis Go/RADIUS/réplica, aplica goose e o migrador River e verifica RLS.
- Criação de operador, rotação de segredos, preflight, TOTP e seed de laboratório têm CLI Go. A imagem inclui o executável administrativo e SQL; o runtime não recebe `DATABASE_URL_OWNER`.
- `./nexo up|build|test|typecheck`, homologação, produção, backup e restauração foram adaptados ao fluxo Go. Restore pausa os escritores que estavam em execução e prepara o banco antes de reiniciá-los.
- Intenções de rede integrada enfileiram jobs River por operação na mesma transação. O executor usa tenant/operação, unicidade e reservas com `SKIP LOCKED`; a varredura periódica recupera operações legadas.
- Erros de validação dos agentes preservam a representação textual das issues Zod; corpus capturado da biblioteca legada cobre os formatos corrigidos.
- Logs HTTP incluem request ID, rota, status, duração, tenant, usuário e célula. Há tempo de banco por rota e amostragem de traces de 5%, retendo HTTP 5xx e seus spans associados dentro dos limites de buffer.
- CI padrão verifica Go, frontend e ensaios nativos. As baterias de comparação com o Fastify arquivado ficaram manuais.

## Evidências finais

| Verificação | Resultado |
|---|---|
| Registro Go e inventário corrigido | 346 rotas: 336 HTTP + dez agentes |
| Fastify real × inventário HTTP | 336/336; zero faltas e extras |
| Compilação, `go vet`, testes Go com detector de concorrência | aprovados; testes de banco condicionais exigem a variável do laboratório |
| Lint Go | zero problemas |
| Regressões históricas com requests HTTP/agente dirigidos a Go | execução completa: 189/192; três falhas reais corrigidas; nove casos dos arquivos afetados passaram na repetição direcionada |
| Painel Playwright pelo Caddy e API Go, com seed Go | aprovado: painel, financeiro, permissões e portal |
| Instalação e administração nativas | prepare/seed repetidos, papéis de RADIUS/réplica, operador e rotação idempotente aprovados |
| Duas réplicas Go | baixa concorrente, estorno versus baixa, acordo versus baixa e geração financeira sem duplicação aprovados |
| River | operação executada uma vez; rollback da intenção, job e auditoria comprovado por falha injetada |
| VPN Go isolada | WireGuard real, strongSwan/xl2tpd, NAS criados pela API, peers/CHAP sincronizados e chave preservada no reinício |
| Relay CoA | protocolo UDP e cancelamento conferidos por teste Go |
| SQL e roteamento | 53 migrations congeladas intactas; 12 extratores sem deriva; Caddy final com 346 entradas validado |
| Imagens | API/administração e VPN compiladas sem runtime Node |

Os ensaios finais usaram somente dados sintéticos e containers descartáveis; não alteraram serviços produtivos. Alguns testes históricos importam funções Node diretamente como referência: seus resultados não são contados como execução de workers Go. Os workers e a administração Go tiveram ensaios próprios.

Relatórios detalhados locais: `tests/contrato/relatorios/`; os resumos sem credenciais estão em `evidencias-final-go/`. Evidências das primeiras fases continuam em `evidencias-fase-1/`, com seu escopo e limitações originais.

## Aceitação operacional ainda pendente

A implementação e o fluxo padrão Go estão entregues; **a aceitação operacional completa do plano não está concluída**.

Não foi identificado/configurado um destino de produção nesta sessão. Nenhum proxy produtivo foi recarregado nem há evidência de tráfego real transferido. Faltam a carga comparativa válida, sete dias de baseline, canários e semanas de observação aplicáveis, consolidação de 30 dias e fechamento mensal financeiro. Os ensaios de VPN não substituem homologação de NAS/OLT/CPE em equipamento real.

A carga histórica da fase 1 perdeu iterações e não comprova desempenho. Não se deduz ganho de capacidade dos testes funcionais. O procedimento atual de implantação e retorno está em [EXECUCAO_GO.md](EXECUCAO_GO.md); o plano original e a auditoria são registros históricos, com as alterações de escopo aqui explicitadas.
