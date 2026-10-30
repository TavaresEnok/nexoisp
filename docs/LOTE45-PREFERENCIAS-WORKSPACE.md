# Lote 45 — Preferências pessoais do workspace e painel (C34)

Implementação do recorte interno C34 de preferências pessoais locais no navegador para a equipe do NexoISP: favoritos de navegação na barra lateral e seleção pessoal dos três blocos opcionais na Visão geral do painel operacional (`/`), sem novas tabelas, rotas, dependências de pacotes, chamadas a APIs externas ou alteração de regras comerciais e de permissionamento do backend Go.

## Escopo e arquitetura

1. **Favoritos de navegação lateral (`apps/web/components/workspace-navigation.tsx`, `apps/web/components/navigation-favorites.tsx`, `apps/web/lib/navigation-favorites.ts`)**:
   - Até 12 favoritos pessoais de equipe mantidos por usuário e escopo de sessão.
   - Restrito a páginas operacionais conectadas ao ERP (`connected: true`) e com acesso autorizado na sessão corrente (`canAccess: true`).
   - Rótulos e destinos derivados dinamicamente do catálogo estático a cada renderização; dedup e preservação da ordem de inserção.
   - Invalidação estrita: URLs externas (`http:`, `https:`), referências de protocolo (`//`), pseudoprotocolos (`javascript:`), rotas com parâmetros de busca (`?`), fragmentos (`#`), IDs dinâmicos de registro (UUID e sequenciais), páginas planejadas (`planned`) e rotas restritas de sistema (`/login`, `/sair`, `/portal`, `/provedores`, `/conta`).
   - Revalidação sincronizada: quando permissões ou módulos mudam na sessão, rotas não autorizadas são filtradas antes da renderização sem vazar preferências ou permitir abertura indevida.
   - Controles de acessibilidade: botão de adicionar/remover com `aria-pressed`, rótulo individualizado por página, sem aninhamento inválido de botão dentro de links (`<a>`), e suporte completo a colapso e navegação móvel.

2. **Seleção pessoal de blocos opcionais na Visão geral (`apps/web/features/operations/overview.tsx`, `apps/web/features/operations/overview-preferences.tsx`, `apps/web/features/operations/overview-preferences.ts`)**:
   - Controle acessível "Personalizar painel" na área Visão geral (`area === "overview"`).
   - Alternância independente de visibilidade para os 3 blocos opcionais já existentes:
     - `revenue`: Receita recebida / mensal (`finance:read`).
     - `contract-trends`: Ativações e encerramentos dos últimos doze meses (`network:read` e painéis disponíveis).
     - `agenda`: Visitas de hoje (`os:read` e módulo de campo habilitado).
   - Exibição habilitada por padrão quando o usuário possui autorização para o recurso.
   - Ação "Restaurar padrão" restabelece a configuração inicial para o escopo corrente.
   - Indicadores principais (métricas de cabeçalho), prioridades imediatas, alertas e pulso de rede permanecem sempre visíveis, sem alteração de cálculos, paginação, requisições HTTP, cache ou dados de backend.
   - Sem reordenação, drag-and-drop, customização arbitrária de cores ou logotipos.

3. **Armazenamento e isolamento por escopo (`sessionScope(me)`)**:
   - Chaves isoladas por versão e namespace:
     - Favoritos: `nexo:v1:favorites:<sessionScope>`
     - Widgets: `nexoisp:overview-widgets:v1:<sessionScope>`
   - `sessionScope(me)` consolida `userId:tenantId:role:support:permsSorted:modulesSorted`.
   - Mudança de usuário, logout, troca de tenant ou saída de suporte atualiza o estado sincronamente, sem exibir preferências do escopo anterior nem por um único ciclo de renderização.
   - Sem sessão ativa, com MFA pendente, assinante de portal ou operador SaaS sem tenant selecionado, os controles de equipe não são ativados.
   - Armazenamento em `localStorage` com limite defensivo de 8 KiB antes da leitura/escrita.
   - Fallback gracioso: na indisponibilidade do storage ou falha de cota, as preferências operam em memória na sessão, informando honestamente a ausência de persistência local.
   - Nenhum token, senha, documento pessoal, nome, parâmetro de busca ou dado sensível é persistido nas preferências.

## Verificação e comprovação

- Frentes de implementação presentes na integração; revisão independente e recibos de execução do marco permanecem sob responsabilidade do controlador:
  - T1: correção da fixture de locais em `TestNetworkSitesExportPG` no backend Go.
  - T2: hook, controles e testes de unidade de seleção de widgets (`apps/web/tests/overview-preferences.test.ts`).
  - T3: hook, componentes e testes de unidade de favoritos de navegação (`apps/web/tests/navigation-favorites.test.ts`).
  - T5: alinhamento das asserções de aspas nos testes de browser de CSV existentes (`e2e/frontend-v0-network-sites.mjs` e `e2e/frontend-v0-os-quotations.mjs`).
  - T4: cenário focado de integração no navegador (`e2e/frontend-v0-workspace-preferences.mjs`), incorporado a `e2e/smoke.mjs`.
- O cenário valida:
  1. Login com administrador da base semeada real (`admin@alfa.demo`).
  2. Adição de favorito conectado, navegação, persistência após recarga e remoção na barra lateral.
  3. Ocultação de bloco opcional da visão geral, persistência na recarga, preservação das prioridades e restauração do padrão.
  4. Logout e novo login de usuário restrito (`financeiro@alfa.demo`) no mesmo contexto de navegador, comprovando isolamento de favoritos e desabilitação/ocultação de widgets sem permissão (`network:read` e `os:read`).
- Situação de prova real: unidades `LOTE45-FAVORITOS` e `LOTE45-PAINEL` mantidas como `pending`/`not_run` até execução e recibo real pelo controlador. Homologação externa permanece pendente.
