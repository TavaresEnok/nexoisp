# Etapa 4 — integridade, cobertura e limitações

Data: 18/10/2026. Evidências novas desta execução; relatórios históricos não foram sobrescritos.

## Rotas e renderização

- Inventário AST: 51 módulos, 420 destinos, sem href duplicado; 20 associações de consulta, 399 escopos pendentes e uma entrada especial.
- Auditoria HTTP/SSR: **431 caminhos**. Primeira passagem: 427 aprovados e quatro pendentes. Rechecagem dos quatro: quatro aprovados. As três entradas de assistente expiraram inicialmente por compilação; na rechecagem renderizaram em modo demo. O caminho desconhecido utiliza not-found em streaming: HTTP 200 com sinal de fallback 404 e `noindex`; não foi alterado para mascarar status. Evidências preservadas separadamente em `.v0/evolution/http-routes.json` e `http-routes-recheck.json`.
- Browser real: **31 entradas** de consultas, catálogos, aliases e especiais renderizaram com título principal e sem mensagem de indisponibilidade. Não foram observadas requisições operacionais `/api/workspace`, `/api/auth` ou `/eve/v1` nessas observações. O smoke foi feito em iframes locais; não equivale a 31 jornadas completas.
- Fallback desconhecido e link de retorno ao painel foram exercitados na janela principal.

## Interações verificadas no browser

- Assinantes: busca, situação, vazio, enums inválidos, reset composto, limpeza por teclado, paginação e seleção.
- Ficha: URL compartilhável com reload, Cadastro, Contratos, Financeiro, Conexão, Diagnóstico, Atendimento/OS e Histórico; fechamento por Escape, contenção e devolução do foco.
- Clipboard: confirmação após copiar e-mail.
- Painel: tooltip do gráfico e exportação CSV. O conteúdo efetivamente gerado foi inspecionado pelo blob; o arquivo baixado pelo browser remoto não é acessível como arquivo local do workspace.
- Playground CLI: VLAN inválida rejeitada; correção para 901 e geração local confirmadas, sem execução remota.
- Configurações: origem local e ausência de falso estado Neon conectado confirmadas.

## Preservação visual

- Desktop escuro 1342×805: tabela de assinantes no mesmo estado antes/depois apresentou **0% de diferença**, 0 pixels de 1.080.310.
- Mobile escuro 390×844: painel e ficha capturados; painel sem overflow horizontal global. Abas da ficha foram inspecionadas e exercitadas.
- Não foram editados CSS, tokens, assets ou fontes. Capturas estão no browser remoto em `/tmp/agent-browser/`, não no repositório; o resultado da comparação consta do registro da ferramenta. Não há certificação pixel a pixel de todas as telas.

## Testes e ambiente

- `pnpm verify`: TypeScript e **134/134 testes aprovados**, zero falhas, ignorados ou cancelados. Base inicial: 123; incremento: 11 testes.
- `pnpm install --frozen-lockfile --ignore-scripts`: aprovado, sem mudança de manifesto/lockfile; política de dependências verificada pelo gerenciador.
- `pnpm build`: **aprovado**, com compilação, TypeScript e geração das cinco páginas estáticas concluídas; rotas dinâmicas preservadas. Evidências: `.v0/evolution/final-build.json` e `.log`.
- `git diff --check`: sem erro nesta inspeção; isso não confirma commit ou push.
- E2E Playwright local: **bloqueio superado na nova tentativa de 18/10/2026**. O ambiente é Amazon Linux 2023; `dnf` instalou as bibliotecas nativas ausentes. Uma segunda limitação foi demonstrada pelo DOM: sem fonte de sistema, textos de toast tinham altura zero. A instalação de `fontconfig dejavu-sans-fonts` resolveu os dois testes afetados, sem alteração na aplicação ou nas asserções.
- O dev server terminou durante a primeira passagem ampliada, que foi interrompida. A validação concluída usou o build existente, anteriormente aprovado, servido com `pnpm start`, sem nova compilação. Evidências de produção: **37/39 casos demo na primeira passagem**, seguidos de **2/2 casos de clipboard aprovados após instalar fontes**. São 39 casos distintos validados em duas passagens; o log da passagem com duas falhas foi preservado, não reclassificado como sucesso.
- Nova suíte `tests/e2e/navigation-scopes.spec.ts`: **50/50 grupos aprovados**, cobrindo os **399 escopos pendentes**. Para cada rota: HTTP bem-sucedido, título, aviso de pendência, link de evidências e ausência de formulário; por grupo: nenhuma requisição operacional monitorada nem erro de runtime. A auditoria não implementa funcionalidades.
- `tests/e2e/audit-fixes.spec.ts` foi preservado. **4/4 regressões compatíveis com demo aprovadas:** alerta óptico, filtros com reload, cookie de aparência e abas da ficha móvel. Os outros três casos, dependentes do modo original/API/Neon, não foram executados nem convertidos silenciosamente para demo.
- `pnpm verify` foi repetido nesta tentativa: TypeScript e **134/134 testes aprovados**. Nenhuma mudança em dependências npm, lockfile, estilos, dados, serviços ou contratos da aplicação.
- Evidências: `.v0/evolution/retry-playwright-demo-production.{json,log}`, `retry-playwright-clipboard-fonts.{json,log}`, `retry-playwright-scopes-production.{json,log}`, `retry-playwright-regressions-demo.{json,log}` e `retry-verify.{json,log}`. Tentativas interrompidas e falha inicial de importação ESM da nova suíte também foram preservadas. O resumo está em `retry-summary.json`.
- Dois testes de integração de banco foram preservados e não executados, respeitando a proibição de acessar serviços externos.

