# Melhorias e validação executada

## Problema → resultado mensurável

| ID | Problema encontrado | Implementação e capacidade preservada | Como medir/validar |
|---|---|---|---|
| AUD-01 | Datas com formato correto, mas inexistentes, chegavam ao PostgreSQL ou eram guardadas em JSON | `customDate` usa calendário real e ano positivo; schemas de nascimento, início de contrato e financeiro reutilizam a validação. Campos opcionais e ano bissexto permanecem aceitos | Datas impossíveis, ano zero e formato incompleto retornam 400; `2024-02-29` persiste. Não há resposta artificial de sucesso ou erro 500 de cast |
| AUD-02 | Custom aceitava data impossível, texto obrigatório só com espaços e nova informação após anonimização | Validação semântica e lock do titular antes de editar custom; RLS e permissão permanecem no caminho | Gravar/consultar; 400 para dados inválidos; 409 após anonimizar; 404 de outro tenant; 403 para financeiro |
| AUD-03 | Inclusão repetida de auxiliar gerava histórico extra; OS final ainda aceitava alterações; promoção mantinha a pessoa como auxiliar | Lock da OS, verificação de estado final e contagem de linhas inseridas. Promover remove auxiliar na mesma transação e registra o motivo | Uma inclusão e um evento; depois da promoção não há dupla participação; conclusão impede inclusão/remoção |
| AUD-04 | Atribuição e inclusão de auxiliar podiam disputar a mesma OS sem serialização consistente | Operações adquirem lock sobre a mesma linha antes de decidir | Duas requisições concorrentes não deixam a mesma pessoa em dois papéis |
| AUD-05 | Fluxo de estoque precisava de evidência além da existência da tela | Nenhum módulo fictício adicionado; exercitado saldo/OS/material/kit já implementado | Saldo inicial 2; kit de 3 recusado sem consumir; consumo/devolução válidos restauram saldo; devolução excessiva falha; kit de 1 desconta |
| AUD-06 | Busca antiga podia sobrescrever nova busca; página anterior podia acompanhar novo filtro; detalhe antigo podia reaparecer | Geração da requisição + estado visível ligado à consulta; paginação por filtro; consulta nula limpa o detalhe; falha em novo filtro limpa linhas/totais anteriores | Chromium recebe respostas invertidas e erro HTTP; resultado final é o filtro atual, offset zero e detalhe correto; voltar ao filtro antigo também começa em zero |
| AUD-07 | Atualização de nome exigia reenviar cadastro inteiro; campos omitidos podiam ser apagados e situação recebia default ativo | Schema parcial remove defaults/transforms de ausência; lock, merge e persistência preservam o restante | Alterar só nome mantém telefone, e-mail, nascimento e situação inativa; `phone: null` limpa intencionalmente |
| AUD-08 | Playwright 1.49.1 tinha alerta de segurança conhecido no instalador | Dependência e imagens de teste alinhadas em 1.55.1; comando `nexo e2e` usa o lockfile | `npm audit` sem vulnerabilidades no pacote e2e; navegador e fumaça reexecutados |
| UX-01 | Ação “Aguardando agendamento” usava um campo descrito como motivo de cancelamento | Texto e rótulo acessível explicitam o motivo; botão depende de conteúdo, mantendo validação no backend | Inspeção e tipos/build; não declarada homologação visual do fluxo completo |

Arquivos principais: `apps/api-go/internal/modules/escrita/{cadastro,custom,schemas,financeiro,materiais,ordens}.go`, dois SQLs de lock existentes, `apps/web/src/api.ts` e `apps/web/src/pages/Field.tsx`. Nenhuma migration histórica foi reescrita.

O alerta AUD-08 é do instalador de navegadores da ferramenta de testes, especificamente dos scripts Chrome/Edge no macOS; não é uma vulnerabilidade atribuída ao runtime Go. A versão mínima corrigida é 1.55.1, conforme o [aviso oficial do Playwright](https://github.com/microsoft/playwright/security/advisories/GHSA-gx27-2j22-qcx8). O resultado do audit refere-se a `e2e/package-lock.json`, não a uma certificação de todas as dependências do projeto.

## Verificações dirigidas

`tests/contrato/sgp_auditoria.py` sobe API local em `18891`, cria somente `nexo_test` no container sintético permitido pelo helper e não carrega `.env` do produto. Usa criação de dados, erros HTTP, consulta posterior, histórico e concorrência real de transações. A API e o CLI são compilados antes do ensaio.

Essa regressão entrou no workflow `.github/workflows/native.yml`, entre a suíte nativa e a fumaça do painel. Esses ensaios compartilham somente o banco de laboratório e devem rodar sequencialmente.

`e2e/sgp-auditoria.mjs` carrega `e2e/sgp-harness.tsx` por Vite local para exercitar os hooks reais do frontend. Os endpoints `audit-list`/`audit-detail` são interceptados somente no navegador de teste e não existem no produto. Viewport 390×844; sem erro de página. Isso comprova comportamento dos hooks nessa viewport, não a responsividade de todas as telas.

Execução do navegador:

```bash
npm ci
npm -w apps/web run dev -- --host 127.0.0.1 --port 18890 --strictPort
# em outro terminal, com Playwright/Chromium disponíveis:
cd e2e
npm ci
BASE=http://127.0.0.1:18890 node sgp-auditoria.mjs
```

Os resultados executados e limites de cada verificação ficam no [registro de execução](execucao.json). Testes históricos não reexecutados não contam como evidência nova. A listagem OpenAPI/manifest comprova inventário de operações, sem comprovar que cada operação foi exercitada.

## Limites de implantação

Código e documentação preparados na árvore local. Nenhuma integração, cobrança, emissão fiscal, comando de rede ou alteração de produção foi executada. Os testes não tornam o gateway demo real nem homologam as regras desconhecidas do SGP. O trabalho restante está em [Backlog](backlog.md).
