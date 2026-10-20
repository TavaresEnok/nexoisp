# Inventário funcional do NexoISP Go

## 1. Escopo, evidências e critérios

Inventário por leitura estática do código da árvore de trabalho baseada no commit `a3ffebb4c114a9fda070756981f4e788d6f68dac`. A atualização local de React em `apps/web/package.json` e no lockfile já estava presente; não foi realizada como parte deste levantamento. Não foram iniciados serviços, executadas funcionalidades, consultas a bancos, testes, builds ou medições de desempenho. Não houve leitura do conteúdo de `docs/novo-design-nexoISP/`. O único arquivo produzido por esta tarefa é este relatório.

Fontes principais: `apps/web/src/App.tsx`, os 35 arquivos de `apps/web/src/pages/`, `api.ts`, `ui.tsx`; registros e handlers de `apps/api-go/internal/modules/`, respectivos SQLs; autenticação, rede, financeiro, agentes, VPN, ACS, jobs e banco em `apps/api-go/internal/`; as migrations `00001` a `00057`; serviços e scripts de integração. Documentação anterior não foi usada como prova de implementação. Arquivos gerados de consulta foram relacionados ao SQL executado pelo serviço genérico, não tratados isoladamente como uma funcionalidade pronta.

### 1.1 Estados

| Estado | Critério neste inventário |
|---|---|
| Implementada | Ação/consulta de interface conectada a handler com validação, leitura/persistência/regra real ou chamada efetiva à integração identificada. Não significa homologação em campo. |
| Parcial | Parte do objetivo existe, mas falta uma etapa funcional concreta, discriminada na linha. |
| Demonstrativa | Caminho que usa simulação, equipamentos fictícios ou pagamentos não pagáveis. |
| Somente backend | Operação ou capacidade técnica com implementação concreta, sem controle visual correspondente localizado. Inclui serviços auxiliares, explicitando sua linguagem. |
| Somente interface | Apresentação sem operação correspondente demonstrada no código. Nenhum caso inequívoco foi confirmado nas unidades cadastradas; inconsistência de texto não basta para esta classificação. |
| Não confirmado | Evidência insuficiente para atribuir disponibilidade real ao objetivo descrito. Não representa automaticamente uma implementação existente. |

Cada unidade funcional identificada nas tabelas recebe um ID e um estado principal. Uma unidade pode agrupar listar/criar/editar quando constituem a mesma ficha; subações e endpoints continuam discriminados. Funcionalidades compartilhadas não são contadas novamente em cada local de entrada. Rotinas internas têm prioridade de classificação **Somente backend**; simulação explícita tem prioridade **Demonstrativa**. Falta de homologação não transforma, por si só, código de integração real em demonstração.

As contagens finais correspondem a essas unidades, não a percentuais de conclusão do produto. Rotas HTTP, páginas, abas, campos e funcionalidades são medidas diferentes. A existência de testes não foi usada para promover estados. A análise não comprova configuração, ativação de jobs, credenciais, disponibilidade de provedores externos nem o resultado em equipamentos reais.

### 1.2 Convenções de leitura

- `W/` = `apps/web/src/`; `P/` = `apps/web/src/pages/`; `G/` = `apps/api-go/internal/`; `E/` = `apps/api-go/internal/modules/escrita/`; `L/` = `apps/api-go/internal/modules/leitura/`; `I/` = `apps/api-go/internal/modules/identity/`; `M/` = `db/migrations/`. Esses prefixos são abreviações de caminhos reais, não módulos adicionais.
- As URLs de tela estão em português. Os endpoints Go mantêm nomes em inglês. `api('/contracts')` vira `/api/contracts` em `W/api.ts`.
- `:id` e outros parâmetros são padrões, não valores literais. A notação `GET/POST /api/x` significa duas operações. Sufixos enumerados nas tabelas são expandidos no catálogo HTTP final.
- Modal, cartão, formulário inline e aba geralmente não têm URL própria. Não inventar rotas como `/assinantes/:id/radius`, `/olts/:id/edit` ou `/portal` a partir desses componentes.

## 2. Navegação e árvore completa da interface

O roteador declara **42 padrões de URL**, incluindo login e as duas fichas dinâmicas. O portal substitui a aplicação para sessões `subscriber`; não é uma 43ª rota declarada. A página pública `/aviso/:slug` é HTML servido pelo Go. Seções abaixo de uma página representam abas, cartões, modais e ações, conforme indicado.

```text
ACESSO E NAVEGAÇÃO
├─ Login /login
│  ├─ E-mail e senha; mostrar/ocultar senha; código TOTP quando solicitado
│  └─ Modo demo → selecionar conta sintética para preencher o formulário
├─ Shell administrativo
│  ├─ Busca global → /busca?q=... → assinante/contrato por nome, documento,
│  │  telefone, login, IP, MAC, série ONU ou número de OS conforme busca Go
│  ├─ Filtrar menu “Ir para…”; navegar pelo primeiro resultado com Enter
│  ├─ Recolher áreas; menu móvel; tema claro/escuro; sair
│  ├─ Banner demo; banner de suporte → encerrar acesso de suporte
│  └─ Conta /conta → configurar/ativar/desativar TOTP; alterar senha
INÍCIO
└─ Início / → pendências pessoais; indicadores do provedor; painéis de rede/caixa
CADASTRO
├─ Assinantes /assinantes
│  ├─ Pesquisar; paginar; exportar CSV; Novo assinante [modal]
│  └─ Ficha /assinantes/:id
│     ├─ Cadastro → consultar; Editar [modal]; ativar/inativar
│     ├─ Criar/redefinir acesso ao portal [modal]
│     ├─ Contratos → abrir ficha; Novo contrato [modal]
│     ├─ Campos personalizados → editar valores inline
│     ├─ Anotações → criar; tipo; alerta; arquivar
│     ├─ Contatos → editar coleção; adicionar/remover; finalidade; consentimento
│     ├─ Documentos → enviar PDF/imagem; baixar; excluir
│     ├─ Linha do tempo → fatos de contrato/rede/fatura/pagamento/OS/atendimento
│     ├─ Privacidade → exportar JSON; anonimizar [formulário de confirmação]
│     ├─ Atendimentos → abrir/criar e respectivos modais
│     └─ Ordens de serviço → abrir/criar e respectivos modais
├─ Planos /planos
│  ├─ Novo plano [modal]; ativar/desativar
│  ├─ Alterar preço/velocidade → criar nova versão [modal]
│  ├─ Histórico de versões [modal]
│  ├─ Degraus de cobrança [modal] → avisar/reduzir/bloquear; perfil reduzido
│  ├─ Fidelidade [modal] → meses/modelo/valor ou remoção
│  └─ Rede [modal] → rate-limit/pool; salvar; reaplicar nas contas
├─ Produtos adicionais /adicionais
│  └─ Cadastrar; alterar preço inline; ativar/desativar; quantidade de contratos
└─ Contratos /contratos
   ├─ Pesquisar; filtrar vigentes/encerrados/todos; paginar; exportar CSV
   └─ Ficha /contratos/:id
      ├─ Cabeçalho → trocar plano/vencimento [modal]; restrição de crédito
      │  [modal]; encerrar [modal: motivo, multa cobrada/dispensada, confirmação]
      ├─ Indicadores → situação comercial × acesso × velocidade
      ├─ Aba Acesso [network:read]
      │  ├─ Infraestrutura → IP fixo/IPv6 reservado/caixa e porta
      │  ├─ Diagnosticar acesso [modal] → achados, evidências, atualizar
      │  ├─ Serviço → provisionar PPPoE/IPoE/hotspot [formulário]
      │  │  ├─ Suspender; reativar; desconectar; provisionar importado/reaplicar
      │  │  ├─ Senha gerada uma vez; trocar senha [modal]; vincular/remover MAC
      │  │  └─ Intenção/observação/drift → operações → evidências [modal]
      │  ├─ Financeiro → faturas → modal de fatura; acordo [modal]
      │  ├─ Liberação por confiança → conceder; consultar prazo e histórico
      │  ├─ Consumo → mensal; hora/dia/semana/ano
      │  ├─ CPE TR-069 → procurar; vincular/desvincular; estado; reler;
      │  │  reiniciar; alterar Wi-Fi [formulário]
      │  ├─ Tentativas RADIUS; disponibilidade 7/15/30 dias
      │  ├─ Sessões → datas; totais; gráfico diário; CSV
      │  └─ ONU → estado/sinal RX-TX; autorizar [modal]; reaplicar;
      │     desautorizar; substituir após confirmação; evidências [modal]
      ├─ Aba Contrato
      │  ├─ Dados comerciais; campos personalizados; etiquetas [edição/criação]
      │  ├─ POP; empresa faturadora; área urbana/rural [seleções]
      │  ├─ Produtos adicionais → contratar [formulário]; encerrar
      │  ├─ Equipamentos instalados/itens em comodato a recolher
      │  └─ Financeiro e confiança [quando não há aba Acesso por permissão]
      ├─ Aba Condições
      │  ├─ Fidelidade → definir/remover; cotação de encerramento
      │  ├─ Descontos → percentual/valor; prazo; competência; cancelar
      │  ├─ Mudanças agendadas → plano/vencimento/encerramento; cancelar
      │  ├─ Aditivos → registrar texto/tipo; consultar
      │  └─ Aceite eletrônico → solicitar livre/por aditivo; cancelar;
      │     comprovante [modal: hashes/verificação/imprimir]
      ├─ Aba Ordens de serviço → lista; nova OS; abrir detalhe [modais]
      └─ Aba Histórico → eventos, datas, autor e mudança comercial
ATENDIMENTO
├─ Atendimentos /atendimentos
│  ├─ Busca; situação; só os meus; paginação; Novo atendimento [modal]
│  └─ Detalhe [modal] → protocolo; responsável; conversa; responder;
│     nota interna; encerrar/reabrir; abrir OS vinculada [modal]
├─ Prospectos /prospectos
│  ├─ Indicadores do funil; pesquisa; etapa; paginação; Novo [modal]
│  └─ Detalhe [modal] → editar; novo/contatado/proposta/perdido; motivo;
│     anotar contato; converter em assinante; histórico; abrir assinante
├─ Meu trabalho /meu-trabalho
│  └─ OS pendentes do usuário em cartões → telefone; mapa externo; abrir/continuar
├─ Ordens de serviço /ordens-servico
│  ├─ Busca; situação; só as minhas; paginação; Nova OS [modal]
│  └─ Detalhe [modal compartilhado com ficha/agenda/campo]
│     ├─ Assinante/contrato/endereço; responsável; data; prazo SLA
│     ├─ Em análise; aguardando agendamento; deslocamento; execução;
│     │  devolver à fila; concluir; cancelar; resultado/motivo
│     ├─ Aplicar kit; adicionar/remover auxiliares; checklist
│     ├─ Materiais → lançar quantidade; devolver com quantidade negativa
│     ├─ Equipamento por série → pesquisar; instalar (comodato por padrão)
│     └─ Anotações e histórico de eventos
├─ Agenda /agenda → 1/3/7 dias; por técnico; conflitos; horários livres;
│  aguardando agendamento; abrir OS
├─ Estoque /estoque
│  ├─ Novo/editar item [modal]; código/unidade/mínimo/série; ativar/desativar
│  ├─ Movimentos [modal] → entrada/saída/ajuste justificado; histórico
│  └─ Unidades [modal] → entrada em lote; técnico/almoxarifado; retirada;
│     defeito/conserto; baixa definitiva com motivo; histórico [modal]
└─ Relatórios /relatorios-atendimento → datas; origens/conversão;
   resposta/resolução de chamados; conclusão de OS
FINANCEIRO
├─ Faturas /faturas
│  ├─ Pesquisa; situação; empresa; paginação; CSV; indicadores; recebido mensal
│  ├─ Gerar mensalidades por competência; exportação para contabilidade [datas/tipo]
│  └─ Fatura [modal compartilhado com contrato/conciliação]
│     ├─ Itens; valores; recebido; saldo; multa/juros/desconto; eventos gateway
│     ├─ Baixa manual [formulário: parcial, taxas opcionais, desconto/motivo]
│     ├─ Estornar baixa manual [formulário: motivo]; cancelar [motivo]
│     ├─ Resolver conciliação [formulário: paga/aberta e justificativa]
│     └─ Demo → pagar webhook normal/duplicado/perdido/valor menor
├─ Conciliação /conciliacao → consultar gateway; divergências; eventos; abrir fatura
├─ Política de cobrança /politica-cobranca
│  ├─ Gateway none/demo; geração automática; suspensão/reativação automática
│  ├─ Dias; negar acesso/perfil de bloqueio; confiança/prazo/intervalo
│  ├─ Multa/juros; proporcional do primeiro mês; executar verificação
│  └─ Página de aviso → configurar/editar; textos; contatos; link portal; desativar
└─ Relatórios de cobrança /relatorios-cobranca
   ├─ Aba Carteira por atraso → faixas e totais; CSV
   ├─ Aba Recebido → datas; plano/forma; líquido de estornos; CSV
   ├─ Aba Clientes sem fatura → contratos do mês; CSV; abrir contrato
   └─ Aba A cancelar → dias de atraso; candidatos; CSV; abrir contrato
REDE
├─ NOC /noc → indicadores; alertas e itens; PONs; Limiares/regras [modal]
├─ Agentes e equipamentos /rede
│  ├─ Saúde de rede; atalhos para problemas
│  ├─ Concentradores → cadastrar [modal: vendor/direto/WireGuard/L2TP]
│  │  ├─ Instruções [modal: segredo único/comandos/copiar]
│  │  ├─ Criar/refazer/trocar túnel; parâmetros RADIUS [modal]
│  │  ├─ Trocar segredo; reaplicar contas
│  │  └─ Converter equipamento de agente para integrado [modal]
│  ├─ Agentes locais → criar [modal]; credenciais [modal]; rotacionar token;
│  │  aceitar novo certificado; revogar/reativar
│  └─ Equipamentos com agente/OLTs → cadastrar [modal]; conectividade;
│     reaplicar contas; parâmetros RADIUS [modal]; manutenção
├─ ONUs /onus → descobertas; autorizar descoberta/serial [modal]; vinculadas;
│  abrir contrato → Acesso → ONU → ações/sinal/evidências
├─ Rede óptica /ftth
│  ├─ Lista / Mapa esquemático; cadastrar/editar caixa [modal]; excluir
│  └─ Portas [modal] → ocupação; contrato; reserva anotada; liberar
├─ Endereços IP e CGNAT /ipam
│  ├─ Blocos → novo [modal]; excluir; alocações [modal: manual/automática,
│  │  contrato/reserva, liberar]; prefixos IPv6 [modal: delegar/reservar/liberar]
│  ├─ CGNAT → criar [modal]; conferir capacidade; mapa [modal]; script RSC;
│  │  encerrar plano preservando consultas históricas
│  └─ Rastrear IP público/porta/instante → bloco privado/titular e ressalvas
├─ Operações /operacoes → todas/abertas/problemáticas; paginação; divergências;
│  abrir contrato; evidências de operação [modal]
├─ Manutenções /manutencoes → novo aviso [formulário]; período/equipamento;
│  avisar afetados; avisar normalização; cancelar; consultar estado
├─ Online agora /online → pesquisa; CSV; selecionar até 200; desconectar com motivo
├─ Mapa /mapa → camadas contrato/caixa/POP; filtro de estado; zoom/arrastar;
│  cobertura; selecionar ponto; buscar/posicionar/mover contrato ou POP
├─ Consulta de IP (ofício) /consulta-ip → IP/porta/período/fuso/margem/referência;
│  resultado; sessões/prefixos; imprimir; CSV; histórico de consultas
└─ POPs /pops → criar [formulário]; contagens; ativar/desativar
ADMINISTRAÇÃO
├─ Usuários /usuarios → criar [modal]; papel; bloquear/desbloquear;
│  redefinir MFA; escopo de POPs [modal]
├─ Empresas /empresas → criar; tornar padrão; ativar/desativar
├─ Avisos /avisos → webhook da equipe; salvar/desligar; testar;
│  entregar pendentes; histórico
├─ Avisos ao assinante /avisos-assinante
│  ├─ Aba Régua → cadastrar; plano/dias/janela; ativar/pausar; excluir; rodar agora
│  ├─ Aba Modelos → cadastrar texto/variáveis; prévia; excluir
│  ├─ Aba Canais de envio → cadastrar HTTPS/campos/Authorization; teste;
│  │  ativar/desativar; excluir
│  └─ Aba Histórico → enviado/falha/sem consentimento/fila/incerto/teste
├─ Integrações /integracoes
│  ├─ Aba Tokens da API → criar; escopos/limite/validade; copiar uma vez; revogar
│  ├─ Aba Webhooks → criar; eventos; assinatura; testar; ativar/pausar;
│  │  trocar segredo; excluir
│  └─ Aba Entregas → filtrar situação; consultar erro/tentativas; reenviar falha
├─ Catálogos e SLA /qualidade
│  ├─ Aba Catálogos → tipo/classificação/causa/origem/motivo OS/
│  │  motivo encerramento/tipo anotação; cadastrar; ativar/desativar
│  ├─ Aba SLA → criar política; prioridade/tipo/natureza; prazo/escalonamento;
│  │  ativar/desativar; excluir sem uso; relatório de cumprimento
│  ├─ Aba Satisfação → média; respondidas; nota/comentário/técnico
│  ├─ Aba Campos personalizados → criar definição; opções; obrigatório;
│  │  ativar/desativar (assinante ou contrato)
│  ├─ Aba Kits de instalação → criar; adicionar linhas; ativar/desativar
│  └─ Aba Comissões → regra OS/venda; responsável/auxiliar; apuração por datas
├─ Coleta ANATEL /anatel → competência; prévia; pendências; informar IBGE;
│  tecnologia do plano; baixar CSV
├─ Importação /importacao → CSV de cadastro/títulos/histórico; equipamento;
│  simular; mapear colunas/planos; simular novamente; aplicar;
│  lotes → erros/avisos [modal]; provisionar contas do lote
└─ Auditoria /auditoria → eventos paginados; retenção [formulário]
SAAS [fora do contexto do provedor]
└─ Provedores /provedores → criar + administrador [modal]; módulos [modal];
   suspender/reativar; entrar em suporte com motivo [modal]
PORTAL DO ASSINANTE [sessão subscriber, sem rota própria]
├─ Visão geral; estado da internet; meus planos; meus dados somente leitura
├─ Avisos de manutenção do assinante
├─ Próxima fatura / Minhas faturas → pagar [modal: copiar códigos ou indisponível]
├─ Religar minha internet → confiança; prazo/eligibilidade
├─ Meu consumo → mensal; série hora/dia/semana/ano
├─ Meu Wi-Fi → alterar SSID/senha [formulário]
├─ Atendimento → abrir chamado [modal]; conversa [modal]; responder
├─ Pesquisa de OS → nota 1–5; comentário; enviar
├─ Documentos → ler e aceitar [modal: concordância]
└─ Sair
PÚBLICO
└─ /aviso/:slug[?m=reduzida] → texto de bloqueio/redução; telefone/WhatsApp;
   link de login/portal, sem identificar assinante
```

