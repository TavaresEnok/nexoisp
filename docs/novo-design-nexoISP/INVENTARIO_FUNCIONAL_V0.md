# Inventário funcional do frontend NexoISP

**Escopo analisado:** aplicação ativa React 19 + Vite 6.  
**Data de leitura:** 18 de outubro de 2026.  
**Fontes de verdade:** `src/`, `components/`, `application/`, `domain/`, `data/demo/`, `lib/navigation*.ts` e `lib/db/*seed.json`.

> Este documento descreve o que o código do frontend efetivamente apresenta e executa. Não atribui operações reais a elementos meramente visuais. Arquivos legados não foram considerados.

## 1. Arquitetura e classificação geral

- **Entrada e roteamento:** `src/main.tsx`, `src/app.tsx`, `src/route-content.tsx`, React Router 7 (`BrowserRouter` encapsulado por `platform/navigation/browser-provider.tsx`).
- **Catálogo de navegação:** `lib/navigation-requirements.ts` é a árvore funcional pretendida; `lib/navigation.ts` a transforma em URLs. `lib/navigation-route.ts` resolve a tela.
- **Dados:** modo demonstrativo, somente leitura, a partir de `lib/db/demo-seed.json` e `lib/db/technical-catalog-seed.json`, carregados por `data/demo/readers.ts`. Não há requisição HTTP, mutação remota, autenticação ativa, banco ou endpoint de backend no frontend atual.
- **Estado:** filtros e abertura de ficha usam estado React e parâmetros da URL; leituras usam SWR em `features/workspace/data-provider.tsx`; tema é preferência local em `platform/appearance.ts`.
- **Cobertura de rotas:** 420 nós navegáveis gerados. Há 20 destinos associados a `NavigationView`, uma busca/diretório (`/busca`), rotas especiais e **399 destinos que caem em `NavigationScope`**, portanto classificados como **Pendente/placeholder**. Uma rota ter URL não significa que a funcionalidade descrita esteja pronta.

### Estados usados

| Estado | Critério aplicado |
|---|---|
| **Demonstrativa funcional** | Interage sobre os seeds locais, estado da tela ou URL, sem persistência de negócio. |
| **Visual estática** | Mostra dados/indicadores, sem alterar resultado ou disparar operação relevante. |
| **Parcial** | Há consulta, navegação ou simulação, mas não o ciclo funcional completo. |
| **Pendente/placeholder** | `NavigationScope` informa que o escopo ainda não foi implementado. |
| **Dependente de backend** | A ação descrita exigiria API/integração/persistência e não existe implementação ativa. |
| **Não confirmado** | Não há evidência suficiente no código ativo. |

## 2. Layout, UX/UI e componentes compartilhados

| Conjunto | Implementação | Evidência funcional |
|---|---|---|
| Shell | `components/app-shell.tsx`, `workspace-navigation.tsx` | Sidebar de áreas, cabeçalho, breadcrumb/título contextual, tema e área de conteúdo. |
| Navegação responsiva | `components/responsive-sidebar.tsx`, `platform/navigation/*` | Navegação desktop e menu móvel; rota e query string no navegador. |
| Estados de dados | `workspace-provider.tsx`, `workspace-data-boundary.tsx`, `workspace-feedback.tsx` | Leitura sob demanda, carregamento, erro, vazio e dado potencialmente desatualizado. |
| Feedback | `components/ui/alert.tsx`, `sonner.tsx`, `tooltip.tsx`, `skeleton.tsx`, `empty.tsx` | Alertas, toasts, dicas, skeleton e estado vazio reutilizáveis. |
| Formulários | `components/ui/{input,textarea,select,field,label,input-group}.tsx` | Controles visuais reutilizáveis; não constituem persistência por si. |
| Dados | `components/ui/{table,card,badge,tabs,dialog,sheet,dropdown-menu}.tsx` | Tabelas, cartões, tags, abas, diálogos, painel lateral e menus. |
| Gráficos e mapa | `revenue-chart.tsx`, `ui/chart.tsx`, `network-leaflet-map.tsx` | Recharts para gráfico de receita e Leaflet/React Leaflet para mapa com dados locais. |
| Tipografia/tema | `src/fonts.css`, `src/globals.css`, `platform/appearance.ts` | Geist e Geist Mono; tokens CSS, aparências claro/escuro e preferência local. |
| Tratamento global | `src/error-boundary.tsx`, `src/not-found.tsx` | Boundary de erro e página para rotas desconhecidas. |

