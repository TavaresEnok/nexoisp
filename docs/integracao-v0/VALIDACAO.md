# Validação do primeiro incremento

Executada em 18 de outubro de 2026 (America/Fortaleza). Esta evidência cobre o primeiro incremento da integração; a etapa 7 permanece pendente.

## Resultados

| Verificação | Resultado |
|---|---|
| TypeScript da aplicação oficial | Aprovado |
| Testes locais, incluindo os preservados do v0 | 144 aprovados, nenhuma falha |
| Build Vite | Aprovado |
| Imagem de produção com Node 22 e Caddy | Build aprovado; fumaça executada contra a imagem |
| Fluxos de assinantes contra Go isolado | 16 verificações aprovadas |
| Sessão, senha e TOTP contra Go isolado | 5 verificações aprovadas |
| Referência visual: desktop claro, desktop escuro, celular e ficha | 4 comparações com capturas idênticas |
| Integridade da referência original | 231 arquivos preservados por SHA-256 |
| Componentes `ui`, CSS global e fontes do v0 | Código idêntico à referência original |

Os testes de navegador passaram tanto no servidor de desenvolvimento quanto na imagem de produção, com as políticas de segurança do Caddy. A inicialização do tema foi movida para um arquivo estático porque a política existente bloqueia scripts inline; a política não foi flexibilizada.

Os testes utilizaram PostgreSQL e API Go isolados, com dados sintéticos e jobs desativados. Não foram executadas operações em NAS, OLT, ACS, instituições financeiras ou canais de mensagem externos. O código Go e as migrations permaneceram sem alterações.

## Evidências entregues

- `evidencias/comparacao-visual.json` e as oito capturas correspondentes.
- `evidencias/integracao-assinantes.json`: cadastro e validação, exportação CSV, criação de contrato, edição/inativação, campos personalizados, contatos/consentimento, anotações, documentos, acesso ao portal, LGPD, paginação, erros, responsividade, perfis e isolamento.
- `evidencias/integracao-sessao.json`: troca de senha com revogação das outras sessões, configuração/ativação/desativação TOTP, novo login com desafio e expiração.
- `evidencias/assinantes-conectados-{desktop,celular}.png`: amostra da apresentação operacional com dados sintéticos reais do Go.

## Limites e próximos escopos

A comparação visual comprova os cenários capturados na demonstração preservada; não representa uma comparação exaustiva de todas as páginas, estados ou navegadores. Os controles operacionais novos foram revisados no Chromium em desktop e celular.

A ficha já permite criar contratos e exibir seus vínculos e histórico. A abertura completa do contrato, seu financeiro, acesso técnico, atendimento e OS ainda dependem das etapas 5 e 6 e estão identificados como pendentes. Planos, financeiro, rede, administração, portal e operação SaaS ainda não possuem a cobertura final na aplicação oficial.

As limitações existentes do backend continuam válidas, incluindo gateway demonstrativo, cobertura de OLT e limitações históricas de IPv6. A busca de assinantes também preserva o comportamento atual do Go: dígitos extraídos de um termo misto podem ampliar a correspondência por documento/telefone. Não houve alteração dessa regra na migração.

A fumaça da interface anterior foi preservada em `e2e/legacy-smoke.mjs`; os cenários ainda não integrados permanecem pendentes na matriz. A fumaça oficial atual executa somente fluxos efetivamente entregues e não deve ser interpretada como paridade integral do ERP.