### 2.1 Permissões e restrições transversais

Fonte: `G/auth/permissions.go`, `auth.go`, `context.go`, `G/tenancy/scope.go`, `G/db/db.go`, `M/00007_endurecimento.sql`, `00034_escopo_pop_aviso_documentos.sql`, `00055_invalidacao_sessao.sql`, `W/App.tsx`.

| Papel | Acesso identificado |
|---|---|
| `saas_operator` | `tenants:manage`; administração da plataforma. Para dados do provedor, entra em suporte com justificativa, recebendo contexto de provedor; alterações são auditadas. |
| `admin` | Usuários, cadastros, planos, contratos, rede (ler/escrever/operar), financeiro, auditoria, importação, configurações, OS, estoque, CRM, confiança e consulta legal. |
| `attendant` | Cadastro ler/escrever; planos ler; contratos ler/escrever; rede ler/operar; financeiro ler; OS ler/escrever; estoque ler; CRM ler/escrever; confiança. Não administra configurações nem baixa financeira. |
| `finance` | Cadastros/planos/contratos ler; financeiro ler/escrever; CRM ler/escrever; confiança. Sem permissão de leitura de rede. |
| `noc` | Cadastros/planos/contratos ler; rede ler/escrever/operar; OS e estoque ler/escrever; CRM ler/escrever; consulta legal. Sem financeiro nem alteração comercial de contrato. |
| `subscriber` | `portal:self`, com `SubscriberID` e isolamento dos próprios dados. |

Os nove módulos liberáveis são `crm`, `field`, `notices`, `api`, `messages`, `noc`, `ftth`, `ipam`, `olt`. O menu combina permissão e módulo; o Go aplica padrões de rota em `auth.Modules`. Alguns endpoints têm verificações adicionais no handler, como manutenção→mensagens e criação de equipamento OLT. Não assumir que todos os endpoints do mesmo tema recebem automaticamente a mesma trava: `reports/commissions`, `commission-rules`, `catalogs` e `custom-fields`, por exemplo, não são todos abrangidos pelos regex de módulo.

As rotas React administrativas são montadas quando existe contexto de provedor e o MFA não está pendente; não há um guard de permissão por cada `<Route>`. Ocultar menu/botão não substitui a autorização Go. Há controles expostos sem o mesmo bloqueio visual do endpoint, como posicionamento no mapa; o backend exige `contracts:write` ou `network:write`. Na ANATEL, ler o relatório exige `settings:manage`, enquanto alterar tecnologia exige `plans:write`.

RLS usa tenant, assinante e escopo de POP em transações. Usuário sem POPs atribuídos vê o provedor inteiro; com restrição, contratos dos POPs autorizados e contratos sem POP, com seus vínculos, conforme políticas. A definição de POP não equivale a criar papéis personalizados; a matriz de papéis é fixa. Cache de sessão possui invalidação por notificações do PostgreSQL; bloqueio, alteração de usuário/provedor e sessão têm suporte no código, sem prova de latência real nesta análise.

Login possui hash de senha, limitação de tentativas por e-mail/IP, sessão com expiração, cookie HttpOnly/SameSite=Strict e `Secure` dependente de configuração/HTTPS; a API aceita também Bearer de sessão, cujo token só vem no corpo do login quando o cliente pede `"bearer": true` (o navegador usa apenas o cookie). Escritas por cookie exigem `X-Nexo-CSRF` com o valor derivado da sessão (SHA-256 do hash da sessão com separação de domínio), entregue em `GET /api/me` e na resposta do login e comparado em tempo constante; Bearer dispensa o cabeçalho. O MFA administrativo é obrigatório apenas quando configurado por `NEXO_REQUIRE_ADMIN_MFA`; TOTP está implementado, sem recuperação por e-mail. Tokens de API pública são outra credencial, com escopos próprios.

### 2.2 Comportamentos comuns de listas, formulários e diálogos

`W/api.ts` implementa carregamento, mensagens de erro, redirecionamento por 401, download autenticado, paginação de **50** registros (`limit`/`offset` e `X-Total-Count`), reinício da página ao trocar filtro e descarte de respostas antigas. `W/ui.tsx` implementa `Modal`, `Form`, `ActionButton`, `Pager`, `Tabs`, avisos, confirmação e prompt compartilhados. Ações destrutivas que usam `confirm` pedem confirmação local; formulários apresentam estado de envio e erro. Fechar/cancelar um formulário não é exclusão de registro.

Paginação visual está em assinantes, contratos, faturas, prospectos, atendimentos, OS, operações e auditoria. As outras listagens usam `useLoad` e não ganham paginação visual por terem suporte a `limit` no Go. Não há ordenação interativa genérica por clicar no cabeçalho: as consultas ordenam no servidor. Exportações têm seus próprios limites; não significam exportação ilimitada. O backend admite filtros adicionais não expostos e eles estão discriminados no inventário técnico. Rotas GET de serviço/ONU/operações podem executar `network.Sweep`; o verbo GET não garante ausência de atualização interna de expirações.

## 3. Detalhamento funcional por módulo

As tabelas a seguir registram as unidades contadas no resumo. Colunas de endpoints usam abreviação apenas quando explicitada; o catálogo HTTP ao final lista os padrões completos e suas fontes de registro/SQL.

### 3.AC Acesso, navegação e início

| ID | Situação | Tela/entrada | Funcionalidade | Comportamento, campos e restrições | Endpoints | Implementação |
|---|---|---|---|---|---|---|
| AC-01 | Implementada | /login | Autenticar e encerrar sessão | E-mail/senha; solicitação de código TOTP; mostrar senha. Credencial válida cria sessão; logout a invalida. Sem autocadastro ou recuperação pública de senha identificados. | POST /api/auth/login; POST /api/auth/logout; GET /api/me; GET /api/health | P/Login.tsx; W/App.tsx; I/service.go; G/cryptox/crypto.go |
| AC-02 | Demonstrativa | /login | Preenchimento com contas de demonstração | Lista de seis contas sintéticas somente se health informa demo; preenche e-mail/senha, não contorna autenticação. | GET /api/health; POST /api/auth/login | P/Login.tsx; G/db/demo.go |
| AC-03 | Implementada | Shell e /busca?q=... | Busca unificada e abertura de fichas | Termo mínimo de dois caracteres; Go agrega correspondências de cadastro, login, IP, MAC, ONU e OS; dados financeiros/rede são condicionados ao perfil. Resultado abre assinante/contrato; sem pager visual. | GET /api/search | P/Atendimento.tsx (SearchBox/Busca); L/search.go |
| AC-04 | Implementada | Shell | Menu, tema, navegação móvel e suporte visível | Filtrar menu, Enter para primeiro destino, recolher áreas, persistir preferências em localStorage; alternar tema; banners demo/suporte e encerrar suporte. Estado visual é local; suporte tem operação Go. | POST /api/support/exit; GET /api/me | W/App.tsx; W/main.tsx; I/self.go |
| AC-05 | Implementada | / | Visão inicial e prioridades pessoais | Contadores de assinantes/contratos/planos/MRR; today monta pendências e links conforme papel, módulos e contexto. Consulta real; seed demo pode tornar conteúdo sintético. | GET /api/dashboard; GET /api/today | P/Dashboard.tsx; L/today.go; L/service.go; L/queries/dashboard_0.sql |
| AC-06 | Implementada | / | Painéis de operação e caixa | Faixas offline, distribuição RX, ativações/encerramentos em 12 meses, últimas operações; caixa líquido e sem-fatura somente quando permitido. Componente exige network:read; dados dependem de observações/accounting. | GET /api/dashboard/panels | P/Cobranca.tsx (Panels); L/agenda.go; L/dinamicas.go |
| AC-07 | Implementada | /conta | Trocar senha própria | Senha atual e próxima com mínimo de oito caracteres; preserva sessão corrente e encerra outras conforme SQL. Portal não oferece essa tela no seu layout. | POST /api/me/password | P/Account.tsx; I/self.go; I/sql/ |
| AC-08 | Implementada | /conta | Gerenciar TOTP | Setup gera segredo/otpauth; enable valida código; disable exige senha e código. Sem QR gráfico ou códigos de recuperação nesta tela. Administrador com MFA pendente fica limitado a conta. | POST /api/me/mfa/setup; POST /api/me/mfa/enable; POST /api/me/mfa/disable | P/Account.tsx; I/self.go; G/cryptox/totp.go; M/00005_mfa.sql |

### 3.AS Assinantes, privacidade e documentos

| ID | Situação | Tela/entrada | Funcionalidade | Comportamento, campos e restrições | Endpoints | Implementação |
|---|---|---|---|---|---|---|
| AS-01 | Implementada | /assinantes | Listar, buscar e exportar cadastro | Pesquisa q, tabela com contato/cidade/contratos ativos/status; paginação 50; CSV com limite solicitado 5000 e auditoria da exportação. subscribers:read. | GET /api/subscribers | P/Subscribers.tsx; G/modules/cadastro/routes.go; G/modules/cadastro/service.go; G/modules/cadastro/queries/list.sql |
| AS-02 | Implementada | /assinantes e /assinantes/:id | Cadastrar/editar/inativar assinante | Modal: nome/razão, CPF/CNPJ, e-mail, telefone, nascimento/abertura, RG/emissor, mãe/fantasia, endereço completo e notas; status ao editar. Go valida documento, datas e campos; PATCH preserva omitidos; bloqueia titular anonimizado. Não há exclusão genérica. | POST /api/subscribers; PATCH /api/subscribers/:id; GET /api/subscribers/:id | P/Subscribers.tsx; E/cadastro.go; E/schemas.go; G/modules/cadastro/service.go |
| AS-03 | Implementada | /assinantes/:id | Ficha e contratos do titular | Exibe cadastro, data/status, observações, acesso ao portal e tabela de contratos com plano/versão/preço/início/vencimento; abre contrato ou modal de novo contrato. | GET /api/subscribers/:id; GET /api/subscribers/:id/portal-access; POST /api/contracts | P/Subscribers.tsx; P/Contracts.tsx; G/modules/cadastro/service.go; E/cadastro.go |
| AS-04 | Implementada | /assinantes/:id | Criar/redefinir acesso de portal | Modal com e-mail e senha; grava usuário de papel subscriber ligado ao titular. Exige subscribers:write; não é reset por e-mail e não equivale a senha PPPoE. | GET /api/subscribers/:id/portal-access; POST /api/subscribers/:id/portal-access | P/Subscribers.tsx; E/acessos.go (portalAccess) |
| AS-05 | Implementada | /assinantes/:id | Manter contatos e consentimento | Coleção de até 20: celular/WhatsApp/fixo/e-mail/responsável, finalidade geral/cobrança/técnico, consentimento. PUT substitui coleção em transação; remover linha só se efetiva ao salvar. Campo label existe no Go, não tem editor dedicado no formulário. | GET /api/subscribers/:id/contacts; PUT /api/subscribers/:id/contacts | P/Atendimento.tsx (Contacts); E/config.go; M/00025_sessoes_contatos_pops.sql |
| AS-06 | Implementada | /assinantes/:id | Anotações estruturadas | Criar texto/tipo/alerta; alertas destacados; autor/data; arquivar. Go permite vincular contrato e alterar flag de alerta; interface usa criação e arquivamento, não edição de texto. | GET /api/subscribers/:id/notes; POST /api/subscribers/:id/notes; PATCH /api/notes/:id | P/Atendimento.tsx (SubscriberNotes); E/condicoes.go; M/00030_estados_motivos_anotacoes.sql |
| AS-07 | Implementada | /assinantes/:id | Anexar, baixar e excluir documentos | PDF/JPEG/PNG/WebP até 5 MiB por arquivo; tipo identidade/endereço/contrato/foto/outro, nome, tamanho e autor. Upload base64, conteúdo persistido no banco e MIME conferido; download e exclusão exigem subscribers:write e têm auditoria. | GET /api/subscribers/:id/documents; POST /api/subscribers/:id/documents; GET /api/documents/:id/download; DELETE /api/documents/:id | P/Atendimento.tsx (SubscriberDocuments); E/documentos.go; E/relatorios.go; M/00034_escopo_pop_aviso_documentos.sql |
| AS-08 | Implementada | /assinantes/:id | Linha do tempo consolidada | Eventos de contrato/rede/fatura/pagamento/OS/atendimento com autor e links; UI mostra até 80 e Go aplica permissões por fonte. Não é o log técnico completo de todas as entidades. | GET /api/subscribers/:id/timeline | P/Atendimento.tsx (Timeline); L/timeline.go |
| AS-09 | Implementada | /assinantes/:id | Exportar dados pessoais | Download JSON de cadastro, contatos, contratos, títulos, chamados, OS, notas, metadados de documentos, aceites, conexões e acesso portal, sem segredos. settings:manage; exportação auditada. | GET /api/subscribers/:id/lgpd-export | P/Subscribers.tsx (Privacy); E/relatorios.go (lgpdExport) |
| AS-10 | Implementada | /assinantes/:id | Anonimizar titular | Motivo/protocolo e nome para confirmar; valida contratos encerrados e ausência de pendências financeiras; remove dados pessoais abrangidos e acesso portal, preserva registros comerciais/legais definidos pelo código. Ação definitiva, sem botão desfazer. | POST /api/subscribers/:id/anonymize | P/Subscribers.tsx; E/documentos.go (anonymize); M/00045_lgpd_titular.sql |

### 3.CO Planos, contratos e condições comerciais

