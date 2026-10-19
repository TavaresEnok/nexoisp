# Revisão da integração v0 → NexoISP Go

> Registro histórico do checkpoint `97d47cc`. Os seis achados abaixo foram posteriormente corrigidos e validados: consulte o [relatório de correções e fechamento reconciliado](CORRECOES-REVISAO.md).

Data: 19 de outubro de 2026. Código revisado: `97d47ccee074bf4137751e02e73770fcd65689b4`.

**Parecer: a escolha arquitetural continua adequada, mas o aceite de conclusão integral precisa ser reaberto.** A revisão encontrou **1 achado de prioridade alta, 4 de prioridade média e 1 de prioridade baixa**. Existem funcionalidades de negócio disponíveis no Go sem apresentação operacional, além de problemas reproduzidos de navegação, alertas e liberação de módulos. Portanto, minha confirmação anterior de que todo o escopo estava concluído foi ampla demais.

As correções podem ser feitas sobre a arquitetura atual, preservando os componentes e a identidade do v0. Não encontrei motivo para reiniciar a migração ou substituir sua base visual.

## Critérios e alcance

Reli integralmente os dois textos anexados: o pedido original de avaliação arquitetural e a recomendação com sete etapas. A primeira cópia do pedido e a cópia posteriormente anexada são idênticas por SHA-256. Considerei também as autorizações posteriores de implementação e a regra absoluta de UI/UX registrada no chat e nos arquivos `AGENTS.md`.

O pedido inicial restringia aquela primeira avaliação à análise. As autorizações posteriores permitiram executar o plano. A exigência de fechamento passou a ser o frontend premium do v0 com as funcionalidades existentes do Go integradas, respeitando os limites do backend.

| Exigência | Resultado desta revisão |
|---|---|
| Usar efetivamente o código e o design system do v0 | Confirmado na estrutura, nos componentes básicos, CSS e fontes; três novas comparações demonstrativas foram idênticas |
| Adaptar as funcionalidades ao v0 | Confirmado em grande parte; há lacunas de acesso pela interface e de cobertura de capacidades comerciais |
| Um único backend Go | Confirmado no caminho operacional inspecionado; consultas e comandos usam a API existente |
| Cookie HttpOnly, CSRF e isolamento por provedor | Confirmados nos testes locais e nos casos dirigidos desta revisão |
| Não selecionar seeds após erro operacional | Confirmado em teste dirigido de falha 503 |
| Preservar demonstração separada | Confirmado: `/demonstracao/assinantes` não fez chamadas operacionais |
| Fechar a etapa 7 somente com cobertura validada | A declaração de fechamento precisa ser revista pelos achados R04 e R05 |

A análise cruzou plano, matriz de 169 unidades, inventários, evidências históricas, roteamento, sessão, cliente HTTP, componentes operacionais, permissões e módulos do Go, CI e Dockerfile. A leitura detalhada e a execução foram dirigidas aos pontos de maior relevância; não se trata de execução exaustiva de todas as combinações de campos, perfis, módulos ou equipamentos.

## Achados por prioridade

### R04 — Alta: capacidades de negócio foram contadas como backend preservado sem integração visual

A matriz registra 139 unidades validadas e 30 como `backend-preserved`. Esse segundo grupo reúne tanto rotinas internas e limitações legítimas quanto capacidades comerciais que poderiam ser operadas pela interface.

Dois exemplos confirmados são **BE-04, registrar/remover indicação**, e **BE-24, consultar o relatório de indicações**. Os endpoints existem e funcionaram no laboratório: a gravação foi aceita e a consulta retornou HTTP 200 com uma linha. Não encontrei consumidores desses endpoints ou controles correspondentes no frontend oficial. A presença do campo `referred_by_subscriber_id` no modelo TypeScript não oferece o fluxo ao usuário.

Fontes: [handler de indicação](../../apps/api-go/internal/modules/escrita/comercial.go), [consulta do relatório](../../apps/api-go/internal/modules/leitura/consultas_generated.go) e [matriz JSON](matriz-funcional.json), entradas BE-04 e BE-24. A evidência executável está em [checkup.json](evidencias/revisao/checkup.json), achado R04.