A experiência é responsiva pelo shell/sidebar e usa os componentes `ui` como base. Os arquivos em `components/ai-elements` e `components/agent-ui` são blocos reutilizáveis de interface do assistente; não provam agente ou IA conectados.

## 3. Árvore completa de áreas, páginas e destino

### 3.1 Acesso, início e páginas especiais

| Área → menu → destino | URL | Estado | Implementação |
|---|---|---|---|
| Acesso → Login → Verificação em duas etapas | `/login/verificacao-em-duas-etapas-quando-configurada` | Pendente/placeholder | `navigation-requirements.ts`, `navigation-scope.tsx` |
| Acesso → Minha conta → alterar senha/2FA | `/conta/*` | Pendente/placeholder | idem |
| Início → Painel inicial | `/` | Demonstrativa funcional | `overview.tsx`, `overview-area-panels.tsx` |
| Início → Busca global → resultados/fichas | `/busca` | Parcial | `navigation-directory.tsx`, `navigation.ts` |
| Diretório de páginas | `/estrutura` | Demonstrativa funcional | `navigation-directory.tsx` |
| Relatórios agregados | `/relatorios` | Demonstrativa funcional | `management.tsx` |
| Configurações de interface | `/configuracoes` | Parcial | `navigation-views.tsx` |
| Evidências de consolidação | `/acompanhamento` | Visual estática | `consolidation-progress.tsx` |
| Assistente | `/assistente`, `/s/:sessionId` | Demonstrativa funcional | `demo-assistant.tsx` |
| Página não encontrada | qualquer URL não catalogada | Visual estática | `src/not-found.tsx` |

### 3.2 Assinantes

| Menu/página | URL base | Estado | Tela/ações realmente presentes |
|---|---|---|---|
| Consultar | `/assinantes` | Demonstrativa funcional | Lista local, busca, filtros, ordenação/paginação quando expostos, abertura da ficha por query `ficha`; `subscribers.tsx`. |
| Ficha de assinante | `?ficha=:id` | Parcial | Sheet com dados de cadastro, contratos, conexão, histórico, serviços, faturas e painéis técnicos dos seeds; `subscriber-sheet.tsx`, `subscriber-*.tsx`. Edições/cadastros não persistem. |
| Contratos | `/contratos` | Demonstrativa funcional | Consulta/filtro de contratos e detalhamento; `contracts.tsx`, `contract-details.tsx`. |
| Planos | `/planos` | Demonstrativa funcional | Lista/detalhe de planos e elementos de catálogo local; `plans.tsx`, `plan-details.tsx`. |
| Produtos adicionais | `/produtos-adicionais` | Pendente/placeholder | `navigation-scope.tsx` |

#### Ficha e contrato: seções previstas x evidência

| Destino/ação da árvore | URL derivada | Estado | Observação |
|---|---|---|---|
| Cadastro, acesso ao portal, campos personalizados, anotações, contatos, documentos, LGPD | `/assinantes/abrir-assinante-nome-do-assinante/*` | Pendente/placeholder | Não há CRUD, upload, download LGPD ou conta de portal ativos. |
| Linha do tempo, atendimentos e OS da ficha | mesmo ramo | Parcial | Há leitura de registros no sheet/histórico; criar, abrir ou alterar exige backend. |
| Abrir contrato e abas Acesso, Contrato, Condições, OS, Histórico | `/contratos/abrir-contrato/*` | Parcial | `contract-details.tsx` apresenta dados locais e contexto técnico/comercial. |
| Diagnóstico, provisionar, suspender, reativar, desconectar, senha PPPoE, MAC, TR-069, ONU | `/contratos/abrir-contrato/aba-acesso/*` | Dependente de backend | UI/painéis e simuladores não executam integração com NAS/OLT/RADIUS/ACS. |
| Produtos, descontos, agendamentos, aditivos e aceite | abas Contrato/Condições | Dependente de backend | Sem mutação, aceite, impressão contratual ou persistência confirmada. |