| ID | Situação | Tela/entrada | Funcionalidade | Comportamento, campos e restrições | Endpoints | Implementação |
|---|---|---|---|---|---|---|
| CO-01 | Implementada | /planos | Catálogo e versão comercial | Criar nome/preço/velocidades/perfil; consultar contratos ativos; ativar/desativar; criar versão de preço/velocidade sem reescrever versões já contratadas; histórico em modal. plans:write para mutações. | GET /api/plans; POST /api/plans; PATCH /api/plans/:id; GET /api/plans/:id/versions; POST /api/plans/:id/versions | P/Plans.tsx; E/cadastro.go; L/service.go; M/00001_identidade_cadastro.sql |
| CO-02 | Implementada | /planos | Degraus de inadimplência | Modal com aviso/redução/bloqueio em dias e perfil reduzido; valida ordem crescente; vazio herda política. Ação automática exige configuração do tenant e workers, não ocorre ao editar o plano. | PUT /api/plans/:id/dunning | P/Plans.tsx; P/Cobranca.tsx; E/cadastro.go; G/finance/gateway.go; M/00026_degraus_por_plano.sql |
| CO-03 | Implementada | /planos | Fidelidade padrão | Meses 1–60 ou null, multa fixa/por mês restante e valor; aplica a novos contratos. Fidelidade específica do contrato é outra operação. | PUT /api/plans/:id/loyalty | P/Plans.tsx; E/comercial.go |
| CO-04 | Implementada | /planos | Parâmetros de rede e reaplicação por plano | Rate-limit no formato MikroTik e pool opcional; salvar não altera imediatamente todas as contas. Reaplicar solicita operações, até 500 por chamada, e informa recusas; salvar exige network:write, reaplicar network:operate. | PUT /api/plans/:id/network; POST /api/plans/:id/reapply | P/Plans.tsx; E/rede.go; G/network/engine.go |
| CO-05 | Implementada | /adicionais | Catálogo de adicionais recorrentes | Criar nome/preço, consultar uso, alterar preço, ativar/desativar. Preço novo não reescreve preço congelado nos contratos. Sem integração de ativação TV/telefonia identificada. | GET /api/addons; POST /api/addons; PATCH /api/addons/:id | P/Adicionais.tsx; E/comercial.go; M/00044_produtos_adicionais.sql |
| CO-06 | Implementada | /contratos | Pesquisar, listar e exportar contratos | q e status active/ended/todos; paginação; CSV; assinante, plano/versão, etiquetas, preço e vencimento. Criação parte da ficha do assinante; lista não oferece criação autônoma. | GET /api/contracts | P/Contracts.tsx; L/contracts.go |
| CO-07 | Implementada | /assinantes/:id → Novo contrato | Criar vínculo comercial | Plano ativo, assinante ativo e dia 1–28; Go fixa versão do plano e fidelidade vigente, grava histórico. Backend aceita start_date/notes; modal só envia assinante/plano/vencimento. | POST /api/contracts | P/Contracts.tsx (ContractForm); E/cadastro.go; E/schemas.go |
| CO-08 | Implementada | /contratos/:id | Ficha e alteração de plano/vencimento | Consulta vínculos e histórico; modal troca para versão atual do plano; atualiza acesso conforme estado, solicita provisionamento quando aplicável. Contrato encerrado não é editável nem reativável por essa operação. | GET /api/contracts/:id; PATCH /api/contracts/:id | P/Contracts.tsx; G/modules/cadastro/service.go; E/contratos.go |
| CO-09 | Implementada | /contratos/:id → Encerrar | Encerrar contrato com decisão sobre multa | Motivo de catálogo, observação, cotação da multa e débitos; cobrar gera fatura de multa, dispensar requer justificativa. Encerra comercial e solicita suspensão; pode solicitar remoção ONU se opção do tenant estiver ligada. Faturas existentes permanecem. | GET /api/contracts/:id/termination-quote; PATCH /api/contracts/:id | P/Contracts.tsx; E/contratos.go; L/dinamicas.go; M/00031_condicoes_contrato.sql |
| CO-10 | Implementada | /contratos/:id → Restrição de crédito | Marcar/liberar restrição comercial | PUT restricted e motivo; exige finance:write; não bloqueia acesso por si. Cabeçalho visual também exige contrato ativo e contracts:write. | PUT /api/contracts/:id/credit-restriction | P/Contracts.tsx; E/condicoes.go |
| CO-11 | Implementada | /contratos/:id → indicadores | Separar comercial, acesso e velocidade | GET computa vigente/encerrado/restrito, acesso não provisionado/liberado/bloqueado, redução, causa/modo/data e confirmação técnica; não equipara intenção a efeito observado. | GET /api/contracts/:id/states | P/Atendimento.tsx (ContractStates); L/grupos.go |
| CO-12 | Implementada | /contratos/:id → Contrato | Etiquetas | Consultar/criar etiqueta; selecionar conjunto e salvar no contrato; até 30 IDs. Sem tela de excluir etiqueta global na UI; existe DELETE backend. | GET /api/tags; POST /api/tags; PUT /api/contracts/:id/tags | P/Extras.tsx (ContractTags); E/empresas_tags.go |
| CO-13 | Implementada | /contratos/:id → Contrato | Vincular POP | Selecionar POP ativo ou limpar; contrato deve estar ativo na UI. Vínculo afeta organização e escopo de acesso. | GET /api/pops; PUT /api/contracts/:id/pop | P/Atendimento.tsx (ContractPop); E/config.go |
| CO-14 | Implementada | /contratos/:id → Contrato | Empresa faturadora e área | Selecionar empresa ou padrão; novas faturas herdam empresa, antigas preservam vínculo; definir urbana/rural para coleta. Empresa só aparece se houver cadastro. | GET /api/companies; PUT /api/contracts/:id/company; PUT /api/contracts/:id/service-area | P/Empresas.tsx; P/Anatel.tsx; E/empresas_tags.go; E/condicoes.go |
| CO-15 | Implementada | /contratos/:id → Contrato | Contratar/encerrar adicionais | Produto ativo e quantidade 1–99; congela descrição/preço; início padrão próximo mês; encerramento deixa de cobrar em competência futura. Histórico de adicionais e total mensal; não provisiona serviço externo. | GET /api/contracts/:id/addons; POST /api/contracts/:id/addons; DELETE /api/contracts/:id/addons/:addonId | P/Adicionais.tsx (ContractAddons); E/comercial.go; E/documentos.go |
| CO-16 | Implementada | /contratos/:id → Contrato | Equipamentos e recolhimento | Tabela de unidades/série/modalidade/OS e alerta de comodato a recolher em contrato encerrado. Instalação/retirada efetivas são feitas nos módulos OS/estoque, não neste cartão. | GET /api/contracts/:id/equipment | P/Extras.tsx (ContractEquipment); L/grupos.go |
| CO-17 | Implementada | /contratos/:id → Condições | Fidelidade e cotação de rescisão | Definir/remover meses/modelo/valor; visualizar vigência, meses restantes, multa hoje e faturas abertas. Registro real; cálculo não equivale a validação jurídica da regra. | PUT /api/contracts/:id/loyalty; GET /api/contracts/:id/termination-quote | P/Condicoes.tsx; E/comercial.go; L/dinamicas.go |
| CO-18 | Implementada | /contratos/:id → Condições | Desconto recorrente | Percentual até 100 ou valor fixo; motivo, início e número de meses/opcional; consultar vigência e cancelar. Afeta geração futura; faturas existentes não são recalculadas ao cancelar. | GET /api/contracts/:id/discounts; POST /api/contracts/:id/discounts; DELETE /api/discounts/:id | P/Condicoes.tsx; E/comercial.go; G/finance/sql/ |
| CO-19 | Implementada | /contratos/:id → Condições | Mudança agendada | Agendar plano/vencimento/encerramento com data futura; decisão de multa; consultar pending/applied/canceled/failed e erro; cancelar pendente. Aplicação depende da rotina SCHEDULED. | GET /api/contracts/:id/scheduled-changes; POST /api/contracts/:id/scheduled-changes; DELETE /api/scheduled-changes/:id | P/Condicoes.tsx; E/comercial.go; E/rotinas.go |
| CO-20 | Implementada | /contratos/:id → Condições | Registrar aditivo | Tipo endereço/titularidade/plano/condição/outro, título/texto e vigência; tabela de registros. O tipo titularidade não transfere o contrato nem muda cadastro por si; texto de aditivo não é assinatura. | GET /api/contracts/:id/amendments; POST /api/contracts/:id/amendments | P/Condicoes.tsx; E/comercial.go |
| CO-21 | Implementada | /contratos/:id → Condições | Solicitar e comprovar aceite simples | Texto livre ou snapshot de aditivo; publicar no portal; cancelar pendente; evidência aceita com texto, usuário, e-mail, IP, agente de navegador, datas e hashes; Go recalcula conferência; impressão pelo navegador. Não é assinatura qualificada. | GET /api/contracts/:id/acceptances; POST /api/contracts/:id/acceptances; POST /api/acceptances/:id/cancel; GET /api/acceptances/:id/evidence | P/Condicoes.tsx; E/acessos.go; L/grupos.go; M/00042_aceite_eletronico.sql |
| CO-22 | Implementada | /contratos/:id → Histórico | Histórico comercial | Eventos de criação, plano, vencimento, encerramento, fidelidade e restrições existem no banco; tabela apresenta autor/data e parte dos detalhes. Tipos fora do mapa de rótulos aparecem com nome técnico; não há filtro próprio. | GET /api/contracts/:id | P/Contracts.tsx; G/modules/cadastro/queries/history.sql; E/contratos.go |
| CO-23 | Implementada | Ficha de assinante/contrato | Valores de campos personalizados | Ler definições ativas; editor text/number/date/boolean/select; só envia alterações e null limpa opcionais; Go valida tipo, opção, tamanho, data e texto obrigatório; não basta cadastrar a definição. | GET /api/custom-fields; PUT /api/subscribers/:id/custom; PUT /api/contracts/:id/custom | P/Atendimento.tsx (CustomValues); E/custom.go; M/00032_campos_kits_comissao.sql |

### 3.CR CRM e atendimento

| ID | Situação | Tela/entrada | Funcionalidade | Comportamento, campos e restrições | Endpoints | Implementação |
|---|---|---|---|---|---|---|
| CR-01 | Implementada | /prospectos | Funil, listagem e ficha de prospecto | Indicadores novos/contatados/proposta e ganhos/perdidos no mês; busca nome/telefone/e-mail, etapa/abertos/todos, paginação, detalhe em modal com histórico. | GET /api/leads; GET /api/leads/summary; GET /api/leads/:id | P/Crm.tsx; L/grupos.go; L/paged.go; L/queries/group775251e1_0.sql |
| CR-02 | Implementada | /prospectos → Novo/Editar | Manter dados do prospecto | Nome, telefone, e-mail, documento opcional, endereço completo, origem, plano de interesse, observações; CRM write. Plano não cria contrato automaticamente; cadastro ganho tem restrições de edição. | POST /api/leads; PATCH /api/leads/:id | P/Crm.tsx (LeadForm); E/crm.go |
| CR-03 | Implementada | /prospectos → Detalhe | Etapas e contatos | Marcar novo/contatado/proposta/perdido, motivo de perda; anotações de contato e eventos datados. Ganho ocorre por conversão; não há exclusão física no painel. | POST /api/leads/:id/stage; POST /api/leads/:id/notes | P/Crm.tsx (LeadDetail); E/crm.go |
| CR-04 | Implementada | /prospectos → Converter | Converter em assinante | Cria cadastro a partir do lead, registra relação e ganho, abre ficha; interface exige subscribers:write além da edição CRM, Go verifica regra. Backend também aceita indicar assinante existente, sem seletor correspondente na UI. | POST /api/leads/:id/convert | P/Crm.tsx; E/crm.go (convertLead) |
| CR-05 | Implementada | /atendimentos e ficha do assinante | Listar e abrir chamados | Pesquisa assinante/assunto/protocolo; pendentes/abertos/aguardando/encerrados/todos; só os meus; subscriber_id na ficha; paginação e atualização periódica. | GET /api/tickets; GET /api/tickets/:id | P/Crm.tsx (TicketList/TicketDetail); L/grupos.go; L/paged.go |
| CR-06 | Implementada | Atendimento → Novo | Abrir protocolo | Assinante e contrato opcional, assunto, categoria técnica/financeira/comercial/outro, prioridade baixa/normal/alta, relato; origem provedor; cria mensagem inicial e eventos/notificações. | POST /api/tickets | P/Crm.tsx (TicketForm); E/crm.go; M/00012_crm_atendimento.sql |
| CR-07 | Implementada | Atendimento → Detalhe | Responsável, conversa, notas e estado | Atribuir/remover responsável quando staff acessível; responder público ou nota interna; encerrar com confirmação, reabrir; notas internas não vão ao portal. Mensagem pode mudar estado de espera. Backend permite outros campos de classificação descritos adiante. | PATCH /api/tickets/:id; POST /api/tickets/:id/messages; POST /api/tickets/:id/status | P/Crm.tsx; E/crm.go; L/service.go (ticket) |
| CR-08 | Implementada | Atendimento → Detalhe → Nova OS | Criar OS vinculada ao atendimento | Reusa WorkOrderForm com assinante/contrato/ticket; mostra OS associadas por número e situação. Exige os:write e módulo field no servidor. | POST /api/work-orders; GET /api/tickets/:id | P/Crm.tsx; P/Field.tsx; E/ordens.go |
| CR-09 | Implementada | /relatorios-atendimento | Relatório CRM por período | Datas inicial/final; leads por origem/conversão; chamados por categoria/origem portal/primeira resposta/resolução; OS por natureza/conclusão se permitido. Médias em horas corridas; sem exportação própria nesta tela. | GET /api/crm/report | P/Crm.tsx (CrmReport); L/dinamicas.go; L/dinamicas/ |

### 3.OS Campo, agenda, OS e estoque

| ID | Situação | Tela/entrada | Funcionalidade | Comportamento, campos e restrições | Endpoints | Implementação |
|---|---|---|---|---|---|---|
| OS-01 | Implementada | /ordens-servico e fichas | Listagem de OS | Busca nome/descrição/número, situação/pendentes/todos, só as minhas; subscriber_id/contract_id nas fichas; paginação; destaca agendamento vencido. Modal compartilhado acessível da agenda e Meu trabalho. | GET /api/work-orders; GET /api/work-orders/:id | P/Field.tsx; L/grupos.go; L/paged.go |
| OS-02 | Implementada | Nova OS [modal] | Cadastrar OS e endereço de atendimento | Natureza instalação/reparo/mudança/retirada/outro; assinante, contrato/ticket opcionais; técnico, agendamento, motivo, duração 5–1440 min, descrição; endereço do cadastro/contrato/manual. Registra evento, SLA e avisos quando aplicáveis. | POST /api/work-orders | P/Field.tsx (WorkOrderForm); E/ordens.go; M/00011_os_estoque_ftth.sql; M/00028_fluxo_os_catalogos_sla.sql |
| OS-03 | Implementada | OS → Detalhe | Atribuir responsável e agendamento | Selecionar técnico/remover; editar data por blur; visualizar endereço resolvido, telefone, origem e SLA. Go impede mudanças incompatíveis em OS finalizada e remove auxiliar promovido a responsável. | PATCH /api/work-orders/:id; GET /api/staff | P/Field.tsx; E/ordens.go |
| OS-04 | Implementada | OS → Detalhe | Fluxo de execução e conclusão | Transições validadas por estado: open/analysis/awaiting_schedule/scheduled/en_route/in_progress/done/canceled. Deslocamento exige responsável; agendada exige data; conclusão/cancelamento exigem resolução; UI exige motivo para aguardar. done cria pesquisa de satisfação; histórico e evento webhook. | POST /api/work-orders/:id/status | P/Field.tsx; E/operacoes.go (workStatus); M/00028_fluxo_os_catalogos_sla.sql |
| OS-05 | Implementada | OS → Detalhe | Auxiliares, kit e checklist | Adicionar/remover auxiliar distinto do responsável; aplicar kit ativo de itens não serializados com baixa transacional; adicionar itens de checklist e marcar feitos com autor/data. OS encerrada não aceita essas alterações. | POST /api/work-orders/:id/helpers; DELETE /api/work-orders/:id/helpers/:userId; POST /api/work-orders/:id/kit; POST /api/work-orders/:id/checklist; POST /api/work-orders/:id/checklist/:itemId | P/Field.tsx (KitAndHelpers); P/Extras.tsx; E/materiais.go; E/estoque.go |
| OS-06 | Implementada | OS → Material utilizado | Lançar e devolver material | Escolhe item não serializado ativo e quantidade; negativa devolve; registra estoque/material/autor e evento OS; impede saldo e devolução incompatíveis segundo handlers. Não altera movimento histórico. | POST /api/work-orders/:id/materials | P/Field.tsx; E/materiais.go; E/estoque.go |
| OS-07 | Implementada | OS → Material utilizado | Instalar equipamento por série | Busca a partir de três caracteres, até cinco candidatos disponíveis; instala unidade in_stock/with_tech em contrato da OS e retira do saldo. UI usa comodato padrão; backend aceita venda via mode=sale. | GET /api/stock/units; POST /api/work-orders/:id/units | P/Field.tsx; E/operacoes.go (installUnit); M/00015_estoque_series.sql |
| OS-08 | Implementada | OS → Histórico | Anotações e eventos | Anotar, consultar mudanças/atribuição/agendamento/material e autor/data. Notas podem ser lançadas por os:write mesmo quando controles de execução já estão ocultos; sem edição/exclusão de evento no painel. | POST /api/work-orders/:id/notes; GET /api/work-orders/:id | P/Field.tsx; E/materiais.go; L/grupos.go |
| OS-09 | Implementada | /meu-trabalho | Operação móvel do técnico | Até 50 OS pendentes atribuídas, atualização 30 s, cartões com dados/telefone, mapa externo OSM e modal Abrir/Continuar. Requer conexão; não há fila offline/sincronização móvel implementada. | GET /api/work-orders | P/Field.tsx (MyWork); L/paged.go |
| OS-10 | Implementada | /agenda | Agenda por técnico, conflitos e janelas | Dia e 1/3/7 dias; detecta sobreposição conforme duração; horas livres por técnico para janela de 60 min entre 8h–18h; fila aguardando agendamento; abrir OS. Sem arrastar agendamento no calendário. | GET /api/agenda; GET /api/agenda/free | P/Agenda.tsx; L/agenda.go |
| OS-11 | Implementada | /estoque | Catálogo de materiais | Criar/editar nome, SKU, unidade, mínimo e flag de série; ativar/desativar; saldo e estoque baixo; bloqueio de mudança de serialização após movimentos. stock:write para mutações; sem pesquisa/pager visual nesta tela. | GET /api/stock/items; POST /api/stock/items; PATCH /api/stock/items/:id | P/Field.tsx (Stock/ItemForm); E/estoque.go |
| OS-12 | Implementada | /estoque → Movimentos | Entradas, saídas, ajustes e consulta | Quantidade positiva em entrada/saída; ajuste assinado com justificativa; controle de saldo e eventos imutáveis. Itens serializados remetem à gestão de unidades, não aceitam lançamento comum pela UI. | GET /api/stock/items/:id/movements; POST /api/stock/items/:id/movements | P/Field.tsx (Movements); E/estoque.go |
| OS-13 | Implementada | /estoque → Unidades | Receber lote e distribuir unidades | Entrada por séries separadas por linha/espaço/vírgula; localizar unidade, situação e detentor; transferir técnico↔almoxarifado; não instala por transferência, instalação vem da OS. | GET /api/stock/items/:id/units; POST /api/stock/items/:id/units; POST /api/stock/units/:id/transfer | P/Field.tsx (Units); E/estoque.go |
| OS-14 | Implementada | /estoque → Unidades | Retirada, defeito, conserto, baixa e histórico | Retirar instalada para estoque; marcar defeito; consertada retorna; baixa definitiva exige motivo; histórico por unidade. Há restrições de transição/saldo no Go; não é inventário contábil depreciável. | POST /api/stock/units/:id/status; GET /api/stock/units/:id/events | P/Field.tsx; E/estoque.go |

### 3.FI Financeiro e cobrança