## Complemento de fechamento do pedido original

Novo relatório separado: [closure.md](./closure.md), com matriz das nove prioridades e os arquivos alterados nesta continuação.

- `pnpm verify` repetido após a correção pontual: TypeScript e **134/134 testes aprovados**, evidência `closure-verify-final.{json,log}`.
- `tests/e2e/demo-interactions.spec.ts` acrescenta **17 jornadas**: consulta e validação de rede, mapa com tiles indisponíveis, filtros/rascunho/reload, agenda e técnico, documento real de impressão, relatórios e download, validações e recuperação dos cinco campos CLI, template vazio/desconhecido e configurações somente leitura.
- Corrigido o rodapé de `components/onu-catalog.tsx`: o modo local não anuncia armazenamento no Neon; a redação original continua no modo original. A legenda foi confirmada no preview e na regressão E2E.
- A bateria `closure-browser-final` aprovou **56 casos demo** (39 existentes + 17 novos) e **20 grupos de escopos** antes do limite de 360 segundos. O comando global terminou por timeout, sem falha de asserção registrada; não equivale a 106 casos aprovados numa única execução. A retomada `closure-scopes-remaining` aprovou os **30/30 grupos restantes**. Resultado combinado: 56 casos demo e 50 grupos cobrindo os 399 escopos, validados em duas passagens; o status `timed-out` da primeira execução foi preservado. Detalhes em `closure.md`.
- Conferência de preservação: 236 arquivos da referência continuam presentes, nenhum removido, 21 arquivos protegidos deste comando sem alteração de hash e `before.zip` com SHA-256 correto (`closure-preservation.{json,log}`). CSS, dados, dependências e serviços não foram modificados nesta continuação.
- O iframe de impressão e a mídia `print` passaram no navegador; isso **não certifica** o diálogo nativo do sistema ou a gravação real de PDF. Os demais limites abaixo permanecem aplicáveis.

## O que não está certificado

Não há cobertura combinatória de cada formulário, tabela, filtro, gráfico e estado em todos os 420 destinos. Os 399 escopos continuam explicitamente pendentes. Falha/recuperação de fonte foi verificada nos serviços por testes, não como jornada de falha injetada na UI. O documento de impressão no iframe e a mídia `print` foram certificados no complemento; não foram certificados o diálogo nativo de impressão do sistema, todas as camadas/popups do mapa ou execução offline. Tiles ArcGIS/Esri são dependência visual preexistente; foram bloqueados no smoke do navegador, sem remover a configuração original. Não houve chamadas operacionais deliberadas a APIs externas nem nova integração.

A conclusão é da evolução arquitetural autorizada e das verificações listadas, não de implementação integral de todos os módulos de negócio nem de compatibilidade React 18/Vite 6 já executada.