**Impacto:** “backend preservado” comprova que a capacidade continua disponível no servidor; não comprova que ela foi integrada ao frontend. Assim, “zero pendências de integração” não demonstra o atendimento de todas as funcionalidades existentes exigido no chat. Esses dois recursos já não tinham controles no frontend anterior: este achado é uma lacuna de escopo do fechamento, e não uma regressão de uma tela antiga.

**Correção recomendada:** revisar individualmente os itens BE, distinguindo rotinas internas, limites existentes e capacidades de negócio que precisam de apresentação. Implementar os fluxos comerciais faltantes com componentes v0 e registrar evidências por comportamento. Outros candidatos a essa triagem são a conversão de prospecto para assinante existente, os filtros adicionais de relatórios/exportação e a exclusão global de etiquetas. Não atribuí um total definitivo de pendências a esses candidatos sem o desdobramento de cada unidade.

**Aceite:** cadastrar, consultar, remover indicação e verificar permissões e isolamento pela interface; reconciliar todos os itens BE com um critério explícito antes de reafirmar o fechamento da etapa 7. Workers e protocolos internos não precisam ganhar páginas apenas para cumprir uma contagem.

### R01 — Média: submenu apresenta como planejado um recurso disponível

Ao abrir **`/rede/equipamentos/concentradores`**, a aplicação mostra “Recurso planejado” e afirma que o recurso não está disponível no backend. Entretanto, **`/rede/equipamentos`** oferece “Novo concentrador” e o fluxo de autenticação integrada. A rota filha do catálogo oficial não foi ligada à implementação disponível na página principal.

Fontes: [rotas operacionais e PlannedFeature](../../apps/web/features/operations/application.tsx), [navegação](../../apps/web/features/operations/navigation.ts) e [fluxo RADIUS](../../apps/web/features/network/radius.tsx). Reprodução: [captura](evidencias/revisao/concentradores-planejados.png) e R01 em [checkup.json](evidencias/revisao/checkup.json).

**Impacto:** quem segue o submenu do v0 pode concluir que uma funcionalidade entregue não existe. A mensagem genérica mistura ausência de roteamento com ausência de capacidade no Go.

**Correção recomendada:** ligar a rota ao catálogo operacional correspondente ou direcioná-la à seção apropriada da página principal. Revisar os demais destinos filhos associados a capacidades já integradas.

**Aceite:** o caminho do submenu abre o recurso conectado, com contexto e permissões corretos; somente recursos efetivamente futuros recebem a indicação de planejados.

### R02 — Média: “alertar ao abrir” não alerta na abertura normal da ficha

Criei uma anotação com `alert: true` e abri a ficha sem selecionar uma aba pela URL. A ficha abriu em “Visão geral” sem apresentar o alerta. O texto apareceu somente após selecionar “Cadastro”. O editor continua oferecendo a opção “Alertar ao abrir”.

Fontes: [aba inicial da ficha](../../apps/web/features/subscribers/sheet.tsx), [anotações e alertas](../../apps/web/features/subscribers/sections.tsx) e a implementação anterior em `apps/web-legacy/src/pages/Atendimento.tsx`. Evidências: [abertura sem alerta](evidencias/revisao/ficha-sem-alerta.png), [alerta na aba Cadastro](evidencias/revisao/alerta-apenas-cadastro.png) e R02 em [checkup.json](evidencias/revisao/checkup.json).

**Impacto:** uma observação que deveria orientar o atendimento pode passar despercebida. O teste histórico cria e arquiva a anotação dentro de Cadastro; não verifica sua apresentação ao reabrir a ficha na aba inicial.

**Correção recomendada:** consultar e apresentar as anotações de alerta na abertura da ficha, usando o componente de alerta do v0, independentemente da aba de edição das anotações.

**Aceite:** alerta visível ao abrir a ficha pela lista e por link direto; anotações comuns não ganham destaque; arquivar remove o destaque após atualização.

### R03 — Média: módulos desativados ainda produzem controles e consultas operacionais

Criei um provedor de laboratório com **nenhum módulo adicional habilitado**, mantendo as permissões normais de administrador. Dois casos foram reproduzidos:

- Em Contrato → Instalação, o frontend consultou `/contracts/:id/equipment`, embora `field` estivesse desativado. O Go respondeu **403 / `module_disabled`**.
- Em Administração → Catálogos e SLA, a aba SLA permaneceu disponível sem `crm` ou `field`; `/sla-policies` e `/reports/sla` responderam **403**.

Fontes: [montagem da ficha de contrato](../../apps/web/features/contracts/sheet.tsx), [consulta de equipamentos](../../apps/web/features/contracts/status.tsx), [abas de qualidade](../../apps/web/features/admin/quality.tsx) e [módulos exigidos pelo Go](../../apps/api-go/internal/auth/permissions.go). Evidências: [captura do erro](evidencias/revisao/equipamento-modulo-desativado.png) e R03 em [checkup.json](evidencias/revisao/checkup.json).

**Impacto:** páginas autorizadas exibem erros para capacidades que o próprio contexto deveria ocultar ou identificar como indisponíveis. O backend manteve a proteção; não foi observado acesso indevido nesses casos.

**Correção recomendada:** combinar permissão e módulo antes de montar componentes e iniciar consultas. Em equipamentos, exigir também `field`; em SLA, respeitar a disponibilidade de `crm` ou `field` estabelecida pelo Go.

**Aceite:** com módulos desativados, nenhuma consulta bloqueada é enviada; ao habilitar o módulo necessário, os controles e os fluxos correspondentes ficam disponíveis.

### R05 — Média: os testes atuais não sustentam sozinhos a amplitude do fechamento

O teste `legacy-route-parity.test.ts` verifica se as rotas antigas recebem o rótulo `connected` de uma lista mantida manualmente. Não renderiza essas rotas nem confirma as ações, os endpoints ou os destinos filhos do catálogo v0. Por isso, pode passar mesmo com o problema R01.

As comparações de `frontend-v0-visual.mjs` abrem **`/demonstracao`** na aplicação oficial. Isso comprova preservação dos cenários demonstrativos capturados. Não comprova automaticamente a fidelidade e as interações das telas conectadas, que recebem composição e controles operacionais adicionais. Há capturas e verificações de layout nos E2E operacionais, mas elas não equivalem à mesma comparação visual automatizada.

Fontes: [teste de rotas](../../apps/web/tests/legacy-route-parity.test.ts), [teste visual](../../e2e/frontend-v0-visual.mjs), [teste de preservação de arquivos](../../apps/web/tests/official-design.test.ts) e [CI](../../.github/workflows/native.yml).

**Impacto:** os testes aprovados são evidência útil, mas deixam passar falhas observadas nesta revisão. Não há evidência de que todas as 139 unidades foram reprovadas; há evidência de que o critério de aceite precisa ser mais específico.

**Correção recomendada:** acrescentar casos comportamentais para R01–R04 e uma matriz de perfis × módulos; verificar destinos reais do catálogo; manter cenários visuais determinísticos também para os principais fluxos conectados, incluindo estados vazios, erro, nomes extensos e múltiplos contratos. Registrar separadamente a cobertura da demonstração e da operação.

**Aceite:** a suíte detecta os problemas reproduzidos antes de corrigi-los e passa após as correções, sem enfraquecer as verificações.

### R06 — Baixa: legibilidade do código operacional dificulta manutenção e revisão

Dos 117 arquivos `.ts`/`.tsx` em `apps/web/features`, 97 possuem linhas maiores que 500 caracteres. Há linhas com até 6.106 caracteres. Formulários, condições de autorização, chamadas HTTP e renderização ficam frequentemente concentrados na mesma linha.

Exemplos: [importação](../../apps/web/features/admin/import.tsx), [mensagens](../../apps/web/features/admin/messages.tsx), [SLA](../../apps/web/features/admin/quality-sla.tsx) e [NOC](../../apps/web/features/network/noc.tsx).

**Impacto:** revisar mudanças de regras de apresentação e permissões exige mais esforço; diffs misturam alterações independentes. Isso contraria a intenção de facilitar a evolução profissional e modular, embora não constitua por si só falha de execução.

