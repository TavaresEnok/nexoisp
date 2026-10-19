# Integração do frontend oficial v0 ao ERP Go

## Resultado

As sete etapas estão concluídas no código e na validação da integração. A aplicação oficial em `apps/web` utiliza o frontend do v0 e cobre as funcionalidades disponíveis no NexoISP Go, respeitando suas limitações existentes.

O fechamento registra **139 unidades integradas e validadas**, **30 capacidades internas ou limitações de backend preservadas**, **zero pendentes** e **zero parciais de integração**. Esses estados descrevem a adaptação da interface; não transformam uma capacidade parcial do backend em capacidade completa. A matriz mantém separadamente o estado original do Go.

Evidências: [fechamento das sete etapas](evidencias/fechamento-sete-etapas.json), [matriz funcional](MATRIZ_FUNCIONAL.md), [validações por incremento](VALIDACAO.md) e [execução e operação](OPERACAO.md).

## Regra obrigatória

O frontend do v0 é a referência oficial e obrigatória de UI/UX. As funcionalidades do Go foram adaptadas aos seus componentes, layouts, estilos, fontes e interações. As regras de negócio, autorização, isolamento por provedor/POP, autenticação por cookie HttpOnly e proteção CSRF permanecem no Go existente. Não há backend duplicado, banco de negócio no navegador ou autenticação simulada.

`docs/novo-design-nexoISP` permanece como referência original, com **231 arquivos conferidos por SHA-256**. Componentes `ui`, CSS global e fontes continuam idênticos à referência. `apps/web-legacy` preserva o frontend anterior para consulta e não participa do workspace, do build ou dos imports oficiais. As alterações preexistentes do usuário, incluindo a exclusão de `docs/pilha-tecnologica.md`, não foram revertidas nem incluídas nos commits da integração.

## Etapas concluídas

| Etapa | Entrega | Evidência de conclusão |
|---|---|---|
| 1 | Referência visual, preservação e matriz funcional | 169 unidades inventariadas; 231 hashes preservados; 22 cenários visuais idênticos, com nova conferência de início em claro/escuro/celular |
| 2 | Promoção do v0 para `apps/web`, build e implantação da imagem | React/Vite ativos; build Node 22 e imagem Caddy aprovados; frontend anterior fora da aplicação oficial |
| 3 | Fundação operacional | Sessão, MFA, permissões, módulos, CSRF, downloads, expiração, cache por contexto, suporte e demonstração isolada validados |
| 4 | Assinantes | Lista paginada, cadastro, ficha, edição, contatos, documentos, privacidade, histórico e múltiplos contratos validados |
| 5 | Núcleo comercial | Planos/versões, contratos, condições, adicionais, equipamentos, encerramento e aceite com comprovante conferido validados |
| 6 | Expansão funcional | Financeiro, CRM, OS/agenda/estoque, rede, CPE/ONU/NOC, FTTH/mapa/IPAM/CGNAT, administração, avisos, integrações e importação validados |
| 7 | Cobertura final e retirada operacional do legado | Portal e SaaS validados; todas as rotas estáticas anteriores cobertas; matriz sem integração pendente; regressão sequencial aprovada e legado mantido apenas para consulta |

## Arquitetura e contextos

Componentes v0 → consultas e comandos tipados por funcionalidade → adaptadores HTTP → API Go existente. As entidades operacionais não são colocadas no contrato demonstrativo `WorkspaceData`. Campos sem fonte são explicitamente ausentes; intenção de rede, observação, pendência, falha e resultado incerto são separados.

`/demonstracao/` mantém o cenário fictício original, carregado separadamente e sem chamadas operacionais. Falha na API real exibe erro e nunca seleciona seeds. Recursos previstos no catálogo visual que não existem no backend são identificados como planejados; os 420 nós do v0 não equivalem a 420 páginas ou capacidades disponíveis no Go.

## Verificações finais

- TypeScript e build Vite aprovados.
- **152 testes locais aprovados**, incluindo preservação visual e paridade das rotas estáticas anteriores.
- **25 cenários operacionais sequenciais aprovados** na base descartável de regressão, com continuação após corrigir esperas assíncronas dos testes; CPE, Wi-Fi do portal e túnel/certificado têm cenários dirigidos adicionais.
- Mutações, consultas e permissões conferidas com Go/PostgreSQL reais e registros sintéticos. Incrementos também validados em imagens locais Node 22/Caddy com a CSP existente.
- Comparações visuais preservam o v0 em desktop claro/escuro, celular e fichas; os ativos originais não foram substituídos.

## Limites de conclusão

O fechamento é da integração do frontend às capacidades disponíveis. Não representa publicação em servidor externo ou homologação de equipamentos/serviços físicos. Permanecem os limites documentados: gateway financeiro real ausente, migração universal SGP/MK-Auth ausente, driver Huawei sem homologação física, CGNAT de laboratório, entrega/histórico IPv6 limitados e operação de banco restrita à célula `c1`. Jobs periódicos dependem de habilitação na instalação.

Para iniciar ou reproduzir as validações, consulte [OPERACAO.md](OPERACAO.md). O ambiente operacional do usuário não recebeu escritas de teste.