| ID | Situação | Tela/entrada | Funcionalidade | Comportamento, campos e restrições | Endpoints | Implementação |
|---|---|---|---|---|---|---|
| FI-01 | Implementada | /faturas | Listagem, filtros e visão financeira | q, status abertas/vencidas/pagas/em conciliação/canceladas, empresa, paginação, CSV; indicadores aberto/vencido/recebido/mês/conciliação. Sumário por empresa; gráfico mensal é consulta própria e não recebe automaticamente esse filtro. | GET /api/invoices; GET /api/finance/summary; GET /api/finance/monthly | P/Finance.tsx; L/dinamicas.go; L/auxiliares.go; L/grupos.go |
| FI-02 | Implementada | /faturas → Gerar mensalidades | Geração idempotente por competência | Competência AAAA-MM; Go aplica contrato vigente, versão, proporcional do primeiro mês se configurado, descontos e adicionais em linhas próprias; restrição de unicidade evita duplicação. Texto antigo da tela diz que não aplica regras, contrariando SQL atual. | POST /api/finance/generate | P/Finance.tsx; E/financeiro.go; G/finance/core.go; G/finance/sql/; M/00021_financeiro_avancado.sql; M/00031_condicoes_contrato.sql; M/00044_produtos_adicionais.sql |
| FI-03 | Implementada | Fatura [modal] | Consulta detalhada e saldo devido | Itens, principal/recebido/status/competência/datas; pagamentos e estornos; eventos do gateway; breakdown multa/juros/desconto/saldo. Endpoints reais; meios externos dependem do gateway separado. | GET /api/invoices/:id; GET /api/invoices/:id/due | P/Finance.tsx (InvoiceModal); L/grupos.go; L/auxiliares.go |
| FI-04 | Implementada | Fatura → Baixa manual | Recebimento integral/parcial, taxas e desconto | Valor em centavos, data, meio, observação; marcar parcial mantém saldo; opcional aplicar multa e juros calculados, desconto com motivo. Exige finance:write; saldo divergente pode ir à conciliação; baixa pode gerar evento/reativação conforme política. | POST /api/invoices/:id/manual-payment | P/Finance.tsx; E/financeiro.go; G/finance/core.go (Manual/settle/Paid) |
| FI-05 | Implementada | Fatura → Pagamentos → Estornar | Estorno de baixa manual | Selecionar pagamento manual ainda não estornado, motivo mínimo de cinco caracteres; lança reversão e recalcula título, preserva histórico. Não é devolução bancária; não suspende imediatamente o acesso já reativado. | POST /api/invoices/:id/payments/:paymentId/reverse | P/Finance.tsx; E/financeiro.go; G/finance/core.go (Reverse) |
| FI-06 | Implementada | Fatura → Cancelar | Cancelamento de título com motivo | UI oferece para open; Go valida estado/restrições e registra cancelamento. Não há conector bancário para cancelar boleto real. | POST /api/invoices/:id/cancel | P/Finance.tsx; E/financeiro.go |
| FI-07 | Implementada | Fatura → Resolver conciliação | Decisão manual de divergência | Escolher paga/aberta com justificativa mínima; registra decisão, reconcilia estado e pode disparar processamento de quitação. Não homologa gateway. | POST /api/invoices/:id/resolve | P/Finance.tsx; E/financeiro.go; G/finance/core.go |
| FI-08 | Implementada | /contratos/:id → Financeiro | Extrato financeiro do contrato | Resumo de aberto/vencido/conciliação e tabela; abre mesmo modal de fatura; layout em Acesso para quem lê rede e em Contrato para os demais; finance:read. | GET /api/contracts/:id/finance | P/Finance.tsx (ContractFinance); L/grupos.go |
| FI-09 | Implementada | Contrato → Financeiro → Acordo | Renegociar títulos | Selecionar abertas, até 24 títulos; parcelas 1–24, primeiro vencimento, desconto, taxas e justificativa; usa saldo líquido de parciais; cancela originais e cria parcelas; pode pedir religamento. Não movimenta dinheiro externo. | POST /api/contracts/:id/agreement | P/Finance.tsx (AgreementModal); G/finance/advanced.go (Agreement); E/financeiro.go |
| FI-10 | Implementada | Contrato → Liberação por confiança | Conceder prazo e consultar histórico | Elegibilidade por contrato/estado, política/prazo/intervalo e histórico; equipe informa dias e motivo, trust:grant. Registra liberação e operação de reativação; expiração depende das rotinas e da política de suspensão. | GET /api/contracts/:id/trust-release; POST /api/contracts/:id/trust-release | P/Finance.tsx; G/finance/advanced.go; L/service.go; E/financeiro.go |
| FI-11 | Implementada | /politica-cobranca | Configurar regras de cobrança | settings:manage grava gateway none/demo, billing_auto, auto_suspend/dias, auto_resume, rejeição/perfil, confiança/dias/gap, multa percentual, juros mensais e proporcional primeiro mês. finance:read consulta. Jobs só atuam se habilitados. | GET /api/finance/settings; PUT /api/finance/settings; POST /api/finance/run-auto-suspend | P/Finance.tsx; E/ordens.go (financeSettings); E/financeiro.go; G/finance/gateway.go |
| FI-12 | Implementada | Política → Página de aviso | Configurar página pública de bloqueio/redução | Título, textos, telefone, WhatsApp e botão portal; salvar ou page=null desativa; mostra URL pública. Gera HTML real; o redirecionamento do NAS exige configuração externa e não é implantado por este formulário. | GET /api/notice-page; PUT /api/notice-page; GET /aviso/:slug | P/Finance.tsx (NoticePageCard); E/config.go; L/notice.go |
| FI-13 | Implementada | /faturas → Contabilidade | Exportar CSV contábil | Tipo recebimentos/faturas e datas; backend também aceita company_id; planilha com valores/dados de conferência e registro de auditoria. Não gera NFSe/NFCom ou arquivo fiscal homologado. | GET /api/finance/export | P/Finance.tsx (AccountingExport); E/relatorios.go |
| FI-14 | Implementada | /relatorios-cobranca | Quatro relatórios e CSV | Aging por faixa; recebido por plano/meio líquido de estornos e datas; contrato sem fatura do mês; candidatos a cancelar por dias. Links para contrato, sem cancelamento automático. Go oferece filtros plan_id/pop_id/tag no aging além da UI. | GET /api/finance/reports/aging; GET /api/finance/reports/receipts; GET /api/finance/reports/without-invoice; GET /api/finance/reports/to-cancel | P/Cobranca.tsx; E/relatorios.go |
| FI-15 | Demonstrativa | /conciliacao | Conciliação automática com gateway demo | Consulta cobranças fictícias, recupera pagamento perdido, trata duplicidade e valor divergente; lista eventos e faturas para decisão manual. chargePayments só implementa demo; none não consulta instituição financeira. | GET /api/finance/reconciliation; POST /api/finance/reconcile | P/Finance.tsx; G/finance/gateway.go (chargePayments/Reconcile); E/financeiro.go |
| FI-16 | Demonstrativa | Fatura → Simular pagador | Simulação de pagamento e cobrança | Modos webhook/duplicate/lost/divergent; persiste pagamento de teste em demo_gateway_charges; códigos Pix/boleto explicitamente não pagáveis. Requer modo demo e gateway demo. | POST /api/demo-gateway/pay | P/Finance.tsx; E/gateway.go; G/finance/core.go |
| FI-17 | Não confirmado | Sem interface de gateway real | Cobrança bancária real, Pix/boleto pagável | Não foi localizado conector de gateway além de none/demo; emissão real, extrato real, reembolso e homologação dependem de implementação/fornecedor. Este item registra ausência de comprovação, não uma capacidade disponível. | — | G/finance/core.go (Charges/Demo); G/finance/gateway.go (chargePayments); E/gateway.go; E/ordens.go |

### 3.RE Rede, RADIUS, acesso e CPE

| ID | Situação | Tela/entrada | Funcionalidade | Comportamento, campos e restrições | Endpoints | Implementação |
|---|---|---|---|---|---|---|
| RE-01 | Implementada | /rede → Saúde | Indicadores e inventário de agentes/equipamentos | Agentes offline, falhas recentes, divergências e operações em espera; atualização periódica. Lista equipamentos e vínculo com agente, estado e manutenção. Sujeito a network:read e disponibilidade dos relatos. | GET /api/network/health; GET /api/agents; GET /api/devices | P/Network.tsx; E/rede.go; L/consultas_generated.go |
| RE-02 | Implementada | /rede → Agentes | Cadastrar e administrar agente | Nome, criação, rotação de token, revogação/reativação e limpeza da associação de certificado; token e chave pública de assinatura exibidos no momento da emissão. Certificado e situação de sincronização são acompanhados. | POST /api/agents; PATCH /api/agents/:id | P/Network.tsx; E/rede.go; G/agent/; M/00002_rede_operacoes.sql |
| RE-03 | Implementada | /rede → Equipamentos | Cadastrar equipamento conectado a agente | Nome, driver, host, porta, referência de credencial e agente. Credenciais de equipamentos ficam na configuração local do agente; configuração demo é limitada pelo ambiente. Operação depende de comunicação com agente. | POST /api/devices; PATCH /api/devices/:id | P/Network.tsx; E/rede.go; services/network-agent/nexo_agent/agent.py |
| RE-04 | Implementada | /rede → Concentradores | Adicionar NAS RADIUS integrado | Dados do NAS, fabricante, endereço/forma de conexão, segredo, instruções e estado. Modos de conexão, incluindo túnel, dependem das opções suportadas; comandos copiados não configuram o equipamento automaticamente. Segredo é mostrado na criação/rotação. | POST /api/radius/devices; GET /api/radius/status; GET /api/radius/devices/:id/setup | P/Concentradores.tsx; E/radius.go; L/radius_setup.go; G/radius/; M/00036_radius_integrado.sql |
| RE-05 | Implementada | Concentrador → Configuração | Parâmetros, segredo, túnel e reaplicação | Alterar parâmetros de sessões simultâneas e intervalo de accounting; rodar novo segredo/túnel, inspecionar handshake e reaplicar contas. Operações não demonstram conectividade real por si só. | PATCH /api/radius/devices/:id; POST /api/radius/devices/:id/secret; POST /api/radius/devices/:id/tunnel; POST /api/devices/:id/reapply | P/Concentradores.tsx; E/radius.go; E/rede.go; G/vpn/vpn.go |
| RE-06 | Implementada | /rede → Conversão | Converter concentrador legado ao integrado | Ação para dispositivo compatível, com aviso das contas que precisam de segredo/reaplicação. Alterar cadastro não garante configuração remota do NAS. | POST /api/devices/:id/convert-to-integrated | P/Concentradores.tsx; E/radius.go |
| RE-07 | Implementada | Contrato → Acesso | Criar acesso e manter credenciais | Escolher concentrador, PPPoE/hotspot com login e senha ou IPoE com MAC conforme compatibilidade; senha gerada ou fornecida; atualizar senha/MAC, remover associação MAC e reaplicar. Credenciais não são redisponibilizadas como texto pela ficha. | GET /api/contracts/:id/service; POST /api/contracts/:id/service; PATCH /api/resources/:id/mac; PATCH /api/resources/:id/secret | P/Service.tsx; E/rede.go; E/acessos.go; G/network/ |
| RE-08 | Implementada | Contrato → Acesso | Provisionar, suspender, reativar e desconectar | Botões disparam operações assinadas e versionadas; controle por network:operate, dispositivo, estado desejado e política. Resultado depende do agente ou executor RADIUS e da rede real. | POST /api/resources/:id/:action; GET /api/operations/:id | P/Service.tsx; E/rede.go; G/network/engine.go; G/radius/ |
| RE-09 | Implementada | /operacoes e detalhes | Inspecionar fila e evidências de operações | Lista e modal mostram estado, tentativas, etapas, datas, validade, chave de idempotência, resultado e comparação desejado/observado; recuperação de resultado incerto é controlada pelo motor. | GET /api/operations; GET /api/operations/:id | P/Network.tsx; E/rede.go; G/network/attempts.go |
| RE-10 | Implementada | /online | Consultar sessões e solicitar desconexão | Busca, seleção em lote até 200, CSV e motivo; servidor processa recursos individualmente e informa aceitos/recusados. Visão é baseada no accounting disponível, não garante sessão em tempo real. | GET /api/network/online; POST /api/network/disconnect | P/Atendimento.tsx; E/operacoes.go; E/relatorios.go; G/radius/ |
| RE-11 | Implementada | Contrato → Acesso → Sessões e autenticações | Consultar sessões, tráfego e tentativas | Histórico de accounting, início/fim, IP/NAS, aceites/rejeições e MAC conforme origem; horários e totais dependem de dados enviados ao RADIUS/relatórios do agente. | GET /api/contracts/:id/sessions; GET /api/contracts/:id/radius-log | P/Service.tsx; P/Concentradores.tsx; P/Atendimento.tsx; E/relatorios.go; L/usage.go; M/00036_radius_integrado.sql |
| RE-12 | Implementada | Contrato → CPE | Vincular equipamento e administrar Wi-Fi | Busca candidatos no ACS, vincula/desvincula, mostra dados, atualiza parâmetros, reinicia e configura rede Wi-Fi quando o dispositivo expõe os parâmetros. Envia tarefas ao ACS; execução assíncrona e compatibilidade por modelo não são comprovadas pela simples aceitação da tarefa. | GET /api/contracts/:id/cpe; GET /api/contracts/:id/cpe/candidates; POST /api/contracts/:id/cpe/link; DELETE /api/contracts/:id/cpe/link; POST /api/contracts/:id/cpe/wifi; POST /api/contracts/:id/cpe/reboot; POST /api/contracts/:id/cpe/refresh | P/Cpe.tsx; E/cpe.go; G/acs/ |
| RE-13 | Demonstrativa | /rede e /onus em ambiente demo | Equipamentos e observações simuladas | Drivers e contas sintéticas existem para demonstração; o driver real do agente e o RADIUS integrado são caminhos distintos. Não interpreta a execução demo como equipamento físico. | POST /api/devices; POST /api/resources/:id/:action | P/Network.tsx; services/network-agent/nexo_agent/drivers/; G/config/ |
| RE-14 | Implementada | Contrato → Acesso → Consumo e disponibilidade | Visualizar uso e disponibilidade estimada | Consumo mensal e série por hora/dia/semana/ano; disponibilidade por 7, 15 ou 30 dias calculada com sessões de accounting. A estimativa não é monitoramento direto de enlace e depende dos registros recebidos. | GET /api/contracts/:id/usage; GET /api/contracts/:id/usage-series; GET /api/contracts/:id/availability | P/Extras.tsx; P/Atendimento.tsx; L/usage.go; L/dinamicas.go |

### 3.IN OLT/ONU, FTTH, NOC, IPAM e consulta legal

| ID | Situação | Tela/entrada | Funcionalidade | Comportamento, campos e restrições | Endpoints | Implementação |
|---|---|---|---|---|---|---|
| IN-01 | Implementada | /onus e Contrato → ONU | Descobrir e vincular ONU ao contrato | Lista descobertas do agente; serial/PON, estado, sinal RX/TX e vínculo; cadastro escolhe OLT, serial ou descoberta, porta PON, perfis e VLAN. Validação de serial e requisitos Huawei são aplicados; cada contrato ativo tem limite de vínculo segundo o backend. | GET /api/contracts/:id/onu; POST /api/contracts/:id/onu | P/Olt.tsx; E/olt.go; G/agent/; M/00008_olt_onu.sql; M/00009_olt_huawei.sql |
| IN-02 | Implementada | ONU → Autorizar/desautorizar | Enviar comandos e acompanhar execução | Solicita autorização ou remoção ao agente, registra estados desejado/observado, tentativas e evidências; substituição requer estado anterior compatível. O driver Huawei usa SSH/CLI; integração real depende da configuração e homologação do equipamento. | POST /api/onus/:id/:action; GET /api/operations/:id | P/Olt.tsx; E/olt.go; services/network-agent/nexo_agent/drivers/ |
| IN-03 | Parcial | /onus | Cobertura de equipamentos OLT | Há implementação específica Huawei e driver de demonstração, sem evidência de suporte genérico a todos os fabricantes/modelos. Código do driver informa necessidade de validação em ambiente real; ausência de homologação não implica que o driver seja fictício. | POST /api/contracts/:id/onu; POST /api/onus/:id/:action | E/olt.go; services/network-agent/nexo_agent/drivers/ |
| IN-04 | Implementada | /ftth → Caixas | Cadastrar e manter CTO/CEO | Nome, tipo, capacidade, endereço/coordenadas, caixa pai, OLT/PON e observações; editar/excluir conforme restrições, inclusive prevenção de ciclos e uso existente; visualização de ligações entre caixas. | GET /api/ftth/boxes; POST /api/ftth/boxes; PATCH /api/ftth/boxes/:id; DELETE /api/ftth/boxes/:id | P/Field.tsx; E/infraestrutura.go; M/00011_os_estoque_ftth.sql; M/00040_mapa_coordenadas.sql |
| IN-05 | Implementada | Caixa FTTH → Portas | Reservar e liberar porta | Selecionar porta, contrato ou anotação; impedir conflitos de porta/contrato segundo regras; remover reserva. Exibe uso e vínculo à ficha correspondente. | POST /api/ftth/boxes/:id/drops; DELETE /api/ftth/drops/:id | P/Field.tsx; E/infraestrutura.go |
| IN-06 | Parcial | /ftth e /mapa | Projeto físico completo da rede óptica | Existe mapa esquemático e gestão de caixas/portas, mas não foram identificados cadastro de traçado completo de fibra, fusões, OTDR ou importação de projeto GIS. O desenho não prova conectividade física. | GET /api/ftth/boxes; GET /api/map/points | P/Field.tsx; P/Mapa.tsx; E/infraestrutura.go |
| IN-07 | Implementada | /noc | Visão operacional e configurações | Indicadores de agentes, ONUs, falhas de operações, divergências, OS e SLA; alertas derivados de dados armazenados; parâmetros de RX, limiar de falhas por PON e remoção de ONU ao encerrar contrato. Permissão e módulo NOC aplicam-se. | GET /api/noc/overview; PUT /api/noc/settings | P/Noc.tsx; E/noc.go; G/jobs/; M/00013_noc.sql; M/00014_onu_encerramento.sql |
| IN-08 | Implementada | Contrato → Diagnóstico | Diagnóstico baseado em regras e evidências | Mostra achados, severidade, evidências e sugestões a partir de estados disponíveis de rede/serviço/ONU; não executa teste de cabo, ping ou OTDR apenas por abrir o diagnóstico. | GET /api/contracts/:id/diagnosis | P/Noc.tsx; E/noc.go |
| IN-09 | Implementada | /mapa | Mapa de contratos, POPs e caixas | Camadas e filtros; pan/zoom e busca; pontos limitados por área e truncamento informado; alterar coordenadas de contrato/POP quando permitido. Usa mapas externos no navegador; não faz geocodificação automática. | GET /api/map/points; PUT /api/contracts/:id/location; PUT /api/pops/:id/location | P/Mapa.tsx; E/infraestrutura.go; L/dinamicas.go; M/00040_mapa_coordenadas.sql |
| IN-10 | Implementada | /ipam → Pools e alocações | Manter pools e reservas IPv4/IPv6 individuais | Criar/excluir pool CIDR, tipo e parâmetros; reservar endereço manualmente ou selecionar próximo IPv4 livre dentro dos limites do algoritmo; associar contrato ou descrever reserva e liberar. Aplicação do IPv4 no acesso depende de compatibilidade e reaplicação. | GET /api/ipam/pools; POST /api/ipam/pools; DELETE /api/ipam/pools/:id; POST /api/ipam/pools/:id/allocations; DELETE /api/ipam/allocations/:id | P/Ipam.tsx; E/ipam.go; E/infraestrutura.go; M/00010_ipam_cgnat.sql |
| IN-11 | Parcial | /ipam → Delegações IPv6 | Reservar prefixo para contrato | Cria/libera delegação manual ou automática com comprimento permitido e unicidade; o código RADIUS examinado não entrega automaticamente prefixo IPv6 ao NAS. Portanto o ciclo de provisionamento IPv6 não está completo. | POST /api/ipam/pools/:id/delegations; DELETE /api/ipam/delegations/:id | P/Ipam.tsx; E/ipam.go; G/radius/vendor.go; M/00017_ipv6_delegacao.sql |
| IN-12 | Implementada | /ipam → CGNAT | Planejar blocos de portas e gerar script | Valida faixa privada/pública, quantidade de portas e capacidade; cria plano determinístico, visualiza mapa, gera script RouterOS e retira plano preservando histórico. O script precisa ser aplicado externamente. | POST /api/cgnat/plans/check; POST /api/cgnat/plans; POST /api/cgnat/plans/:id/retire; GET /api/cgnat/plans/:id/map; GET /api/cgnat/plans/:id/script | P/Ipam.tsx; E/ipam.go; L/cgnat.go; M/00010_ipam_cgnat.sql |
| IN-13 | Parcial | /ipam → Rastrear CGNAT | Encontrar o responsável em um instante | Busca IP público e porta, com horário opcional; backend inclui titulares históricos, mas a tela apresenta dados atuais e não exibe a coleção holders_at. A resposta visual isolada pode não comprovar titularidade histórica. | GET /api/cgnat/trace | P/Ipam.tsx; E/ipam.go; M/00010_ipam_cgnat.sql |
| IN-14 | Implementada | /consulta-ip | Pesquisa legal por IP e período | IP, porta opcional, intervalo, fuso e margem; retorna candidatos e sessões de accounting/CGNAT, permite impressão e CSV quando há sessões e mantém histórico auditável. Janela e quantidade têm limites no servidor. | POST /api/legal/ip-lookup | P/ConsultaIp.tsx; E/ipam.go; M/00010_ipam_cgnat.sql; M/00025_sessoes_contatos_pops.sql |
| IN-15 | Parcial | /consulta-ip → IPv6 histórico | Identificar titular IPv6 anterior | A consulta usa delegações registradas e sua data de criação; não foi encontrada manutenção completa de titulares de delegação anteriores após liberação. Resultados históricos exigem conferência das fontes existentes. | POST /api/legal/ip-lookup | E/ipam.go; M/00017_ipv6_delegacao.sql |
| IN-16 | Implementada | /manutencoes | Comunicar manutenção programada | Cadastrar aviso, período/abrangência, consultar, cancelar e disparar notificações; avisos chegam ao portal conforme vínculo e regras. Envio externo depende de canais configurados. | POST /api/maintenance-notices; POST /api/maintenance-notices/:id/cancel; POST /api/maintenance-notices/:id/notify | P/Extras.tsx; E/condicoes.go; E/rotinas.go; M/00022_cadastro_manutencao_campo.sql |
| IN-17 | Implementada | Contrato → Acesso → Infraestrutura | Consultar endereços, prefixos e caixa | Cartão consulta IPv4, delegações IPv6 e caixa/porta vinculados ao contrato; cadastro e liberação são feitos nas telas IPAM e FTTH. | GET /api/contracts/:id/ips; GET /api/contracts/:id/ipv6; GET /api/contracts/:id/ftth | P/Noc.tsx; L/consultas.go; L/grupos.go |