### 3.3 Atendimento e campo

| Menu/página | URL base | Estado | Tela/ações realmente presentes |
|---|---|---|---|
| Atendimentos | `/atendimentos` | Demonstrativa funcional | Fila/consulta de atendimento com dados locais; `support.tsx`. |
| Ordens de serviço | `/ordens-de-servico` | Demonstrativa funcional | Quadro/listagem, filtros e abertura de detalhe; `field-operations.tsx`, `field-order-board.tsx`, `service-order-details.tsx`. |
| Prospectos | `/prospectos` | Pendente/placeholder | Sem funil ou CRUD ativo. |
| Meu trabalho | `/meu-trabalho` | Pendente/placeholder | Sem atribuição por usuário/técnico ativo. |
| Agenda | `/agenda` | Pendente/placeholder | Sem agenda operacional. |
| Estoque | `/estoque` | Pendente/placeholder | Sem inventário ou movimentos persistidos. |
| Relatórios de atendimento | `/relatorios/atendimento` | Pendente/placeholder | Sem relatório dedicado ativo. |

A tela de OS permite explorar informação local e estados visuais. Ações como atribuir, agendar, iniciar, concluir, checklist, material, serial, devolução ou cancelamento são necessidades de domínio ainda **dependentes de backend**; não há confirmação de gravação no código ativo.

### 3.4 Financeiro

| Menu/página | URL | Estado | Tela/ações realmente presentes |
|---|---|---|---|
| Faturas | `/financeiro/faturas` | Demonstrativa funcional | Painel financeiro, filtros e dados de faturas do cenário; `financial.tsx`. |
| Conciliação | `/financeiro/conciliacao` | Pendente/placeholder | Sem consulta a gateway. |
| Política de cobrança | `/financeiro/politica-de-cobranca` | Pendente/placeholder | Sem configuração persistida. |
| Ficha financeira do contrato | `/financeiro/contratos` | Pendente/placeholder | Sem acordo/liberação real. |
| Relatórios de cobrança | `/relatorios/cobranca` | Pendente/placeholder | Sem exportação de cobrança dedicada. |

Gerar mensalidade, dar/estornar baixa, cancelar fatura, conciliar gateway, calcular multa/juros, confiança e suspensão/religação são **dependentes de backend**. Os indicadores e gráficos usam somente a amostra local.

### 3.5 Rede / FTTx e relatórios técnicos

| Menu/página | URL | Estado | Tela/ações realmente presentes |
|---|---|---|---|
| Agentes e equipamentos | `/rede/equipamentos` | Demonstrativa funcional | Centro de rede e consulta de registros técnicos locais; `network-center.tsx`, `network-explorer.tsx`, `core-network.tsx`. |
| Concentradores | `/rede/equipamentos/concentradores` | Demonstrativa funcional | Catálogo/visão de NAS local; `core-network.tsx`. |
| Rede óptica — FTTH | `/rede/ftth` | Pendente/placeholder | Rota agrupadora sem tela dedicada. |
| FTTx - OLT | `/rede/ftth/fttx-olt` | Demonstrativa funcional | Catálogo técnico local; `optical-network.tsx`, `technical-workspace.tsx`. |
| FTTx - PON | `/rede/ftth/fttx-pon` | Demonstrativa funcional | Consulta visual local; mesmos arquivos. |
| FTTx - CTO | `/rede/ftth/fttx-cto` | Demonstrativa funcional | Consulta visual local; mesmos arquivos. |
| FTTx - ONU Tipo | `/rede/ftth/fttx-onu-tipo` | Demonstrativa funcional | Catálogo de modelos ONU; `onu-catalog.tsx`. |
| FTTx - ONU Template | `/rede/ftth/fttx-onu-template` | Demonstrativa funcional | Catálogo/template local; `onu-catalog.tsx`. |
| ACS - Template | `/rede/ftth/acs-template` | Pendente/placeholder | Sem gestão ACS real. |
| Endereços IP e CGNAT | `/rede/enderecos-ip` | Demonstrativa funcional | Visão técnica de pools locais; `ip-traceability.tsx`, `technical-workspace.tsx`. |
| Blocos de endereços | `/rede/enderecos-ip/blocos-de-enderecos` | Demonstrativa funcional | Consulta de pools, sem alocação persistida. |
| Planos de CGNAT | `/rede/enderecos-ip/planos-de-cgnat` | Demonstrativa funcional | Visualização e simulação técnica, sem RouterOS real. |
| Operações | `/rede/operacoes` | Pendente/placeholder | Sem orquestração/evidência operacional real. |
| Manutenções | `/rede/manutencoes` | Pendente/placeholder | Sem aviso ou período persistido. |
| Mapa | `/rede/mapa` | Demonstrativa funcional | Mapa Leaflet a partir das coordenadas presentes na amostra; `network-leaflet-map.tsx`. |
| Consultar ONU | `/relatorios/consultar-onu` | Pendente/placeholder | Sem consulta isolada além dos catálogos. |
| Online agora | `/rede/online` | Demonstrativa funcional | Consulta/filtro local de sessões; `network-online.tsx`, `network-query-dialog.tsx`. |
| Consulta de IP | `/rede/consulta-ip` | Demonstrativa funcional | Formulário/resultado de rastreabilidade sobre o cenário local; `ip-traceability.tsx`. |