**Correção recomendada:** formatar os arquivos e extrair componentes ou hooks onde existam responsabilidades independentes. Fazer isso em alterações próprias, sem mudar estilos, comportamento ou regras do Go durante a formatação.

## Checkup executado nesta revisão

| Verificação nova | Resultado |
|---|---|
| Testes locais do frontend em Node 22 | **152 aprovados, 0 falhas** |
| TypeScript e build na imagem oficial | **Aprovados** |
| Dockerfile Node 22/Caddy | **Aprovado**; imagem resultante idêntica ao fechamento anterior |
| Testes Go dirigidos | **6 pacotes aprovados**: auth, leitura, validate, apierr, csvx e jsonx |
| Preservação da referência, UI básica, CSS e fontes | **Aprovada** pelos testes de integridade; 231 arquivos de referência conferidos |
| Novas comparações visuais demonstrativas | **3 idênticas**: início claro, início escuro e assinantes no celular |
| Cookie e CSRF | HttpOnly/SameSite Strict confirmado; comando sem CSRF recusado com 403 |
| Erro de API | Falha 503 exibida sem linhas fictícias ou fallback para seeds |
| Demonstração isolada | Nenhuma requisição `/api` na consulta demonstrativa testada |
| Responsividade operacional | Lista de assinantes em 390 × 844 sem transbordamento horizontal da página |
| Isolamento por provedor | Consulta de titular de outro provedor retornou 404 |
| Casos R01–R04 | Problemas e lacunas reproduzidos/confirmados conforme descrito acima |
| Erros JavaScript nos casos dirigidos | Nenhum observado |

Evidências novas: [checkup.json](evidencias/revisao/checkup.json), [comparações visuais](evidencias/revisao/comparacao-visual.json), [resumo técnico](evidencias/revisao/resumo-tecnico.json) e capturas na mesma pasta. Os logs do frontend e da imagem também foram preservados ali.

A reconstrução gerou a imagem `nexo-v0-frontend:review`, ID `sha256:fea42e8e6e476a3ca98449f3f3b6f2a5854b3f3b24b9e53565492e916ed7fcf3`. O laboratório da revisão usou Caddy em 18393, API Go em 18886 e PostgreSQL descartável em 15454, com contas sintéticas e jobs desligados. Nenhuma escrita de teste foi enviada ao ambiente do projeto em 18081. Os serviços temporários e o banco desta revisão foram encerrados após a coleta das evidências.

Na preparação, uma tentativa de build montando os `node_modules` do host em Alpine falhou pela diferença de bibliotecas nativas do Rollup. O build foi então conferido pelo Dockerfile completo, com a instalação própria da imagem, e passou. A primeira comparação visual também precisou corrigir o servidor temporário da referência para permitir a leitura das fontes instaladas na raiz; após essa correção de ambiente, os três pares foram idênticos. Esses problemas de preparação não foram classificados como defeitos do produto.

Os **25 cenários operacionais do fechamento anterior** foram conferidos como evidência histórica; não foram todos reexecutados nesta revisão. A execução nova foi dirigida aos critérios acima. Não fiz nova homologação de NAS, OLT, CPE ou gateway financeiro, nem execução da CI remota. Esses limites não foram contabilizados como defeitos da migração.

## Ordem recomendada de trabalho

1. Reconciliar o escopo dos itens BE e reabrir o aceite da etapa 7; integrar as capacidades comerciais faltantes, começando pelas indicações confirmadas.
2. Corrigir os destinos do catálogo, a apresentação dos alertas e os controles de módulos.
3. Acrescentar os casos de regressão correspondentes e ampliar a validação visual dos fluxos conectados.
4. Formatar e simplificar o código operacional em alterações próprias.
5. Atualizar plano, matriz e relatório de fechamento conforme as evidências das correções; só então reafirmar a conclusão integral.

O resultado desta tarefa é a revisão com suas evidências. **Na data desta revisão os achados permaneceram abertos, sem correções funcionais nesta atividade de análise. O trabalho posterior os resolveu, conforme o relatório de correções vinculado acima.** A exclusão preexistente de `docs/pilha-tecnologica.md` foi preservada e não integra o trabalho produzido.