### 3.AD Administração, comunicação, qualidade e integrações

| ID | Situação | Tela/entrada | Funcionalidade | Comportamento, campos e restrições | Endpoints | Implementação |
|---|---|---|---|---|---|---|
| AD-01 | Implementada | /usuarios | Cadastro e gestão da equipe | Criar nome/e-mail/perfil/senha; trocar perfil, ativar/bloquear outro usuário, redefinir MFA e associar POPs; restrições para ações sobre o próprio usuário. Não há editor visual de permissões arbitrárias. | GET /api/users; POST /api/users; PATCH /api/users/:id; PUT /api/users/:id/pops | P/Users.tsx; G/auth/permissions.go; I/; M/00034_escopo_pop_aviso_documentos.sql |
| AD-02 | Parcial | /usuarios | Redefinição de senha de outro usuário | O backend permite atualização da senha pelo endpoint de administração, mas não foi encontrado controle correspondente na tela de usuários, embora o texto de ajuda de login sugira procurar o administrador. | PATCH /api/users/:id | P/Users.tsx; P/Login.tsx; I/ |
| AD-03 | Implementada | /provedores | Provedores e módulos de produto | Operador SaaS cria provedor e administrador, altera status e módulos disponíveis; entra em suporte com motivo e sai pelo banner. Operações são separadas do contexto comum do provedor. | GET /api/tenants; POST /api/tenants; PATCH /api/tenants/:id; POST /api/support/enter; POST /api/support/exit | P/Tenants.tsx; I/; G/tenancy/; M/00018_modulos.sql |
| AD-04 | Implementada | /empresas e Contrato → Empresa | Empresas de faturamento | Cadastrar nome/CNPJ, definir padrão, ativar/inativar respeitando restrição da padrão e associar ao contrato; filtro em faturas. Não constitui emissão fiscal automática. | GET /api/companies; POST /api/companies; PATCH /api/companies/:id; PUT /api/contracts/:id/company | P/Empresas.tsx; E/empresas_tags.go; M/00041_empresas.sql |
| AD-05 | Implementada | /pops | Cadastrar e administrar POPs | Nome, cidade e estado, contagens de contratos; ativar/inativar e associar a usuários/contratos. Edição de dados cadastrais existe no servidor, mas não foi localizada na tela. | GET /api/pops; POST /api/pops; PATCH /api/pops/:id; PUT /api/contracts/:id/pop | P/Atendimento.tsx; E/config.go; M/00025_sessoes_contatos_pops.sql; M/00034_escopo_pop_aviso_documentos.sql |
| AD-06 | Implementada | /avisos | Notificações do provedor via webhook | Salvar/remover URL, testar entrega e executar pendentes; histórico de estados e tentativas. Mensagens saem via HTTP; integração depende do destinatário, rede e configuração segura. | GET /api/notifications; PUT /api/notifications/settings; POST /api/notifications/test; POST /api/notifications/deliver | P/Notices.tsx; E/integracoes.go; G/outbound/; M/00016_avisos.sql |
| AD-07 | Implementada | /avisos-assinante → Canais | Cadastrar e testar canais de mensagem | Nome, URL, nomes dos campos de telefone e mensagem e autorização opcional; ativar, desativar, excluir, enviar teste; segredo protegido no backend. É um adaptador HTTP genérico, não um conector universal homologado para WhatsApp. | GET /api/notice-channels; POST /api/notice-channels; PATCH /api/notice-channels/:id; DELETE /api/notice-channels/:id; POST /api/notice-channels/:id/test | P/AvisosAssinante.tsx; E/avisos.go; E/integracoes.go; G/outbound/; M/00027_avisos_ao_assinante.sql |
| AD-08 | Implementada | /avisos-assinante → Modelos | Criar e excluir textos com variáveis | Modelo parametrizado de mensagem e catálogo de variáveis; exclusão sujeita ao uso. A tela não oferece edição de modelo existente. | GET /api/notice-templates; POST /api/notice-templates; DELETE /api/notice-templates/:id | P/AvisosAssinante.tsx; E/avisos.go |
| AD-09 | Implementada | /avisos-assinante → Régua e histórico | Disparar mensagens de cobrança | Regra por dias em relação ao vencimento, janela, canal, modelo e plano opcional; criar, pausar, ativar, excluir e executar agora. Enfileiramento considera consentimento e deduplicação; histórico não é caixa de entrada ou conversa. | GET /api/notice-rules; POST /api/notice-rules; PATCH /api/notice-rules/:id; DELETE /api/notice-rules/:id; POST /api/notice-rules/run | P/AvisosAssinante.tsx; E/avisos.go; G/jobs/; M/00035_fila_de_avisos.sql |
| AD-10 | Implementada | /integracoes → Tokens | Credenciais para API pública | Criar token com nome, escopos, limite e expiração, exibir segredo uma vez, consultar prefixo/uso e revogar. API pública tem escopos e rate limit próprios. | GET /api/api-tokens; POST /api/api-tokens; DELETE /api/api-tokens/:id | P/Integracoes.tsx; E/acessos.go; E/integracoes.go; E/public.go; M/00029_api_publica_webhooks.sql |
| AD-11 | Implementada | /integracoes → Webhooks | Destinos, assinatura e entregas | Criar URL/eventos/segredo, ativar/desativar, excluir, rotacionar segredo, testar, consultar histórico e solicitar repetição de falha. Assinatura HMAC e validação de destino são feitas no servidor; sucesso depende do receptor. | GET /api/webhook-endpoints; POST /api/webhook-endpoints; PATCH /api/webhook-endpoints/:id; DELETE /api/webhook-endpoints/:id; POST /api/webhook-endpoints/:id/rotate-secret; POST /api/webhook-endpoints/:id/test; POST /api/webhook-deliveries/:id/retry | P/Integracoes.tsx; E/integracoes.go; G/outbound/; G/jobs/ |
| AD-12 | Implementada | /qualidade → Catálogos | Tipos, classificações, causas e motivos | Criar e ativar/desativar itens de atendimento, OS e anotações; sem edição do nome na UI, embora PATCH aceite alteração no backend. | GET /api/catalogs; POST /api/catalogs; PATCH /api/catalogs/:id | P/Qualidade.tsx; E/config.go; M/00028_fluxo_os_catalogos_sla.sql; M/00030_estados_motivos_anotacoes.sql |
| AD-13 | Implementada | /qualidade → SLA | Políticas e acompanhamento de prazo | Criar para atendimento ou OS por prioridade/tipo, prazo em minutos e responsável de escalonamento; ativar/desativar/excluir quando permitido; relatório de violações e tempos corridos. Alterações completas de política não estão expostas na tela. | GET /api/sla-policies; POST /api/sla-policies; PATCH /api/sla-policies/:id; DELETE /api/sla-policies/:id; GET /api/reports/sla | P/Qualidade.tsx; E/config.go; L/dinamicas.go; G/jobs/ |
| AD-14 | Implementada | /qualidade → Satisfação | Consultar pesquisas de OS | Lista situação, notas e comentários e consolida média e proporção de avaliações positivas; pesquisas são geradas na conclusão da OS e respondidas pelo portal. | GET /api/surveys; POST /api/portal/surveys/:id | P/Qualidade.tsx; P/Portal.tsx; E/operacoes.go; E/config.go |
| AD-15 | Implementada | /qualidade → Campos personalizados | Definir e usar campos de assinante/contrato | Nome/chave, tipo texto/número/data/booleano/seleção, opções e obrigatoriedade; criar e ativar/desativar; valores editados nas fichas. Servidor permite atualizar mais propriedades do que a tela expõe. | GET /api/custom-fields; POST /api/custom-fields; PATCH /api/custom-fields/:id | P/Qualidade.tsx; P/Extras.tsx; E/config.go; E/custom.go; M/00032_campos_kits_comissao.sql |
| AD-16 | Implementada | /qualidade → Kits | Criar kits de materiais | Nome e itens não serializados com quantidade; ativar/desativar e aplicar em OS para baixa transacional. A UI não oferece editor posterior dos itens de um kit. | GET /api/install-kits; POST /api/install-kits; PATCH /api/install-kits/:id; POST /api/work-orders/:id/kit | P/Qualidade.tsx; P/Field.tsx; E/documentos.go; E/estoque.go; E/materiais.go |
| AD-17 | Parcial | /qualidade → Comissões | Regras e relatório de comissões | Regras de venda/OS, natureza e valores de responsável/auxiliar; relatório por período e técnico. Apuração usa regras atuais para registros históricos e não há folha, pagamento ou liquidação de comissão. | GET /api/commission-rules; POST /api/commission-rules; GET /api/reports/commissions | P/Qualidade.tsx; E/documentos.go; E/relatorios.go; M/00032_campos_kits_comissao.sql |
| AD-18 | Parcial | /anatel | Dados DICI por competência | Consulta agregada por empresa/CNPJ, município, tecnologia, área e velocidade; configuração de tecnologia e código municipal e exportação CSV. Não foi identificada transmissão automática nem comprovada adequação do arquivo a leiaute oficial vigente. | GET /api/anatel/dici; PUT /api/anatel/municipalities; PUT /api/plans/:id/technology; PUT /api/contracts/:id/service-area | P/Anatel.tsx; E/relatorios.go; E/condicoes.go; M/00049_anatel_dici.sql |
| AD-19 | Implementada | /importacao | Importar CSV em lotes e conferir erros | Selecionar tipo/arquivo, mapear colunas e planos, pré-visualizar com rollback, importar e consultar linhas/avisos; cadastros, contratos, contas, faturas e históricos disponíveis conforme tipo. Provisionamento é etapa separada; contas sem senha exigem tratamento. | POST /api/import/preview; POST /api/import/apply; GET /api/import/batches; GET /api/import/batches/:id; POST /api/import/batches/:id/provision | P/Import.tsx; E/importacao.go; M/00004_portal_importacao.sql; M/00050_importacao_historico.sql |
| AD-20 | Parcial | /importacao e ferramentas SGP | Migração automatizada de qualquer instalação SGP | Há cliente e ferramentas auxiliares de leitura/exportação e importador CSV mapeado, sem evidência de conector universal com mapeamento completo e corte automático; senhas/relacionamentos e dados reais exigem conferência. | POST /api/import/preview; POST /api/import/apply | P/Import.tsx; E/importacao.go; tools/sgp-migracao/ |
| AD-21 | Implementada | /auditoria | Consultar eventos e retenção | Lista eventos de auditoria, usuários e ações; ajustar retenção de autenticação, sessões e avisos, com limites. Aplicação de limpeza depende de job habilitado; registro financeiro não é apagado por esse controle. | GET /api/audit; GET /api/settings/retention; PUT /api/settings/retention | P/Audit.tsx; E/config.go; G/audit/; G/jobs/; M/00053_retencao.sql |

### 3.PO Portal do assinante

O portal é o componente `Portal` escolhido pelo perfil autenticado, com dados limitados ao próprio assinante. Não há uma rota React própria para cada cartão/modal. O módulo `crm` controla chamados; `field`, pesquisas.

| ID | Situação | Tela/entrada | Funcionalidade | Comportamento, campos e restrições | Endpoints | Implementação |
|---|---|---|---|---|---|---|
| PO-01 | Implementada | Portal → Início | Situação dos planos e acesso | Saudação, planos, velocidade, mensalidade, vencimento e acesso desejado/observado; manutenção ativa ou agendada e dados cadastrais de leitura. Saída encerra sessão. | GET /api/portal/overview; POST /api/auth/logout | P/Portal.tsx; L/service.go; G/auth/ |
| PO-02 | Implementada | Portal → Minhas faturas | Consultar títulos e abrir meios de pagamento | Mostra competência, vencimento, valor e situação; botão abre modal com códigos copiáveis se disponíveis. Em gateway demo são códigos fictícios; nenhum gateway real foi encontrado. | GET /api/portal/overview | P/Portal.tsx; L/service.go; G/finance/core.go |
| PO-03 | Implementada | Portal → Religar internet | Liberação temporária por confiança | Exibe elegibilidade ou prazo ativo; confirmação solicita liberação do próprio contrato segundo política e limites do provedor. | POST /api/portal/trust-release | P/Portal.tsx; E/financeiro.go; G/finance/advanced.go |
| PO-04 | Implementada | Portal → Meu consumo | Resumo e série temporal de uso | Totais e série por hora/dia/semana/ano quando houver dados; gráfico detalhado usa o primeiro contrato ativo, sem seletor entre vários contratos. Depende de accounting disponível. | GET /api/portal/overview; GET /api/portal/usage-series | P/Portal.tsx; P/Extras.tsx; L/usage.go |
| PO-05 | Implementada | Portal → Wi-Fi | Alterar Wi-Fi do próprio CPE | Exibe dados disponíveis do equipamento vinculado e formulário de Wi-Fi; envia tarefa ao ACS para o próprio contrato. Disponibilidade e sucesso dependem de suporte do CPE e do ACS. | GET /api/portal/cpe; POST /api/portal/cpe/:contractId/wifi | P/Cpe.tsx; E/cpe.go; G/acs/ |
| PO-06 | Implementada | Portal → Atendimento | Abrir chamado e responder | Criar chamado e consultar conversa dos próprios atendimentos, enviar mensagem pública; notas internas de equipe não são expostas. Exige módulo CRM. | GET /api/portal/tickets; GET /api/portal/tickets/:id; POST /api/portal/tickets; POST /api/portal/tickets/:id/messages | P/Crm.tsx; E/crm.go; L/service.go |
| PO-07 | Implementada | Portal → Pesquisa de satisfação | Responder sobre OS concluída | Nota de 1 a 5 e comentário opcional para pesquisa pendente; exige módulo campo. Servidor valida vínculo e situação. | GET /api/portal/surveys; POST /api/portal/surveys/:id | P/Portal.tsx; E/avisos.go; L/consultas_generated.go |
| PO-08 | Implementada | Portal → Documentos para aceitar | Ler e aceitar solicitação | Modal exibe texto e exige marcação de concordância; aceite registra conteúdo, data e evidências de acesso; é possível fechar para decidir depois. | GET /api/portal/acceptances; POST /api/portal/acceptances/:id/accept | P/Portal.tsx; E/acessos.go; M/00042_aceite_eletronico.sql |
| PO-09 | Parcial | Portal → Pagamento online real | Quitar fatura em instituição financeira | O botão mostra meios disponibilizados pelo backend; hoje a geração localizada é demonstrativa ou ausente. Não foi encontrada operação real de Pix/boleto no código do gateway. | GET /api/portal/overview | P/Portal.tsx; G/finance/core.go; G/finance/gateway.go |

### 3.BE Recursos sem interface correspondente e processamento interno

As linhas abaixo identificam capacidade concreta do servidor ou serviço auxiliar. APIs listadas podem ser consumidas por integrações autorizadas; não significa que o painel apresente todos os parâmetros.