Provisionamento, segredo RADIUS, WireGuard/L2TP, certificados, conectividade de OLT, autorização de ONU, alocação/liberação IP, delegação IPv6, script RouterOS, desconexão de sessão e coleta de evidências são **dependentes de backend e integrações técnicas**. `provisioning-playground.tsx` é um simulador; não executa comandos em equipamento.

### 3.6 Administração, operação SaaS, portal e página pública

| Área/menu | URL base | Estado | Observação |
|---|---|---|---|
| Administração → Usuários | `/administracao/usuarios` | Pendente/placeholder | Sem gestão de identidade/papéis ativa. |
| Empresas | `/administracao/empresas` | Pendente/placeholder | Sem cadastro/padrão persistido. |
| Avisos | `/administracao/avisos` | Pendente/placeholder | Sem entrega de alerta. |
| Avisos ao assinante | `/administracao/avisos-assinante` | Pendente/placeholder | Sem régua, canal ou histórico funcional. |
| Integrações | `/administracao/integracoes` | Pendente/placeholder | Sem token, webhook ou entrega real. |
| Catálogos e SLA | `/administracao/catalogos-sla` | Pendente/placeholder | Sem CRUD/configuração persistida. |
| Coleta ANATEL — DICI | `/administracao/anatel` | Pendente/placeholder | Sem geração de arquivo. |
| Importação | `/administracao/importacao` | Pendente/placeholder | Sem upload, mapeamento ou lote. |
| Auditoria | `/auditoria` | Pendente/placeholder | Sem consulta/auditoria real. |
| Operação do SaaS → Provedores | `/provedores` | Pendente/placeholder | Sem gestão multiempresa/suporte. |
| Portal do assinante → resumo | `/portal` | Pendente/placeholder | Não existe autenticação nem portal ativo. |
| Portal → planos, consumo, faturas, dados, Wi‑Fi, religar, atendimento, documentos, satisfação, sair | `/portal/{planos,consumo,faturas,dados,wifi,religar,atendimento,documentos,satisfacao,sair}` | Pendente/placeholder | URLs catalogadas; sem fluxo autenticado ou mutação. |
| Aviso ao bloqueado | `/aviso-bloqueio` | Pendente/placeholder | Sem regra/configuração aplicada. |

## 4. Detalhamento das interações demonstrativas

