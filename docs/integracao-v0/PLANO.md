# Integração do frontend oficial v0 ao ERP Go

## Regra e critério de conclusão

O frontend do v0 é a referência oficial e obrigatória de UI/UX. A integração adapta as funcionalidades existentes à nova interface, preservando seus componentes e sua identidade visual. A conclusão da etapa 7 exige todas as funcionalidades existentes do NexoISP Go integradas, respeitando as limitações já existentes no backend. Recursos apenas previstos no v0 podem permanecer demonstrativos ou planejados, com identificação explícita.

## Preservação

- `docs/novo-design-nexoISP`: referência original preservada; hashes em `referencia-v0.sha256.json`.
- `apps/web-legacy`: cópia do frontend anterior, incluindo seu `package.json` já modificado pelo usuário. Não compõe o workspace ou o build oficial.
- `apps/web`: aplicação oficial baseada no código completo do v0.
- As alterações preexistentes do usuário no lockfile, inventários e exclusão de `docs/pilha-tecnologica.md` não devem ser revertidas.

## Etapas

| Etapa | Escopo | Situação |
|---|---|---|
| 1 | Referência visual, preservação e matriz por unidade funcional | Concluída: 169 unidades e quatorze comparações visuais idênticas |
| 2 | Promover o código completo do v0 para `apps/web`, build e implantação | Código promovido; build e imagem Docker validados |
| 3 | Sessão, MFA, permissões, módulos, HTTP, cache e demonstração isolada | Fundação integrada; login, senha, TOTP, expiração e isolamento validados |
| 4 | Assinantes: consulta paginada, ficha, cadastro e edição | Cadastro e recursos complementares validados; ficha recebe os módulos das etapas 5 e 6 |
| 5 | Planos, contratos, versões, adicionais e condições | Núcleo comercial, equipamentos e recolhimento validados; comprovante de aceite depende do portal |
| 6 | Atendimento, OS, estoque, financeiro, rede, administração e importação | Financeiro, CRM, operação de OS, agenda, Meu trabalho e estoque integrados; rede e administração em implementação |
| 7 | Portal, SaaS, revisão da cobertura e retirada operacional do legado | Pendente |

Uma etapa ou unidade só recebe estado concluído após validação correspondente. A presença de uma tela, de um endpoint ou de um teste de leitura não comprova a cobertura de suas mutações e regras.

## Arquitetura

Componentes e composição visual do v0 → consultas/comandos por funcionalidade → adaptadores HTTP → API Go existente. O modo demonstrativo usa os leitores locais originais. Consultas reais usam paginação e carregamento por contexto, sem sintetizar métricas ausentes nem preencher lacunas com seeds. Sessão e cache são delimitados por identidade, provedor e entrada/saída de suporte.

## Validação

Usar testes de contrato dos adaptadores, testes direcionados de interação e navegador contra uma instância isolada do Go. O ambiente existente do usuário não deve receber escritas de teste. Capturar referências determinísticas da demonstração em claro/escuro e desktop/celular. Registrar resultados reais e limitações em `VALIDACAO.md`.

## Execução local e evidências

- `npm ci` na raiz instala as dependências da aplicação oficial. As versões diretas foram fixadas conforme o lockfile original do v0; React/ReactDOM e Vite têm resolução única no workspace.
- `API_URL=http://127.0.0.1:18081 npm -w apps/web run dev` conecta o frontend ao Go escolhido, em `http://127.0.0.1:3000`.
- `/demonstracao/` abre o cenário visual original em um contexto separado, sem chamar a API operacional. O navegador carrega a aplicação demonstrativa sob demanda.
- `npm -w apps/web run typecheck`, `npm -w apps/web test` e `npm -w apps/web run build` verificam tipos, testes locais e produção.
- `python3 tests/contrato/frontend_v0.py --serve` prepara um PostgreSQL descartável e uma instância Go sintética. O comando não lê `.env` do produto; encerre-o para remover o contêiner de validação.
- Com o frontend apontando para essa instância, `npm -w apps/web run test:e2e` percorre os fluxos efetivamente integrados. A fumaça antiga está preservada em `e2e/legacy-smoke.mjs`, como referência para as etapas ainda pendentes.
- `e2e/frontend-v0-visual.mjs` compara a referência original com `/demonstracao/`; as capturas e os hashes estão em `evidencias/`.

As páginas ainda não conectadas apresentam esse estado e permitem abrir a demonstração visual. Não há fallback para seeds no contexto real. A aplicação oficial ainda não substitui a cobertura funcional completa do frontend anterior; a etapa 7 permanece pendente.

Resultados executados, evidências e limites: [VALIDACAO.md](VALIDACAO.md).

## Cobertura atual

A matriz registra 71 unidades integradas e validadas, 7 parciais, 64 pendentes e 27 capacidades internas ou limitações do backend preservadas. Esses números contam unidades funcionais, não esforço ou tempo restante. A cobertura ainda não representa conclusão das sete etapas.

`test:commercial` valida o núcleo comercial; `test:finance` valida os fluxos financeiros; `test:crm` valida prospectos e atendimento; `test:field` valida OS, agenda e trabalho do técnico; `test:stock` valida o estoque e o ciclo das unidades por série. A fumaça oficial executa assinantes, sessão, comercial, financeiro, CRM, OS e estoque em sequência contra a mesma base sintética para evitar interferência entre geração financeira e dados de outros cenários.