| ID | Situação | Tela/entrada | Funcionalidade | Comportamento, campos e restrições | Endpoints | Implementação |
|---|---|---|---|---|---|---|
| BE-01 | Somente backend | API pública /public/v1 | Catálogo e consultas externas autorizadas | Consulta assinantes, detalhe de assinante, contratos, faturas e OS por token, escopos, módulo API e limite; contexto isolado por provedor. | GET /public/v1; GET /public/v1/subscribers; GET /public/v1/subscribers/:id; GET /public/v1/contracts; GET /public/v1/invoices; GET /public/v1/work-orders/:id | E/public.go; E/integracoes.go; M/00029_api_publica_webhooks.sql |
| BE-02 | Somente backend | API pública /public/v1 | Criar atendimento e OS por integração | Cria atendimento ou OS com escopo de escrita; chave de idempotência opcional guarda resultado para repetição controlada. | POST /public/v1/tickets; POST /public/v1/work-orders | E/public.go; E/crm.go; E/ordens.go; M/00029_api_publica_webhooks.sql |
| BE-03 | Somente backend | API de contratos | Endereço de instalação específico | Atualizar o endereço de instalação associado ao contrato; não foi encontrado editor correspondente na ficha de contrato, apesar de a OS poder usar o endereço do contrato. | PUT /api/contracts/:id/install-address | E/config.go; M/00028_fluxo_os_catalogos_sla.sql |
| BE-04 | Somente backend | API de contratos | Indicação de outro contrato | Gravar ou remover referência de indicação entre contratos conforme validações; não foi encontrado controle na ficha. | PUT /api/contracts/:id/referral | E/comercial.go; M/00031_condicoes_contrato.sql |
| BE-05 | Somente backend | API CRM | Campos adicionais de atendimento e conversão de lead | PATCH aceita campos estruturados de classificação conforme schema; conversão do prospecto pode vincular assinante existente, além do fluxo de criar assinante apresentado na UI. | PATCH /api/tickets/:id; POST /api/leads/:id/convert | E/crm.go; E/schemas.go; P/Crm.tsx |
| BE-06 | Somente backend | API administrativa | Atualização de senha de usuário, dados de POP/empresa e parâmetros de qualidade | Handlers aceitam campos que as telas não expõem: senha de terceiro, edição cadastral de POP/empresa, rótulos de catálogo e propriedades de SLA e campos personalizados. Sujeitos à permissão do endpoint. | PATCH /api/users/:id; PATCH /api/pops/:id; PATCH /api/companies/:id; PATCH /api/catalogs/:id; PATCH /api/sla-policies/:id; PATCH /api/custom-fields/:id | I/service.go; E/config.go; E/empresas_tags.go; E/config.go; E/config.go; E/custom.go |
| BE-07 | Somente backend | API de equipamentos e IPAM | Editar propriedades além dos controles visuais | PATCH de equipamento e pool suporta campos cadastrais além dos botões de manutenção e exclusão exibidos; as mesmas validações e permissões do servidor continuam aplicáveis. | PATCH /api/devices/:id; PATCH /api/ipam/pools/:id | E/rede.go; E/ipam.go; E/infraestrutura.go; P/Network.tsx; P/Ipam.tsx |
| BE-08 | Somente backend | API CGNAT | Consultar bloco por IP privado e titulares históricos | Lookup do plano por endereço e resposta holders_at no rastreamento fornecem dados que não aparecem integralmente na tela de busca do IP público. | GET /api/cgnat/plans/:id/lookup; GET /api/cgnat/trace | L/cgnat.go; E/ipam.go; P/Ipam.tsx |
| BE-09 | Somente backend | API financeira | Filtros adicionais de relatório/exportação | Aging aceita plano, POP e tag; exportação contábil aceita empresa. A UI utiliza um subconjunto dos parâmetros. | GET /api/finance/reports/aging; GET /api/finance/export | E/relatorios.go; P/Cobranca.tsx; P/Finance.tsx |
| BE-10 | Somente backend | Protocolo de agente /agent/v1 | Autenticar, sincronizar e despachar operações | Hello, confirmação de sincronização, poll, início/progresso/resultado, observações e relatórios de OLT, uso e sessões; token, certificado mTLS, identidade e validação de propriedade do equipamento. Escuta e configuração do serviço são independentes da UI. | POST /agent/v1/hello; POST /agent/v1/sync-done; POST /agent/v1/poll; POST /agent/v1/attempts/:id/begin; POST /agent/v1/attempts/:id/progress; POST /agent/v1/attempts/:id/result; POST /agent/v1/observations; POST /agent/v1/olt-report; POST /agent/v1/usage-report; POST /agent/v1/sessions-report | G/agent/; G/network/; apps/api-go/cmd/api/main.go |
| BE-11 | Somente backend | Motor de rede | Fila, assinatura e recuperação de operações | Outbox transacional/River, envelope Ed25519, expiração, idempotência, versões desejada/observada, reserva de tentativa e tratamento de resultado incerto. Aplicação efetiva depende do executor e estado externo. | GET /api/operations; GET /api/operations/:id | G/network/engine.go; G/network/attempts.go; G/jobs/; M/00002_rede_operacoes.sql |
| BE-12 | Somente backend | RADIUS integrado | Autorização, accounting e desconexão | Persistência de contas e atributos por fabricante; FreeRADIUS externo consulta PostgreSQL e envia accounting; executor Go sincroniza dados e solicita Disconnect RFC 5176. Não há entrega automática de prefixo IPv6 demonstrada. | — | G/radius/; infra/radius/; M/00036_radius_integrado.sql; M/00038_escala_radius.sql |
| BE-13 | Somente backend | Agente de rede Python | Executar comandos e relatar observações | Agente Python mantém credenciais locais e diário SQLite, valida envelope, aplica driver e relata progresso/resultado; há drivers Mikrotik RADIUS local e Huawei OLT, além de demo. Necessita instalação e configuração no ambiente de rede. | POST /agent/v1/poll; POST /agent/v1/attempts/:id/result; POST /agent/v1/observations | services/network-agent/nexo_agent/agent.py; services/network-agent/nexo_agent/executor.py; services/network-agent/nexo_agent/store.py; services/network-agent/nexo_agent/drivers/ |
| BE-14 | Somente backend | Serviço Go de VPN | Gerir configuração e túneis dos NAS | Processo nexo-vpn sincroniza peers/configuração e estado, chama ferramentas do sistema para WireGuard e L2TP/IPsec e auxilia desconexão. É serviço distinto; depende de pacotes, privilégios e rede do host. | — | apps/api-go/cmd/nexo-vpn/; G/vpn/vpn.go; infra/prod/ |
| BE-15 | Somente backend | Serviço ACS externo | Integrar CPE TR-069 via HTTP | Cliente Go conversa com API GenieACS, interpreta parâmetros comuns TR-098/TR-181 e agenda tarefas. GenieACS é serviço externo, não reimplementado em Go; atendimento real depende de modelo e configuração. | — | G/acs/; E/cpe.go; infra/compose/ |
| BE-16 | Somente backend | Processamento periódico | Cobrança, suspensão, confiança e reconciliação | Rotinas geram mensalidade, atualizam condições agendadas, expiram confiança, avaliam suspensão e conciliam gateway. Execução depende das flags dos jobs e configuração financeira; conciliação automatizada atual usa demo. | — | G/jobs/; G/finance/; E/rotinas.go; apps/api-go/cmd/api/main.go |
| BE-17 | Somente backend | Processamento periódico | Avisos, webhooks, SLA, alertas e limpeza | Workers executam filas de notificações, tentativas de webhooks, avaliação/escalonamento de SLA, alerta de saúde e retenção; parâmetros, flags e entrega externa são condicionantes. | — | G/jobs/; E/rotinas.go; G/outbound/; M/00029_api_publica_webhooks.sql; M/00053_retencao.sql |
| BE-18 | Somente backend | Processamento periódico | Sincronização e agregação de RADIUS | Jobs drenam operações do RADIUS, sincronizam accounting e agregam consumo; disponibilidade dos resultados depende de accounting e agendamento configurados. | — | G/jobs/; G/radius/; M/00023_consumo.sql; M/00043_consumo_diario.sql; M/00047_consumo_por_hora.sql |
| BE-19 | Somente backend | Operação de banco | Preparação, migrações e diagnóstico operacional | Executável nexo-db oferece preparação/bootstrap, baseline, aplicação de migrations e jobs, verificação, operador, rotação de segredos, preflight, demo e TOTP conforme comando e configuração. Não foi executado neste inventário. | — | apps/api-go/cmd/nexo-db/; G/db/; db/migrations/ |
| BE-20 | Somente backend | Segurança e isolamento | Sessão, CSRF, MFA, escopo e auditoria | Sessão com token armazenado em hash, cookies e CSRF, MFA TOTP opcional/configurável, limite de login, permissões fixas, escopo de provedor/POP, RLS e auditoria. Cookies seguros/MFA obrigatória dependem de configuração. | POST /api/auth/login; POST /api/auth/logout; GET /api/me; POST /api/me/mfa/setup; POST /api/me/mfa/enable; POST /api/me/mfa/disable | G/auth/; I/; G/tenancy/; G/db/; M/00005_mfa.sql; M/00019_limite_login.sql; M/00034_escopo_pop_aviso_documentos.sql |
| BE-21 | Somente backend | Observabilidade | Saúde, métricas e especificação interna | Logs estruturados, métricas Prometheus e OpenTelemetry conforme configuração; listener interno disponibiliza health, métricas e OpenAPI. Endereços e exposição dependem da implantação. | GET /healthz; GET /metrics; GET /openapi.json | apps/api-go/cmd/api/main.go; G/config/ |
| BE-22 | Somente backend | Infraestrutura e scripts | Backup, cópia e restauração | Scripts produzem backup e checksum, podem copiar para destino configurado e verificar restauração em ambiente temporário; execução, agendamento e cópia externa não foram comprovados aqui. | — | scripts/backup.sh; infra/prod/; infra/compose/ |
| BE-23 | Parcial | Diretório de células | Distribuição em múltiplas células de dados | Há tabelas e diretório para células, porém a implementação de escopo inspecionada limita o acesso à célula c1. Migração e operação distribuída entre células não estão completas. | — | M/00056_diretorio_celulas.sql; G/db/; G/tenancy/ |
| BE-24 | Somente backend | API de relatórios | Consultar indicações | Consulta de indicações cadastradas em contratos, protegida por finance:read; não foi encontrada página ou botão correspondente. | GET /api/reports/referrals | L/consultas.go; L/consultas_generated.go; E/comercial.go |
| BE-25 | Somente backend | API RADIUS | Consultar origens de NAS autorizadas | Retorna a relação de origens autorizadas para uso interno da integração RADIUS; não foi localizado controle visual dedicado. | GET /api/radius/allowed-sources | L/grupos.go; L/grupos_generated.go; G/radius/ |
| BE-26 | Somente backend | API financeira | Criar cobrança avulsa | Cria fatura para contrato com descrição, valor positivo e vencimento; não foi encontrado formulário de criação avulsa genérica no painel. Multa rescisória utiliza outro fluxo. | POST /api/invoices | E/financeiro.go; G/finance/core.go; P/Finance.tsx |
| BE-27 | Somente backend | API de etiquetas | Excluir etiqueta do catálogo | Exclusão da etiqueta global com validações do servidor; o formulário de etiquetas da ficha oferece criar e vincular, sem controle global de exclusão. | DELETE /api/tags/:id | E/empresas_tags.go; P/Extras.tsx |

## 4. Banco, integrações e dependências operacionais

| Domínio | Estruturas e vínculos relevantes | Evidência |
|---|---|---|
| Identidade e cadastro | Provedores, usuários, sessões, trilhas de auditoria, assinantes, planos/versionamento, contratos/histórico; MFA, limites de autenticação e invalidação de sessão. Escopo e políticas RLS são parte da implementação, além das permissões na API. | M/00001_identidade_cadastro.sql; M/00005_mfa.sql; M/00007_endurecimento.sql; M/00019_limite_login.sql; M/00055_invalidacao_sessao.sql |
| Rede e inventário | Agentes, dispositivos, recursos, operações e tentativas; OLT/ONU e descoberta; atributos de acesso, MAC e RADIUS integrado, credenciais/túneis. Estado desejado e observado são armazenados separadamente. | M/00002_rede_operacoes.sql; M/00008_olt_onu.sql; M/00009_olt_huawei.sql; M/00024_mac_do_servico.sql; M/00036_radius_integrado.sql; M/00037_tunel_vpn.sql; M/00046_tipo_de_acesso.sql; M/00048_tunel_l2tp.sql |
| Endereços e rede óptica | Pools, alocações e planos CGNAT, delegações IPv6, caixas e portas FTTH, pontos geográficos e POPs. São cadastros e regras de unicidade, não prova de configuração física. | M/00010_ipam_cgnat.sql; M/00011_os_estoque_ftth.sql; M/00017_ipv6_delegacao.sql; M/00025_sessoes_contatos_pops.sql; M/00040_mapa_coordenadas.sql |
| Financeiro e condições | Faturas, itens, pagamentos, eventos e gateway demo; descontos, acordos, fidelidade, confiança, mudanças programadas, adicionais, empresas e aceite. Há vínculo de competência e histórico preservado em regras financeiras. | M/00003_financeiro.sql; M/00020_suspensao_por_perfil.sql; M/00021_financeiro_avancado.sql; M/00026_degraus_por_plano.sql; M/00031_condicoes_contrato.sql; M/00041_empresas.sql; M/00042_aceite_eletronico.sql; M/00044_produtos_adicionais.sql |
| Atendimento e campo | Leads/eventos, tickets/mensagens, OS/eventos, estoque/movimentos/unidades, checklist, auxiliares e kits; catálogos, SLA e pesquisas. Referências comerciais e log operacional ligam os módulos. | M/00011_os_estoque_ftth.sql; M/00012_crm_atendimento.sql; M/00015_estoque_series.sql; M/00028_fluxo_os_catalogos_sla.sql; M/00032_campos_kits_comissao.sql |
| Comunicação e integrações | Avisos e fila, modelos/canais/régua, tokens, limitação/idempotência e entregas de webhook; consentimento e contatos. | M/00016_avisos.sql; M/00025_sessoes_contatos_pops.sql; M/00027_avisos_ao_assinante.sql; M/00029_api_publica_webhooks.sql; M/00035_fila_de_avisos.sql |
| Dados e conformidade | Lotes/linhas de importação, histórico, documentos, configurações de retenção, dados LGPD, DICI, CPE e agregados de consumo; tabelas não substituem validação legal ou de qualidade dos dados. | M/00004_portal_importacao.sql; M/00023_consumo.sql; M/00034_escopo_pop_aviso_documentos.sql; M/00043_consumo_diario.sql; M/00045_lgpd_titular.sql; M/00047_consumo_por_hora.sql; M/00049_anatel_dici.sql; M/00050_importacao_historico.sql; M/00052_tr069_cpe.sql; M/00053_retencao.sql |
| Estrutura operacional | Registro de migrations adotado pelo Goose, diretório de células e jobs River em estrutura própria. Diretório de células tem limitação explicitada em BE-23. | M/00054_adocao_goose.sql; M/00056_diretorio_celulas.sql; G/db/; G/jobs/ |

**Dependências fora do Go:** painel em React/TypeScript; agente de rede em Python; FreeRADIUS, PostgreSQL, GenieACS, serviços de VPN e utilitários de rede externos conforme implantação; mapa pode carregar tiles externos. Encontrar esses componentes no repositório ou em configuração não comprova que estejam ativos. O fluxo de CPE usa um ACS externo; o fluxo de autenticação RADIUS usa FreeRADIUS; nenhum deles foi executado nesta tarefa.

## 5. Matriz de telas, funcionalidades e código

A situação e o detalhe de cada unidade aparecem na seção 3. Esta matriz liga todos os padrões de tela às unidades; endpoints são exemplos principais, não uma afirmação de que apenas esses são usados.

| Página/entrada | IDs de funcionalidades | Endpoints principais | Componente |
|---|---|---|---|
| /login | AC-01, AC-02 | POST /api/auth/login; GET /api/health | P/Login.tsx |
| / | AC-05, AC-06 | GET /api/dashboard; GET /api/today; GET /api/dashboard/panels | P/Dashboard.tsx; P/Cobranca.tsx |
| /assinantes | AS-01, AS-02 | GET/POST /api/subscribers | P/Subscribers.tsx |
| /assinantes/:id | AS-02–10, CO-07, CR-06–08, OS-01–08, AD-15 | GET/PATCH /api/subscribers/:id; POST /api/contracts | P/Subscribers.tsx; P/Atendimento.tsx; P/Crm.tsx; P/Field.tsx |
| /planos | CO-01–04 | GET/POST /api/plans; PATCH /api/plans/:id | P/Plans.tsx |
| /contratos | CO-06 | GET /api/contracts | P/Contracts.tsx |
| /contratos/:id | CO-08–23, FI-08–10, RE-07–08, RE-11–12, RE-14, IN-01–02, IN-08, IN-17, OS-01–08 | GET/PATCH /api/contracts/:id; GET /api/contracts/:id/service; GET /api/contracts/:id/finance | P/Contracts.tsx; P/Service.tsx; P/Condicoes.tsx; P/Olt.tsx; P/Cpe.tsx |
| /faturas | FI-01–07, FI-13, FI-16 | GET /api/invoices; GET /api/invoices/:id; POST /api/finance/generate | P/Finance.tsx |
| /conciliacao | FI-07, FI-15 | GET /api/finance/reconciliation; POST /api/finance/reconcile | P/Finance.tsx |
| /politica-cobranca | FI-11–12 | GET/PUT /api/finance/settings; GET/PUT /api/notice-page | P/Finance.tsx |
| /rede | RE-01–06, RE-13 | GET /api/network/health; POST /api/agents; POST /api/devices; POST /api/radius/devices | P/Network.tsx; P/Concentradores.tsx |
| /onus | IN-01–03, RE-13 | GET /api/onus; POST /api/onus/:id/:action | P/Olt.tsx |
| /operacoes | RE-09 | GET /api/operations; GET /api/operations/:id | P/Network.tsx |
| /manutencoes | IN-16 | GET/POST /api/maintenance-notices | P/Extras.tsx |
| /busca | AC-03 | GET /api/search | P/Atendimento.tsx |
| /relatorios-cobranca | FI-14 | GET /api/finance/reports/aging; GET /api/finance/reports/receipts; GET /api/finance/reports/without-invoice; GET /api/finance/reports/to-cancel | P/Cobranca.tsx |
| /avisos-assinante | AD-07–09 | GET/POST /api/notice-channels; GET/POST /api/notice-templates; GET/POST /api/notice-rules | P/AvisosAssinante.tsx |
| /agenda | OS-01–05, OS-10 | GET /api/agenda; GET /api/agenda/free | P/Agenda.tsx; P/Field.tsx |
| /consulta-ip | IN-14–15 | POST /api/legal/ip-lookup; GET /api/legal/ip-lookup/history | P/ConsultaIp.tsx |
| /mapa | IN-09 | GET /api/map/points; PUT /api/contracts/:id/location; PUT /api/pops/:id/location | P/Mapa.tsx |
| /empresas | AD-04 | GET/POST /api/companies; PATCH /api/companies/:id | P/Empresas.tsx |
| /adicionais | CO-05 | GET/POST /api/addons; PATCH /api/addons/:id | P/Adicionais.tsx |
| /anatel | AD-18 | GET /api/anatel/dici; PUT /api/anatel/municipalities; PUT /api/plans/:id/technology | P/Anatel.tsx |
| /integracoes | AD-10–11 | GET/POST /api/api-tokens; GET/POST /api/webhook-endpoints | P/Integracoes.tsx |
| /qualidade | AD-12–17 | GET/POST /api/catalogs; GET/POST /api/sla-policies; GET /api/reports/sla; GET /api/reports/commissions | P/Qualidade.tsx |
| /online | RE-10 | GET /api/network/online; POST /api/network/disconnect | P/Atendimento.tsx |
| /pops | AD-05 | GET/POST /api/pops; PATCH /api/pops/:id | P/Atendimento.tsx |
| /noc | IN-07–08 | GET /api/noc/overview; GET/PUT /api/noc/settings | P/Noc.tsx |
| /ftth | IN-04–06 | GET/POST /api/ftth/boxes; PATCH/DELETE /api/ftth/boxes/:id | P/Field.tsx |
| /ipam | IN-10–13 | GET/POST /api/ipam/pools; GET /api/cgnat/plans; GET /api/cgnat/trace | P/Ipam.tsx |
| /atendimentos | CR-05–08 | GET/POST /api/tickets; GET/PATCH /api/tickets/:id | P/Crm.tsx |
| /prospectos | CR-01–04 | GET/POST /api/leads; GET/PATCH /api/leads/:id | P/Crm.tsx |
| /ordens-servico | OS-01–08 | GET/POST /api/work-orders; GET/PATCH /api/work-orders/:id | P/Field.tsx |
| /estoque | OS-11–14 | GET/POST /api/stock/items; GET/POST /api/stock/items/:id/units | P/Field.tsx |
| /meu-trabalho | OS-01–09 | GET /api/work-orders; POST /api/work-orders/:id/status | P/Field.tsx |
| /avisos | AD-06 | GET /api/notifications; PUT /api/notifications/settings; POST /api/notifications/test | P/Notices.tsx |
| /relatorios-atendimento | CR-09 | GET /api/crm/report | P/Crm.tsx |
| /usuarios | AD-01–02 | GET/POST /api/users; PATCH /api/users/:id; PUT /api/users/:id/pops | P/Users.tsx |
| /importacao | AD-19–20 | POST /api/import/preview; POST /api/import/apply; GET /api/import/batches | P/Import.tsx |
| /auditoria | AD-21 | GET /api/audit; GET/PUT /api/settings/retention | P/Audit.tsx |
| /provedores | AD-03 | GET/POST /api/tenants; PATCH /api/tenants/:id; POST /api/support/enter | P/Tenants.tsx |
| /conta | AC-07–08 | POST /api/me/password; POST /api/me/mfa/setup; POST /api/me/mfa/enable; POST /api/me/mfa/disable | P/Account.tsx |
| Portal do assinante, sem URL própria | PO-01–09 | GET /api/portal/overview; GET/POST /api/portal/tickets; POST /api/portal/trust-release | P/Portal.tsx; P/Crm.tsx; P/Cpe.tsx |
| /aviso/:slug, HTML do Go | FI-12 | GET /aviso/:slug | L/notice.go; L/notice.html.tmpl |