| Interação | Onde | Classificação | Comportamento confirmado |
|---|---|---|---|
| Troca de rota | shell/diretório/sidebar | Demonstrativa funcional | Atualiza o histórico do navegador; aliases `/operacoes`, `/rede` e `/financeiro` são resolvidos. |
| Busca no diretório | `/busca`, `/estrutura` | Demonstrativa funcional | Filtra o catálogo de páginas e conduz para o destino. Não pesquisa ERP/dados externos. |
| Filtros de dados | assinantes, contratos, financeiro, atendimento, rede | Demonstrativa funcional | Derivam resultados da amostra em memória; não fazem `fetch`. |
| Abertura de ficha | assinantes e relações | Demonstrativa funcional | Escreve `ficha`/`abaFicha` na URL e abre `SubscriberSheet`; fechar remove esses parâmetros. |
| Parâmetros técnicos | rede/online, consulta IP e catálogo | Demonstrativa funcional | Filtros são normalizados/propagados pela URL onde aplicável; leitura é local. |
| Tema | shell | Demonstrativa funcional | Alterna aparência e salva preferência local de apresentação, não dado de negócio. |
| Gráfico de receita | painel/financeiro | Visual estática | Recharts com valores dos dados demonstrativos. |
| Mapa | relatório de mapa | Demonstrativa funcional | Leaflet exibe pontos com coordenadas da amostra; não há geocodificação ou edição. |
| Simulação de provisionamento | contexto técnico | Simulação | `provisioning-playground.tsx` modela o fluxo localmente; não chama OLT/NAS/ACS/RADIUS. |
| Assistente | `/assistente` | Demonstrativa funcional | Interface de conversa demonstrativa, sem confirmação de modelo, sessão de servidor ou ferramenta externa. |
| Notificações | telas interativas | Parcial | `sonner` oferece feedback visual; não confirma que houve operação de domínio. |
| Exportar CSV, imprimir, baixar | menus previstos | Dependente de backend / Não confirmado | A árvore prevê diversas saídas, mas o código ativo não evidencia geração real para os escopos pendentes. |

## 5. Páginas e funcionalidades pendentes agrupadas

A lista abaixo preserva os destinos da árvore original em forma compacta. Cada item é uma URL derivada por `navigationSlug()` a partir do rótulo em `lib/navigation-requirements.ts`; ramos com `*` incluem todos os descendentes listados.

| Módulo | Destinos/funcionalidades pendentes da árvore |
|---|---|
| Acesso | Login: verificação em duas etapas; Minha conta: alterar senha, ativar/desativar 2FA. |
| Assinantes / Consultar | Exportar CSV, novo assinante, editar cadastro, acesso portal, campos personalizados, anotações, contatos, documentos, LGPD; todos exigem CRUD, arquivos ou dados pessoais persistidos. |
| Assinantes / Contrato | Troca de plano/vencimento, restrição, encerramento/multa, infraestrutura e configuração, PPPoE/IPoE/hotspot, provisionamento, suspensão/reativação, sessão, senha, MAC, TR-069, consumo exportável, logs RADIUS, disponibilidade, ONU e suas operações; comerciais, condições, OS e histórico de contrato. |
| Assinantes / Planos e adicionais | Novo/ativar/desativar/versão/parâmetros/fidelidade/degraus; cadastro, preço e ativação de adicionais. |
| Atendimento | Prospectos e funil; meu trabalho; agenda; estoque e unidades seriadas; relatórios. Em OS: todas as transições, agenda, auxiliares, checklist, materiais, kit, equipamento e histórico editável. |
| Financeiro | Geração mensal, fatura, pagamento, estorno, baixa, cancelamento, conciliação/gateway, regra de cobrança, confiança, relatórios e exportações. |
| Rede / FTTx | Criação/gestão de concentrador/agente/OLT, segredo, túnel, token/certificado, manutenção; ACS template; alocação/revogação IP/IPv6; CGNAT/RouterOS; operações e evidências. |
| Administração | Usuários, empresas, avisos, réguas, canais, templates, tokens, webhooks, entregas, catálogos, SLA, satisfação, campos, kits, comissões, ANATEL, importação e auditoria. |
| SaaS | Provedores, administrador inicial, módulos, suspensão/reativação, suporte justificado. |
| Portal | Todas as páginas e ações de fatura, Wi‑Fi, religação, atendimento, documentos e satisfação, pois não há sessão de assinante. |
| Página pública | Configuração e exibição operacional do aviso de bloqueio. |

## 6. Matriz dos módulos implementados