## 6. Catálogo de operações HTTP identificadas

O catálogo abaixo relaciona **método + padrão**, sem afirmar que todas as combinações representem uma funcionalidade completa ou homologada. A coluna de acesso indica a permissão declarada no registro; escopo de provedor, sessão, RLS, módulos, corpo e validações adicionais podem restringir mais. `portal:self` exige vínculo com o próprio assinante; API pública usa escopos do token; agentes usam token/mTLS; webhook de gateway usa validação própria. `:action` e demais parâmetros dependem de valores aceitos nos handlers e não são operações arbitrárias.

As rotas foram confrontadas estaticamente com os registradores de leitura/escrita, identidade, cadastro e agente e com os descritores JSON incorporados ao Go. A referência de arquivo na tabela indica onde localizar o registro/handler; SQL e regras específicos estão nas tabelas da seção 3 e nos arquivos referenciados pelo serviço. Algumas consultas GET estão registradas no módulo de escrita por executarem integração ou lógica especializada. A contagem inclui a página HTML pública e o protocolo do agente; não inclui métricas do listener interno, listadas separadamente em BE-21.

| Método e caminho | Acesso declarado | Registro ou implementação principal |
|---|---|---|
| `POST /agent/v1/attempts/:id/begin` | token e mTLS do agente | G/agent/server.go |
| `POST /agent/v1/attempts/:id/progress` | token e mTLS do agente | G/agent/server.go |
| `POST /agent/v1/attempts/:id/result` | token e mTLS do agente | G/agent/server.go |
| `POST /agent/v1/hello` | token e mTLS do agente | G/agent/server.go |
| `POST /agent/v1/observations` | token e mTLS do agente | G/agent/server.go |
| `POST /agent/v1/olt-report` | token e mTLS do agente | G/agent/server.go |
| `POST /agent/v1/poll` | token e mTLS do agente | G/agent/server.go |
| `POST /agent/v1/sessions-report` | token e mTLS do agente | G/agent/server.go |
| `POST /agent/v1/sync-done` | token e mTLS do agente | G/agent/server.go |
| `POST /agent/v1/usage-report` | token e mTLS do agente | G/agent/server.go |
| `POST /api/acceptances/:id/cancel` | contracts:write | E/service.go + E/acessos.go |
| `GET /api/acceptances/:id/evidence` | contracts:read | L/grupos.go; L/grupos_generated.go |
| `GET /api/acs/status` | network:read | L/auxiliares.go |
| `GET /api/addons` | plans:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/addons` | plans:write | E/service.go + E/comercial.go |
| `PATCH /api/addons/:id` | plans:write | E/service.go + E/comercial.go |
| `GET /api/agenda` | os:read | L/dinamicas.go; L/dinamicas.json |
| `GET /api/agenda/free` | os:read | L/dinamicas.go; L/dinamicas.json |
| `GET /api/agents` | network:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/agents` | network:write | E/service.go + E/rede.go |
| `PATCH /api/agents/:id` | network:write | E/service.go + E/rede.go |
| `GET /api/anatel/dici` | settings:manage | E/service.go |
| `GET /api/anatel/municipalities` | settings:manage | L/consultas.go; L/consultas_generated.go |
| `PUT /api/anatel/municipalities` | settings:manage | E/service.go |
| `GET /api/api-tokens` | settings:manage | L/consultas.go; L/consultas_generated.go |
| `POST /api/api-tokens` | settings:manage | E/service.go + E/acessos.go |
| `DELETE /api/api-tokens/:id` | settings:manage | E/service.go + E/acessos.go |
| `GET /api/audit` | audit:read | L/grupos.go; L/grupos_generated.go |
| `POST /api/auth/login` | público | I/service.go |
| `POST /api/auth/logout` | sessão | I/service.go |
| `GET /api/catalogs` | subscribers:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/catalogs` | settings:manage | E/service.go + E/config.go |
| `PATCH /api/catalogs/:id` | settings:manage | E/service.go + E/config.go |
| `GET /api/cgnat/plans` | network:read | L/dinamicas.go; L/dinamicas.json |
| `POST /api/cgnat/plans` | network:write | E/service.go + E/infraestrutura.go |
| `GET /api/cgnat/plans/:id/lookup` | network:read | L/dinamicas.go; L/dinamicas.json |
| `GET /api/cgnat/plans/:id/map` | network:read | L/dinamicas.go; L/dinamicas.json |
| `POST /api/cgnat/plans/:id/retire` | network:write | E/service.go + E/infraestrutura.go |
| `GET /api/cgnat/plans/:id/script` | network:write | E/service.go + E/ipam.go |
| `POST /api/cgnat/plans/check` | network:read | E/service.go + E/infraestrutura.go |
| `GET /api/cgnat/trace` | network:read | E/service.go + E/ipam.go |
| `GET /api/commission-rules` | finance:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/commission-rules` | settings:manage | E/service.go + E/documentos.go |
| `GET /api/companies` | contracts:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/companies` | settings:manage | E/service.go |
| `PATCH /api/companies/:id` | settings:manage | E/service.go |
| `GET /api/contracts` | contracts:read | L/service.go |
| `POST /api/contracts` | contracts:write | E/service.go |
| `GET /api/contracts/:id` | contracts:read | G/modules/cadastro/routes.go |
| `PATCH /api/contracts/:id` | contracts:write | E/service.go + E/contratos.go |
| `GET /api/contracts/:id/acceptances` | contracts:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/contracts/:id/acceptances` | contracts:write | E/service.go + E/acessos.go |
| `GET /api/contracts/:id/addons` | contracts:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/contracts/:id/addons` | contracts:write | E/service.go + E/comercial.go |
| `DELETE /api/contracts/:id/addons/:addonId` | contracts:write | E/service.go + E/documentos.go |
| `POST /api/contracts/:id/agreement` | finance:write | E/service.go + E/financeiro.go |
| `GET /api/contracts/:id/amendments` | contracts:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/contracts/:id/amendments` | contracts:write | E/service.go + E/comercial.go |
| `GET /api/contracts/:id/availability` | network:read | L/dinamicas.go; L/dinamicas.json |
| `PUT /api/contracts/:id/company` | contracts:write | E/service.go |
| `GET /api/contracts/:id/cpe` | network:read | E/service.go |
| `GET /api/contracts/:id/cpe/candidates` | network:operate | E/service.go |
| `DELETE /api/contracts/:id/cpe/link` | network:operate | E/service.go |
| `POST /api/contracts/:id/cpe/link` | network:operate | E/service.go + E/cpe.go |
| `POST /api/contracts/:id/cpe/reboot` | network:operate | E/service.go |
| `POST /api/contracts/:id/cpe/refresh` | network:operate | E/service.go |
| `POST /api/contracts/:id/cpe/wifi` | network:operate | E/service.go + E/cpe.go |
| `PUT /api/contracts/:id/credit-restriction` | finance:write | E/service.go |
| `PUT /api/contracts/:id/custom` | contracts:write | E/custom.go |
| `GET /api/contracts/:id/diagnosis` | network:read | E/service.go + E/noc.go |
| `GET /api/contracts/:id/discounts` | contracts:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/contracts/:id/discounts` | finance:write | E/service.go + E/comercial.go |
| `GET /api/contracts/:id/equipment` | stock:read | L/grupos.go; L/grupos_generated.go |
| `GET /api/contracts/:id/finance` | finance:read | L/grupos.go; L/grupos_generated.go |
| `GET /api/contracts/:id/ftth` | network:read | L/consultas.go; L/consultas_generated.go |
| `GET /api/contracts/:id/install-address` | contracts:read | L/consultas.go; L/consultas_generated.go |
| `PUT /api/contracts/:id/install-address` | contracts:write | E/service.go + E/config.go |
| `GET /api/contracts/:id/ips` | network:read | L/consultas.go; L/consultas_generated.go |
| `GET /api/contracts/:id/ipv6` | network:read | L/consultas.go; L/consultas_generated.go |
| `PUT /api/contracts/:id/location` | contracts:write | E/service.go + E/infraestrutura.go |
| `PUT /api/contracts/:id/loyalty` | contracts:write | E/service.go + E/comercial.go |
| `GET /api/contracts/:id/onu` | network:read | E/service.go + E/olt.go |
| `POST /api/contracts/:id/onu` | network:operate | E/service.go + E/olt.go |
| `PUT /api/contracts/:id/pop` | contracts:write | E/service.go + E/config.go |
| `GET /api/contracts/:id/radius-log` | network:read | L/grupos.go; L/grupos_generated.go |
| `PUT /api/contracts/:id/referral` | contracts:write | E/service.go + E/comercial.go |
| `GET /api/contracts/:id/scheduled-changes` | contracts:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/contracts/:id/scheduled-changes` | contracts:write | E/service.go + E/comercial.go |
| `GET /api/contracts/:id/service` | network:read | E/service.go + E/rede.go |
| `POST /api/contracts/:id/service` | network:operate | E/service.go + E/rede.go |
| `PUT /api/contracts/:id/service-area` | contracts:write | E/service.go |
| `GET /api/contracts/:id/sessions` | network:read | E/service.go |
| `GET /api/contracts/:id/states` | contracts:read | L/grupos.go; L/grupos_generated.go |
| `PUT /api/contracts/:id/tags` | contracts:write | E/service.go |
| `GET /api/contracts/:id/termination-quote` | contracts:read | L/dinamicas.go; L/dinamicas.json |
| `GET /api/contracts/:id/trust-release` | contracts:read | L/auxiliares.go |
| `POST /api/contracts/:id/trust-release` | trust:grant | E/service.go + E/financeiro.go |
| `GET /api/contracts/:id/usage` | network:read | L/consultas.go; L/consultas_generated.go |
| `GET /api/contracts/:id/usage-series` | network:read | L/auxiliares.go |
| `GET /api/crm/report` | crm:read | L/dinamicas.go; L/dinamicas.json |
| `GET /api/custom-fields` | subscribers:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/custom-fields` | settings:manage | E/service.go + E/config.go |
| `PATCH /api/custom-fields/:id` | settings:manage | E/service.go + E/config.go |
| `GET /api/dashboard` | subscribers:read | L/service.go |
| `GET /api/dashboard/panels` | network:read | L/dinamicas.go; L/dinamicas.json |
| `POST /api/demo-gateway/pay` | finance:write | E/service.go + E/financeiro.go |
| `GET /api/devices` | network:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/devices` | network:write | E/service.go + E/rede.go |
| `PATCH /api/devices/:id` | network:write | E/service.go + E/rede.go |
| `POST /api/devices/:id/convert-to-integrated` | network:write | E/service.go + E/radius.go |
| `POST /api/devices/:id/reapply` | network:write | E/service.go + E/rede.go |
| `DELETE /api/discounts/:id` | finance:write | E/service.go + E/comercial.go |
| `DELETE /api/documents/:id` | subscribers:write | E/service.go + E/documentos.go |
| `GET /api/documents/:id/download` | subscribers:write | E/service.go |
| `GET /api/finance/export` | finance:read | E/service.go |
| `POST /api/finance/generate` | finance:write | E/service.go + E/financeiro.go |
| `GET /api/finance/monthly` | finance:read | L/grupos.go; L/grupos_generated.go |
| `POST /api/finance/reconcile` | finance:write | E/service.go + E/financeiro.go |
| `GET /api/finance/reconciliation` | finance:read | L/grupos.go; L/grupos_generated.go |
| `GET /api/finance/reports/aging` | finance:read | E/service.go + E/relatorios.go |
| `GET /api/finance/reports/receipts` | finance:read | E/service.go + E/relatorios.go |
| `GET /api/finance/reports/to-cancel` | finance:read | E/service.go + E/relatorios.go |
| `GET /api/finance/reports/without-invoice` | finance:read | E/service.go + E/relatorios.go |
| `POST /api/finance/run-auto-suspend` | settings:manage | E/service.go + E/financeiro.go |
| `GET /api/finance/settings` | finance:read | L/auxiliares.go |
| `PUT /api/finance/settings` | settings:manage | E/service.go + E/ordens.go |
| `GET /api/finance/summary` | finance:read | L/consultas.go; L/consultas_generated.go |
| `GET /api/ftth/boxes` | network:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/ftth/boxes` | network:write | E/service.go + E/infraestrutura.go |
| `DELETE /api/ftth/boxes/:id` | network:write | E/service.go + E/infraestrutura.go |
| `GET /api/ftth/boxes/:id` | network:read | L/grupos.go; L/grupos_generated.go |
| `PATCH /api/ftth/boxes/:id` | network:write | E/service.go + E/infraestrutura.go |
| `POST /api/ftth/boxes/:id/drops` | network:write | E/service.go + E/infraestrutura.go |
| `DELETE /api/ftth/drops/:id` | network:write | E/service.go + E/infraestrutura.go |
| `GET /api/health` | público | apps/api-go/cmd/api/main.go |
| `POST /api/import/apply` | import:run | E/service.go + E/importacao.go |
| `GET /api/import/batches` | import:run | L/consultas.go; L/consultas_generated.go |
| `GET /api/import/batches/:id` | import:run | L/consultas.go; L/consultas_generated.go |
| `POST /api/import/batches/:id/provision` | import:run | E/service.go + E/operacoes.go |
| `POST /api/import/preview` | import:run | E/service.go + E/importacao.go |
| `GET /api/install-kits` | stock:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/install-kits` | stock:write | E/service.go + E/documentos.go |
| `PATCH /api/install-kits/:id` | stock:write | E/service.go + E/config.go |
| `GET /api/integrations/catalog` | settings:manage | L/auxiliares.go |
| `GET /api/invoices` | finance:read | L/dinamicas.go; L/dinamicas.json |
| `POST /api/invoices` | finance:write | E/service.go + E/financeiro.go |
| `GET /api/invoices/:id` | finance:read | L/grupos.go; L/grupos_generated.go |
| `POST /api/invoices/:id/cancel` | finance:write | E/service.go + E/financeiro.go |
| `GET /api/invoices/:id/due` | finance:read | L/auxiliares.go |
| `POST /api/invoices/:id/manual-payment` | finance:write | E/service.go + E/financeiro.go |
| `POST /api/invoices/:id/payments/:paymentId/reverse` | finance:write | E/service.go + E/financeiro.go |
| `POST /api/invoices/:id/resolve` | finance:write | E/service.go + E/financeiro.go |
| `DELETE /api/ipam/allocations/:id` | network:write | E/service.go + E/infraestrutura.go |
| `DELETE /api/ipam/delegations/:id` | network:write | E/service.go + E/ordens.go |
| `GET /api/ipam/pools` | network:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/ipam/pools` | network:write | E/service.go + E/infraestrutura.go |
| `DELETE /api/ipam/pools/:id` | network:write | E/service.go + E/infraestrutura.go |
| `PATCH /api/ipam/pools/:id` | network:write | E/service.go + E/infraestrutura.go |
| `GET /api/ipam/pools/:id/allocations` | network:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/ipam/pools/:id/allocations` | network:write | E/service.go + E/ipam.go |
| `GET /api/ipam/pools/:id/delegations` | network:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/ipam/pools/:id/delegations` | network:write | E/service.go + E/ipam.go |
| `GET /api/leads` | crm:read | L/grupos.go; L/grupos_generated.go |
| `POST /api/leads` | crm:write | E/service.go + E/crm.go |
| `GET /api/leads/:id` | crm:read | L/grupos.go; L/grupos_generated.go |
| `PATCH /api/leads/:id` | crm:write | E/service.go + E/crm.go |
| `POST /api/leads/:id/convert` | crm:write | E/service.go + E/crm.go |
| `POST /api/leads/:id/notes` | crm:write | E/service.go + E/crm.go |
| `POST /api/leads/:id/stage` | crm:write | E/service.go + E/crm.go |
| `GET /api/leads/summary` | crm:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/legal/ip-lookup` | legal:query | E/service.go + E/ipam.go |
| `GET /api/legal/ip-lookup/history` | legal:query | L/consultas.go; L/consultas_generated.go |
| `GET /api/maintenance-notices` | network:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/maintenance-notices` | network:write | E/service.go |
| `POST /api/maintenance-notices/:id/cancel` | network:write | E/service.go |
| `POST /api/maintenance-notices/:id/notify` | network:write | E/service.go + E/rotinas.go |
| `GET /api/maintenance-notices/channels` | network:write | L/consultas.go; L/consultas_generated.go |
| `GET /api/map/coverage` | contracts:read | L/grupos.go; L/grupos_generated.go |
| `GET /api/map/points` | contracts:read | L/dinamicas.go; L/dinamicas.json |
| `GET /api/me` | sessão | L/service.go |
| `POST /api/me/mfa/disable` | sessão | I/service.go |
| `POST /api/me/mfa/enable` | sessão | I/service.go |
| `POST /api/me/mfa/setup` | sessão | I/service.go |
| `POST /api/me/password` | sessão | I/service.go |
| `POST /api/network/disconnect` | network:operate | E/service.go + E/operacoes.go |
| `GET /api/network/drift` | network:read | L/consultas.go; L/consultas_generated.go |
| `GET /api/network/health` | network:read | E/service.go + E/rede.go |
| `GET /api/network/online` | network:read | E/service.go |
| `GET /api/noc/overview` | network:read | E/service.go + E/noc.go |
| `GET /api/noc/settings` | network:read | L/auxiliares.go |
| `PUT /api/noc/settings` | network:write | E/service.go + E/config.go |
| `PATCH /api/notes/:id` | subscribers:write | E/service.go |
| `GET /api/notice-channels` | settings:manage | L/consultas.go; L/consultas_generated.go |
| `POST /api/notice-channels` | settings:manage | E/service.go + E/integracoes.go |
| `DELETE /api/notice-channels/:id` | settings:manage | E/service.go + E/avisos.go |
| `PATCH /api/notice-channels/:id` | settings:manage | E/service.go + E/avisos.go |
| `POST /api/notice-channels/:id/test` | settings:manage | E/service.go + E/integracoes.go |
| `GET /api/notice-log` | settings:manage | L/consultas.go; L/consultas_generated.go |
| `GET /api/notice-page` | settings:manage | L/grupos.go; L/grupos_generated.go |
| `PUT /api/notice-page` | settings:manage | E/service.go + E/config.go |
| `GET /api/notice-rules` | settings:manage | L/consultas.go; L/consultas_generated.go |
| `POST /api/notice-rules` | settings:manage | E/service.go + E/avisos.go |
| `DELETE /api/notice-rules/:id` | settings:manage | E/service.go + E/avisos.go |
| `PATCH /api/notice-rules/:id` | settings:manage | E/service.go + E/avisos.go |
| `POST /api/notice-rules/run` | settings:manage | E/service.go + E/rotinas.go |
| `GET /api/notice-templates` | settings:manage | L/grupos.go; L/grupos_generated.go |
| `POST /api/notice-templates` | settings:manage | E/service.go + E/avisos.go |
| `DELETE /api/notice-templates/:id` | settings:manage | E/service.go + E/avisos.go |
| `GET /api/notifications` | settings:manage | L/grupos.go; L/grupos_generated.go |
| `POST /api/notifications/deliver` | settings:manage | E/service.go + E/acessos.go |
| `PUT /api/notifications/settings` | settings:manage | E/service.go + E/integracoes.go |
| `POST /api/notifications/test` | settings:manage | E/service.go + E/integracoes.go |
| `GET /api/olt/discoveries` | network:read | L/consultas.go; L/consultas_generated.go |
| `GET /api/onus` | network:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/onus/:id/:action` | network:operate | E/service.go + E/olt.go |
| `GET /api/operations` | network:read | E/service.go + E/rede.go |
| `GET /api/operations/:id` | network:read | E/service.go + E/rede.go |
| `GET /api/plans` | plans:read | L/service.go |
| `POST /api/plans` | plans:write | E/service.go |
| `PATCH /api/plans/:id` | plans:write | E/service.go |
| `PUT /api/plans/:id/dunning` | plans:write | E/service.go |
| `PUT /api/plans/:id/loyalty` | plans:write | E/service.go + E/comercial.go |
| `PUT /api/plans/:id/network` | network:write | E/service.go + E/rede.go |
| `POST /api/plans/:id/reapply` | network:operate | E/service.go + E/rede.go |
| `PUT /api/plans/:id/technology` | plans:write | E/service.go |
| `GET /api/plans/:id/versions` | plans:read | L/service.go |
| `POST /api/plans/:id/versions` | plans:write | E/service.go |
| `GET /api/pops` | contracts:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/pops` | network:write | E/service.go + E/config.go |
| `PATCH /api/pops/:id` | network:write | E/service.go + E/config.go |
| `PUT /api/pops/:id/location` | network:write | E/service.go + E/infraestrutura.go |
| `GET /api/portal/acceptances` | portal:self | L/service.go |
| `POST /api/portal/acceptances/:id/accept` | portal:self | E/service.go + E/acessos.go |
| `GET /api/portal/cpe` | portal:self | E/service.go |
| `POST /api/portal/cpe/:contractId/wifi` | portal:self | E/service.go + E/cpe.go |
| `GET /api/portal/overview` | portal:self | L/service.go |
| `GET /api/portal/surveys` | portal:self | L/service.go |
| `POST /api/portal/surveys/:id` | portal:self | E/service.go + E/avisos.go |
| `GET /api/portal/tickets` | portal:self | L/service.go |
| `POST /api/portal/tickets` | portal:self | E/service.go + E/crm.go |
| `GET /api/portal/tickets/:id` | portal:self | L/service.go |
| `POST /api/portal/tickets/:id/messages` | portal:self | E/service.go + E/crm.go |
| `POST /api/portal/trust-release` | portal:self | E/service.go + E/financeiro.go |
| `GET /api/portal/usage-series` | portal:self | L/service.go |
| `GET /api/radius/allowed-sources` | network:read | L/grupos.go; L/grupos_generated.go |
| `POST /api/radius/devices` | network:write | E/service.go + E/radius.go |
| `PATCH /api/radius/devices/:id` | network:write | E/service.go + E/radius.go |
| `POST /api/radius/devices/:id/secret` | network:write | E/service.go + E/radius.go |
| `GET /api/radius/devices/:id/setup` | network:read | L/dinamicas.go; L/dinamicas.json |
| `POST /api/radius/devices/:id/tunnel` | network:write | E/service.go + E/radius.go |
| `GET /api/radius/status` | network:read | L/dinamicas.go; L/dinamicas.json |
| `GET /api/reports/commissions` | finance:read | E/service.go |
| `GET /api/reports/referrals` | finance:read | L/consultas.go; L/consultas_generated.go |
| `GET /api/reports/sla` | subscribers:read | L/dinamicas.go; L/dinamicas.json |
| `POST /api/resources/:id/:action` | network:operate | E/service.go + E/rede.go |
| `PATCH /api/resources/:id/mac` | network:operate | E/service.go + E/rede.go |
| `PATCH /api/resources/:id/secret` | network:operate | E/service.go + E/rede.go |
| `DELETE /api/scheduled-changes/:id` | contracts:write | E/service.go + E/comercial.go |
| `GET /api/search` | subscribers:read | L/dinamicas.go; L/dinamicas.json |
| `GET /api/settings/retention` | settings:manage | L/grupos.go; L/grupos_generated.go |
| `PUT /api/settings/retention` | settings:manage | E/service.go + E/config.go |
| `GET /api/sla-policies` | subscribers:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/sla-policies` | settings:manage | E/service.go + E/config.go |
| `DELETE /api/sla-policies/:id` | settings:manage | E/service.go + E/config.go |
| `PATCH /api/sla-policies/:id` | settings:manage | E/service.go + E/config.go |
| `GET /api/staff` | os:read | L/consultas.go; L/consultas_generated.go |
| `GET /api/stock/items` | stock:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/stock/items` | stock:write | E/service.go + E/estoque.go |
| `PATCH /api/stock/items/:id` | stock:write | E/service.go + E/estoque.go |
| `GET /api/stock/items/:id/movements` | stock:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/stock/items/:id/movements` | stock:write | E/service.go + E/estoque.go |
| `GET /api/stock/items/:id/units` | stock:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/stock/items/:id/units` | stock:write | E/service.go + E/estoque.go |
| `GET /api/stock/units` | stock:read | L/consultas.go; L/consultas_generated.go |
| `GET /api/stock/units/:id/events` | stock:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/stock/units/:id/status` | stock:write | E/service.go + E/estoque.go |
| `POST /api/stock/units/:id/transfer` | stock:write | E/service.go + E/estoque.go |
| `GET /api/subscribers` | subscribers:read | G/modules/cadastro/routes.go |
| `POST /api/subscribers` | subscribers:write | E/service.go |
| `GET /api/subscribers/:id` | subscribers:read | G/modules/cadastro/routes.go |
| `PATCH /api/subscribers/:id` | subscribers:write | E/service.go |
| `POST /api/subscribers/:id/anonymize` | settings:manage | E/service.go + E/documentos.go |
| `GET /api/subscribers/:id/contacts` | subscribers:read | L/consultas.go; L/consultas_generated.go |
| `PUT /api/subscribers/:id/contacts` | subscribers:write | E/service.go + E/config.go |
| `PUT /api/subscribers/:id/custom` | subscribers:write | E/custom.go |
| `GET /api/subscribers/:id/documents` | subscribers:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/subscribers/:id/documents` | subscribers:write | E/service.go + E/documentos.go |
| `GET /api/subscribers/:id/lgpd-export` | settings:manage | E/service.go |
| `GET /api/subscribers/:id/notes` | subscribers:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/subscribers/:id/notes` | subscribers:write | E/service.go |
| `GET /api/subscribers/:id/portal-access` | subscribers:read | L/service.go |
| `POST /api/subscribers/:id/portal-access` | subscribers:write | E/service.go + E/acessos.go |
| `GET /api/subscribers/:id/timeline` | subscribers:read | L/dinamicas.go; L/dinamicas.json |
| `POST /api/support/enter` | tenants:manage | I/service.go |
| `POST /api/support/exit` | sessão | I/service.go |
| `GET /api/surveys` | os:read | L/grupos.go; L/grupos_generated.go |
| `GET /api/tags` | contracts:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/tags` | contracts:write | E/service.go |
| `DELETE /api/tags/:id` | contracts:write | E/service.go |
| `GET /api/tenants` | tenants:manage | L/grupos.go; L/grupos_generated.go |
| `POST /api/tenants` | tenants:manage | I/service.go |
| `PATCH /api/tenants/:id` | tenants:manage | I/service.go |
| `GET /api/tickets` | crm:read | L/grupos.go; L/grupos_generated.go |
| `POST /api/tickets` | crm:write | E/service.go + E/crm.go |
| `GET /api/tickets/:id` | crm:read | L/grupos.go; L/grupos_generated.go |
| `PATCH /api/tickets/:id` | crm:write | E/service.go + E/crm.go |
| `POST /api/tickets/:id/messages` | crm:write | E/service.go + E/crm.go |
| `POST /api/tickets/:id/status` | crm:write | E/service.go + E/crm.go |
| `GET /api/today` | subscribers:read | L/dinamicas.go; L/dinamicas.json |
| `GET /api/users` | users:manage | L/consultas.go; L/consultas_generated.go |
| `POST /api/users` | users:manage | I/service.go |
| `PATCH /api/users/:id` | users:manage | I/service.go |
| `GET /api/users/:id/pops` | users:manage | L/consultas.go; L/consultas_generated.go |
| `PUT /api/users/:id/pops` | users:manage | E/service.go + E/config.go |
| `GET /api/webhook-deliveries` | settings:manage | L/consultas.go; L/consultas_generated.go |
| `POST /api/webhook-deliveries/:id/retry` | settings:manage | E/service.go + E/acessos.go |
| `GET /api/webhook-endpoints` | settings:manage | L/consultas.go; L/consultas_generated.go |
| `POST /api/webhook-endpoints` | settings:manage | E/service.go + E/integracoes.go |
| `DELETE /api/webhook-endpoints/:id` | settings:manage | E/service.go + E/acessos.go |
| `PATCH /api/webhook-endpoints/:id` | settings:manage | E/service.go + E/integracoes.go |
| `POST /api/webhook-endpoints/:id/rotate-secret` | settings:manage | E/service.go + E/acessos.go |
| `POST /api/webhook-endpoints/:id/test` | settings:manage | E/service.go + E/integracoes.go |
| `POST /api/webhooks/gateway/:gateway` | público; assinatura do gateway | E/service.go + E/gateway.go |
| `GET /api/work-orders` | os:read | L/grupos.go; L/grupos_generated.go |
| `POST /api/work-orders` | os:write | E/service.go + E/ordens.go |
| `GET /api/work-orders/:id` | os:read | L/grupos.go; L/grupos_generated.go |
| `PATCH /api/work-orders/:id` | os:write | E/service.go + E/ordens.go |
| `POST /api/work-orders/:id/checklist` | os:write | E/service.go + E/estoque.go |
| `POST /api/work-orders/:id/checklist/:itemId` | os:write | E/service.go + E/estoque.go |
| `GET /api/work-orders/:id/helpers` | os:read | L/consultas.go; L/consultas_generated.go |
| `POST /api/work-orders/:id/helpers` | os:write | E/service.go + E/estoque.go |
| `DELETE /api/work-orders/:id/helpers/:userId` | os:write | E/service.go + E/estoque.go |
| `POST /api/work-orders/:id/kit` | os:write | E/service.go + E/estoque.go |
| `POST /api/work-orders/:id/materials` | os:write | E/service.go + E/estoque.go |
| `POST /api/work-orders/:id/notes` | os:write | E/service.go + E/estoque.go |
| `POST /api/work-orders/:id/status` | os:write | E/service.go + E/operacoes.go |
| `POST /api/work-orders/:id/units` | os:write | E/service.go + E/operacoes.go |
| `GET /aviso/:slug` | público | L/service.go |
| `GET /public/v1` | token e escopo API pública | E/public.go; E/service.go |
| `GET /public/v1/contracts` | token e escopo API pública | E/public.go; E/service.go |
| `GET /public/v1/invoices` | token e escopo API pública | E/public.go; E/service.go |
| `GET /public/v1/subscribers` | token e escopo API pública | E/public.go; E/service.go |
| `GET /public/v1/subscribers/:id` | token e escopo API pública | E/public.go; E/service.go |
| `POST /public/v1/tickets` | token e escopo API pública | E/public.go; E/service.go |
| `POST /public/v1/work-orders` | token e escopo API pública | E/public.go; E/service.go |
| `GET /public/v1/work-orders/:id` | token e escopo API pública | E/public.go; E/service.go |

## 7. Recursos parciais, demonstrativos e pontos de atenção

- **Pagamento:** gateway `demo` cria códigos não pagáveis e simula eventos. O modo `none` não oferece cobrança online. Não foi localizado gateway bancário real; emissão, webhook, baixa, conciliação e estorno com instituição financeira não foram homologados por esta análise (FI-15–17, PO-09).
- **Rede real:** agentes Python, FreeRADIUS, VPN, NAS, OLT Huawei e ACS têm código de integração, mas a presença do código não comprova instalação, conectividade, compatibilidade por fabricante ou execução bem-sucedida em equipamento físico. O driver demo não é evidência de hardware real (RE-04–08, RE-12–13, IN-01–03, BE-10–15).
- **IPv6 e identificação:** reserva de prefixo não implica entrega automática ao equipamento; a tela de rastreio CGNAT não apresenta todos os titulares históricos que o backend retorna. A consulta legal IPv6 tem limitação histórica identificada (IN-11, IN-13, IN-15).
- **Dados e operação:** migração CSV precisa de mapeamento e conferência; senhas de acesso importadas podem precisar de tratamento. O relatório ANATEL não prova transmissão nem conformidade fiscal/regulatória do arquivo. Comissão é uma apuração por regras atuais, sem folha/pagamento (AD-17–20).
- **Automação e proteção:** habilitar geração, suspensão, avisos, retenção e demais rotinas requer configuração de jobs. O código usa `NEXO_GO_JOBS=1` e flags `NEXO_GO_JOB_<nome>`; o relatório não comprova que estejam ativas. Segredos, HTTPS, cópia externa e restauração exigem configuração e comprovação no ambiente escolhido (BE-16–22).
- **Lacunas de interface:** a administração de senha de terceiro, indicação, endereço de instalação, fatura avulsa e alguns campos de POP, empresa, dispositivo, pool e qualidade existem no servidor sem controles equivalentes localizados; a lista específica está em BE-03–09, BE-24–27. Dados do portal são somente leitura, exceto as ações expressamente descritas.
- **Cobertura de produtos:** cadastro de adicionais não provisiona automaticamente TV/telefonia; página pública de cobrança não instala redirecionamento no NAS; mapa de caixas não substitui projeto físico completo; agendamento e mapa não oferecem operação offline (CO-05, FI-12, IN-06, OS-09–10).
- **Diferenças entre texto e código:** a descrição antiga da geração de faturas na interface não reflete o SQL que já considera proporcional, descontos e adicionais quando aplicáveis. No painel de ONU há mensagem que afirma não haver remoção automática ao encerrar, enquanto a opção do NOC e o Go permitem solicitá-la quando habilitada. Essas mensagens não devem ser tomadas como regra de negócio (FI-02, IN-07, CO-09).
- **Escala:** diretório de células está parcialmente implementado e o escopo de banco examinado restringe a operação à célula `c1`; não foi comprovada distribuição entre múltiplas células (BE-23).

## 8. Resumo quantitativo e limites de leitura

Cada linha da seção 3 conta **uma unidade funcional**, conforme critério da seção 1.2; linhas que descrevem limitações de uma capacidade coexistem com linhas que registram operações individuais. Por isso, os números não medem porcentagem pronta, cobertura de telas nem grau de prontidão de produção. Zero em “Somente interface” significa que não foi confirmada uma unidade inequívoca desse tipo nesta análise, não prova matemática de ausência de defeitos em qualquer botão.

| Módulo | Implementada | Parcial | Demonstrativa | Somente backend | Somente interface | Não confirmado | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| AC — acesso e navegação | 7 | 0 | 1 | 0 | 0 | 0 | 8 |
| AS — assinantes e privacidade | 10 | 0 | 0 | 0 | 0 | 0 | 10 |
| CO — planos e contratos | 23 | 0 | 0 | 0 | 0 | 0 | 23 |
| CR — CRM | 9 | 0 | 0 | 0 | 0 | 0 | 9 |
| OS — campo e estoque | 14 | 0 | 0 | 0 | 0 | 0 | 14 |
| FI — financeiro | 14 | 0 | 2 | 0 | 0 | 1 | 17 |
| RE — rede e acesso | 13 | 0 | 1 | 0 | 0 | 0 | 14 |
| IN — infraestrutura e consulta legal | 12 | 5 | 0 | 0 | 0 | 0 | 17 |
| AD — administração e integrações | 17 | 4 | 0 | 0 | 0 | 0 | 21 |
| PO — portal | 8 | 1 | 0 | 0 | 0 | 0 | 9 |
| BE — APIs e serviços internos | 0 | 1 | 0 | 26 | 0 | 0 | 27 |
| **Total** | **127** | **11** | **4** | **26** | **0** | **1** | **169** |

Outras medidas independentes: **42 padrões de URL do React**, mais o portal escolhido por perfil e a página HTML pública; **346 combinações HTTP** no catálogo da seção 6, incluindo dez rotas de agente e oito da API pública; três rotas adicionais do listener interno de observabilidade. Múltiplos métodos no mesmo caminho contam separadamente. Os 57 arquivos numerados de migration analisados são estruturas e evolução do banco, não funcionalidades contadas individualmente.

O levantamento é estático. Não foi verificado o estado atual do banco, dos contêineres, das credenciais ou dos equipamentos e não foram executados testes, builds, integrações ou medições. Falta de evidência de uma funcionalidade não prova que ela inexista em sistemas externos ou em versões fora desta árvore de código.