| Página | URL | Estado | Arquivos principais |
|---|---|---|---|
| Painel inicial | `/` | Demonstrativa funcional | `overview.tsx`, `overview-area-panels.tsx`, `revenue-chart.tsx` |
| Assinantes | `/assinantes` | Demonstrativa funcional | `subscribers.tsx`, `subscriber-sheet.tsx`, `subscriber-profile-sections.tsx`, `subscriber-contracts.tsx`, `subscriber-history.tsx`, `subscriber-service.tsx` |
| Detalhes técnicos do assinante | query de ficha | Parcial | `subscriber-connection.tsx`, `subscriber-diagnostic-tools.tsx`, `subscriber-technical-panels.tsx`, `core-records.tsx` |
| Contratos | `/contratos` | Demonstrativa funcional | `contracts.tsx`, `contract-details.tsx` |
| Planos | `/planos` | Demonstrativa funcional | `plans.tsx`, `plan-details.tsx` |
| Atendimento | `/atendimentos` | Demonstrativa funcional | `support.tsx` |
| Ordens de serviço | `/ordens-de-servico` | Demonstrativa funcional | `field-operations.tsx`, `field-order-board.tsx`, `service-order-details.tsx` |
| Financeiro | `/financeiro/faturas` | Demonstrativa funcional | `financial.tsx`, `revenue-chart.tsx` |
| Equipamentos/NAS | `/rede/equipamentos`, `/rede/equipamentos/concentradores` | Demonstrativa funcional | `network-center.tsx`, `network-explorer.tsx`, `core-network.tsx` |
| FTTx | rotas OLT/PON/CTO/ONU | Demonstrativa funcional | `optical-network.tsx`, `onu-catalog.tsx`, `technical-workspace.tsx`, `technical-ui.tsx`, `optical-ui.tsx` |
| Pools/CGNAT/IP | rotas `/rede/enderecos-ip/*`, `/rede/consulta-ip` | Demonstrativa funcional | `ip-traceability.tsx`, `technical-workspace.tsx`, `network-query-dialog.tsx` |
| Sessões online | `/rede/online` | Demonstrativa funcional | `network-online.tsx`, `network-query-dialog.tsx` |
| Mapa | `/rede/mapa` | Demonstrativa funcional | `network-leaflet-map.tsx` |
| Diretório | `/busca`, `/estrutura` | Demonstrativa funcional | `navigation-directory.tsx` |
| Gestão/relatórios | `/relatorios` | Demonstrativa funcional | `management.tsx` |
| Assistente | `/assistente`, `/s/:sessionId` | Demonstrativa funcional | `demo-assistant.tsx`, `components/ai-elements/*`, `components/agent-ui/*` |

## 7. Resumo quantitativo

| Situação | Quantidade | Observação |
|---|---:|---|
| Nós de navegação catalogados | 420 | Calculados por `navigationPages` em `lib/navigation.ts`. |
| Destinos com view associada | 20 | Renderizados por `NavigationViewContent`. |
| Diretório/busca | 1 | `/busca`, com comportamento de catálogo; `/estrutura` é rota especial correlata. |
| Rotas especiais auxiliares | 5+ | Relatórios, configurações, acompanhamento, assistente e sessão de assistente. |
| Escopos pendentes | aproximadamente 399 | Nós sem `view`, renderizados por `NavigationScope`. |
| Persistência de negócio | 0 confirmada | Os leitores ativos são seeds JSON em memória. |
| Integrações externas reais | 0 confirmadas | Não há chamadas de rede no caminho demonstrativo ativo. |

## 8. Limites para a futura comparação com o ERP Go

1. O catálogo de requisitos é mais amplo que a implementação visual atual: deve ser comparado como **backlog de escopos**, não como evidência de recurso pronto.
2. As telas demonstrativas permitem reaproveitar estrutura, componentes, filtros, fichas e modelos de dados de leitura; o ERP ainda precisará fornecer autenticação, autorização, mutações, auditoria, arquivos, integrações de cobrança e integrações de rede.
3. Toda ação que interfira em fatura, contrato, credencial, ONU, NAS, OLT, sessão, Wi‑Fi, inventário, usuário ou informação pessoal exige uma camada de backend, validação e controle de acesso antes de ser considerada operacional.
4. O contrato de leitura demonstrativo está concentrado em `domain/workspace*.ts`, `domain/technical-catalog.ts`, `application/read-services.ts` e nos seeds. Estes são os pontos mais diretos para substituição futura por adaptadores do ERP, preservando a interface atual.
