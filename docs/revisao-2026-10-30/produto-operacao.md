# Parecer independente — produto e operação NexoISP

Data: 30/10/2026. Produto examinado: `3ba3f7634e9623ffc8e30b15c618e2b904e63d13`. Worktree documental: `7f43b7bc3c81d6791044bfcd479743d7c00b050a`. A comparação Git entre essas bases contém somente `docs/RELATORIO-GERAL-DESENVOLVIMENTO-2026-10-30.md`; os caminhos e linhas de código abaixo correspondem, portanto, ao produto solicitado.

## Veredito

A direção técnica e de UX é coerente: interface oficial derivada do v0, consultas e comandos adaptados ao Go, persistência transacional e tratamento explícito de várias operações incertas. Há produto operacional implementado, além de demonstrações. Isso não sustenta prontidão irrestrita para operação: identifiquei um problema de continuidade de identidade entre abas, uma repetição insegura de consumo de material e uma lacuna na conferência criptográfica de restore. Recomendo tratá-los em lote próprio antes de declarar resolvidas as pendências internas deste recorte.

Não aprovo homologação, corte ou abertura de gates. CI verde no SHA de produto é premissa fornecida pelo contrato; não foi consultado remotamente nem reproduzido. Os achados são conclusões estáticas, com cenários verificáveis, sem alegação de reprodução dinâmica nesta revisão.

## Achados priorizados

### A1 — Alta: comando de uma aba antiga é repetido sob a nova sessão sem reconciliar a identidade da interface

**Fontes:** `apps/web/data/erp/http.ts:15`, `:29`, `:34`; `apps/web/features/session/provider.tsx:36`, `:62`, `:90`; `apps/api-go/internal/auth/auth.go:183`, `:196`; `apps/api-go/internal/modules/escrita/cadastro.go:21`.

**Cenário:** a aba A mantém um formulário de novo assinante do provedor A. Outra aba encerra essa sessão e autentica um usuário do provedor B, com permissão de cadastro. O cookie compartilhado passa a ser o de B. Ao salvar na aba A, o Go recusa o CSRF antigo. O cliente busca `/api/me`, guarda apenas o novo CSRF e repete automaticamente o mesmo POST com o cookie de B. Não compara usuário, tenant, suporte, permissões ou identidade da sessão com o contexto em que o formulário foi preenchido.

**Evidência e consequência:** `createSubscriber` toma o tenant de `auth.From(ctx).TenantID`. Assim, um comando sem ID de registro de A pode cadastrar em B os dados preenchidos sob A, com autoria de B. O Go continua aplicando autorização e RLS de B; o problema é a troca silenciosa de contexto do comando, não uma prova de quebra de RLS. Comandos contendo IDs de A podem ser barrados pelo isolamento, mas isso não protege criações sem esses IDs. A leitura interna de `/me` no cliente não chama `SessionProvider.reload`; o provider escuta expiração, não troca de sessão entre abas. Seu cache por escopo só é renovado quando o estado de sessão muda. Também há risco de revalidar consultas com o cookie novo enquanto o shell ainda representa a sessão antiga.

**Cobertura consultada:** `apps/web/tests/erp-http.test.ts`, teste “CSRF vem do login, renova após troca de sessão...”, espera a repetição com o novo CSRF. Ele não verifica reconciliação de identidade nem o tenant que recebe a escrita; passar esse teste não elimina o achado.

**Aceite sugerido para correção futura:** detectar mudança de identidade/contexto, invalidar dados e formulários anteriores e exigir nova intenção do usuário antes de escrever. Incluir cenário com duas abas e dois tenants, sem enfraquecer CSRF. Não exige conta externa ou hardware.

### A2 — Média: perda da resposta ao lançar material em OS permite debitar estoque novamente

**Fontes:** `apps/web/features/field/work-materials.tsx:98`; `apps/web/features/shared/form.tsx:95`; `apps/api-go/internal/modules/escrita/estoque.go:42`, `:45`, `:70`; `apps/api-go/internal/modules/escrita/materiais.go:111`; `apps/api-go/internal/modules/escrita/sql/1a18c8b4_2.sql:1`; `apps/api-go/internal/modules/escrita/service.go:139`.

**Cenário:** saldo de 100 unidades, OS aberta, lançamento de 10. A transação confirma o movimento, mas a resposta se perde. O `await api(...)` falha antes de limpar o formulário e atualizar a OS. `MutationForm` mostra erro e libera novamente o envio. O operador repete o lançamento ainda preenchido; com saldo suficiente, o backend insere outro movimento de −10.

**Evidência e consequência:** o comando aceita somente item e quantidade, sem identidade persistente da intenção. `workMaterials` executa `stockMove` a cada chamada; o SQL insere uma nova linha em `stock_movements`. O lock do item e a validação de saldo impedem inconsistência concorrente/negatividade, mas não distinguem repetição de um novo consumo legítimo. O resultado pode ser consumo e saldo errados, exigindo devolução/correção auditada. Não se trata de dois cliques simultâneos: o `inFlight` do formulário cobre esse caso, mas é liberado após a falha de transporte.

**Aceite sugerido para correção futura:** intenção identificada e replay seguro, ou reconciliação explícita que impeça repetir cegamente uma operação de resultado desconhecido. Preservar a possibilidade comercial de lançar duas vezes o mesmo item por motivos legítimos. Cenário novo de teste não foi escrito nem executado. A correção independe de hardware, conta financeira e definição fiscal.

### A3 — Média: restore não verifica os segredos Cloud incorporados ao schema

**Fontes:** `apps/api-go/internal/db/restore.go:21`, `:39`, `:63`; `db/migrations/00079_cloud_notice_journal.sql:11`; `apps/api-go/internal/outbound/notices_cloud.go:208`, `:325`; `scripts/prod-go.sh:34`; `scripts/backup-manifest.py:40`.

**Cenário:** um backup contém `cloud_accounts.token_enc` ou `webhook_secret_enc` cifrado com chave incompatível ou conteúdo inválido, enquanto os campos da lista atual do verificador são decifráveis. O manifesto e as contagens continuam iguais após restaurar. `verifyRestore` percorre sua lista fixa, que não inclui nenhum dos dois campos Cloud, e pode concluir sem detectar o problema.

**Evidência e consequência:** a migração 79 armazena os dois campos e só exige prefixo `v1.`; o sender decifra o bearer ao utilizar a conta. O restore recupera as linhas, mas sua prova de utilizabilidade criptográfica não abrange esse domínio. O resumo numérico do verificador não demonstra que todos os tipos de segredo do schema foram conferidos. O manifesto verifica catálogo, contagens e totais financeiros, não decifrabilidade desses valores.

**Limite de impacto:** o gate Meta está fechado; não afirmo interrupção de uma integração real nem autorizo cadastramento de conta. Esta é dívida interna de continuidade da ampliação já implementada, testável com segredos sintéticos. O ensaio `tests/contrato/restore_clean_host.py:953` tem controle de chave AES errada, mas isso não prova cobertura de cada campo adicionado. Uma futura correção deve exercitar especificamente ambos os campos, inclusive com os demais segredos válidos, sem expor valores e respeitando backups de schemas anteriores.

## Jornadas e pontos sólidos observados

| Jornada | Fluxo e mérito verificável | Limite desta avaliação |
| --- | --- | --- |
| Cadastro | `features/subscribers/form.tsx` → `data/erp/subscribers.ts` → `escrita/cadastro.go:21`; comando tipado, parsing de resposta, tenant obtido da autenticação e auditoria. Edição recusa titular anonimizado (`cadastro.go:34`). | A1 atinge criações; revisão estática não comprova toda validação de dados cadastrais ou usabilidade assistida. |
| Contrato | `features/contracts/create.tsx` → `/contracts` → `cadastro.go:116` → `sql/f1605dbe_2.sql`. Servidor verifica assinante ativo e plano ativo, vincula versão e preserva condições de fidelidade no contrato; formulário limita vencimento de 1 a 28. | Não infiro renovação, penalidades ou fiscal além do contrato implementado. Criação não recebe a mesma intenção durável da baixa; convém incluir resultado ambíguo na definição de um futuro lote, sem declarar duplicação reproduzida aqui. |
| Baixa manual | `features/finance/actions.tsx` → `payment-intent.ts` → `escrita/financeiro.go:112`. A intenção é salva antes do envio, preserva payload em falhas ambíguas, usa Web Locks e chave local por tenant/usuário/fatura. Backend trava fatura e intenção, confere hash/autoria/vínculo e retorna replay. | `tests/payment-intent.test.ts` cobre perda de resposta e falha de storage no nível unitário; resultados históricos não foram reexecutados. Depender de storage e Web Locks tem mensagem de falha fechada e requer homologação dos navegadores escolhidos. A1 continua transversal. |
| OS | `features/field/create.tsx`, `work-actions.tsx`, `work-materials.tsx` → Go. Existem vínculo de titular/contrato, agendamento, transições e motivo de conclusão/cancelamento. Anexos usam endpoint próprio com autorização, locks e conteúdo em `documents` (`work_order_attachments.go:82`, `:119`), download privado e sandbox (`:150`). | A2 é uma falha de continuidade real. Não certifico trabalho offline, check-in ou comportamento de equipe em campo. |
| Estoque | `features/stock/units.tsx` → `escrita/estoque.go`: recebimento serializado, distribuição, status e histórico; movimentos travam item, validam modalidade e saldo. Serial duplicado é recusado (`estoque.go:163`). | Garantias de uma transação não são garantia de replay de todas as movimentações; custo contábil e regras fiscais adicionais não podem ser inferidos. |
| Cotação | `features/stock/quotations.tsx` → `stock_quotations.go:216`: escolha manual, pedido rascunho, lock da cotação, comparação da escolha em replay e vinculação transacional do pedido. A UI explicita que não paga nem recebe estoque. | Estado de intenção da UI é em memória, mas o vínculo no servidor impede segunda conversão da mesma cotação. Não há evidência para chamar isso de compra fiscal completa ou seleção automática de fornecedor. |
| Preferências | `lib/navigation-favorites.ts`, `components/navigation-favorites.tsx`, `features/operations/overview-preferences.ts:314`: catálogo autorizado, versão/tamanho de storage, escopo de sessão e atualização síncrona ao trocar o escopo conhecido. Dados locais são preferências, não banco comercial. | Dependem de o provider conhecer a sessão atual; A1 limita a garantia entre abas. Sem promessa de sincronização entre dispositivos. |

As rotas oficiais usam componentes como `AppShell`, fichas e painéis do v0 com adaptadores operacionais. `src/app.tsx` carrega aplicação operacional e demonstrativa separadamente. `data/erp/http.ts:30` propaga falha de rede; `components/query-boundary.tsx:18` exibe erro e tentativa de consulta. Não encontrei nesses caminhos fallback de erro para seeds nem justificativa para voltar à interface legada.

`auth/auth.go:196` exige CSRF para cookie em mutações; `modules/identity/service.go:168` emite cookie HttpOnly/SameSite=Strict. Permissões e módulos são conferidos no servidor (`auth.go:228`). Essas bases são positivas, sem constituir auditoria de segurança completa, prova de ausência de vazamentos ou substituto de A1.

## Continuidade, migrações, backup e CI

`db/prepare.go:11` adota base histórica completa ou inicializa nova, faz baseline quando aplicável, avança Goose, migra jobs e verifica. `db/admin.go:170` recusa baseline já estabelecido ou conjunto histórico incompleto/desconhecido; há conferência de hashes dos arquivos históricos (`admin.go:39`). Isso dá direção conservadora para evolução, mas não demonstra por si só equivalência entre uma origem comercial externa e o destino, nem compatibilidade com qualquer schema legado.

`scripts/backup-manifest.py` mantém um snapshot repeatable read exportado aberto durante `pg_dump` e manifesto; compara tabelas/RLS/grants/versões, contagens e totais financeiros. `backup.sh` usa checksum do dump e manifesto, banco temporário de restore-check e teste de isolamento. O wrapper `prod-go.sh:34` acrescenta conferência criptográfica; o restore exige `--yes` e, havendo serviços ativos da lista, para-os e prepara migrações antes de reiniciá-los (`:35`). Anexos da OS estão no PostgreSQL, logo não identifiquei um diretório externo de anexos omitido pelo dump desse fluxo.

Limites: checksum protege integridade do arquivo, não substitui autenticação independente da origem; contagens/totais não equivalem a igualdade de cada campo. Cópia externa é comando configurável e sua ausência emite aviso; o backup local continua possível. Cofre, retenção, monitoramento, responsáveis e RPO/RTO seguem requisitos de operação, sem prova nesta revisão. O ensaio sintético de host limpo contém login, documento e compensação após restore, além de controles negativos; é evidência histórica de laboratório, não recuperação operacional ensaiada neste turno. A3 mostra por que ampliar o schema exige ampliar também a cobertura de recuperação.

`.github/workflows/native.yml` encadeia Go build/vet/race/lint, frontend, contratos de migrações, laboratório PG, restore sintético, E2E e SBOM. `tests/contrato/e2e.py:72` executa `e2e/smoke.mjs` contra o build oficial por Caddy, com a lista de jornadas incluindo sessão, comercial, financeiro, OS, estoque, preferências e cotação. É cobertura relevante, não mera checagem de compilação. O caso unitário de CSRF em A1 demonstra, porém, que testes verdes podem preservar uma expectativa insegura.

`apps/web/tests/v0-fidelity.test.ts:59` garante alcançabilidade dos componentes originais ou exceção justificada, veda dependência operacional dentro dos componentes e carga de seeds na operação. Essa é prova estrutural; sozinha não demonstra igualdade visual ou qualidade de interação. Há infraestrutura de comparação visual no E2E (`e2e.py:52`, `:76`) e referências preservadas. Nenhum navegador, screenshot novo ou comparação pixel a pixel foi executado nesta revisão; não atribuo certificação visual ao produto a partir da leitura dos testes. Menus amplos exigem distinguir capacidade conectada, parcial, planejada e demonstrativa; quantidade de páginas não mede conclusão comercial.

## Confronto do residual e direção do produto

`docs/LOTE46-BACKLOG-RESIDUAL.json` tem base `8b56d004...`, anterior ao corte, e define `tarefas_internas_prontas=[]` como ausência de contrato residual aprovado e pronto na triagem documental. Essa interpretação restrita é defensável. Interpretá-la como “não existe falha interna corrigível” é incorreto: A1, A2 e A3 são lacunas do código existente, sem dependência de conta, hardware, fiscal ou inventário adicional. Precisam de contratos de correção próprios; este parecer não os implementa nem altera sua autorização.

| Categoria | Conclusão neste recorte |
| --- | --- |
| Dívida técnica interna | A1: vincular intenção ao contexto de sessão; A2: recuperar consumo de material incerto; A3: acompanhar novos segredos na prova de restore. Há trabalho concreto possível sem abrir integrações. |
| Decisão comercial | Fiscal, custos/categorias adicionais, comissões, RH/frota, motor de formulários, topologia completa e regras adicionais não viram tarefas aprovadas por aparecerem no inventário. Sem franquia é decisão humana vigente, não pendência a implementar. Limites técnicos de anexos/rate limit não são franquia de consumo comercial. |
| Homologação | Jornada assistida, acessibilidade com participantes, dispositivos, sandbox financeiro, Meta e bancada física continuam exigindo aceite e evidência próprios. CI e esta revisão não os substituem. |
| Restrição de ambiente | Host de restore, cópia externa/cofre, amostra autorizada de migração e equipamentos reais não estão disponíveis como prova neste trabalho. Isso não justifica postergar os três achados internos. |

Cotação, anexos, marca e preferências têm encaixe nas jornadas existentes: reduzem saídas para ferramentas paralelas e preservam a interface oficial. No recorte examinado, não identifiquei evidência suficiente para qualificá-los como deriva de produto. A ampliação Cloud tem relação com avisos já existentes e mantém uma fronteira externa fechada, mas A3 é um sinal concreto de crescimento de domínio sem propagação completa para operação. Não é autorização para novo canal, conta ou envio. Futuras capacidades só devem entrar com cenário, dependências e aceite explícitos; menu do v0 ou comparativo SGP não aprova escopo automaticamente.

O relatório geral distingue publicação Git de deploy e admite limites; essa distinção deve permanecer. Já os números históricos de integração e expressões como “zero pendentes” no plano v0 descrevem um fechamento de adaptação com escopo/data próprios, não ausência de defeitos posteriores. Esta revisão não recalcula a matriz, não reabre pesquisa/inventário e não certifica a etapa 7 por contagem documental.

## Dúvidas e limites explícitos

- Qual será a política de produto para sessão alterada em outra aba: interromper a operação, recarregar ou pedir retomada consciente? O comportamento atual de A1 precisa cessar independentemente da escolha de UX.
- Quais navegadores/dispositivos compõem o aceite operacional da baixa com Web Locks e armazenamento persistente? A implementação falha fechada, mas não houve homologação nesta revisão.
- Quais RPO/RTO, responsáveis, retenção e cofre serão aprovados para o piloto? Não há inferência de que já estejam atendidos.
- Não revisei exaustivamente todas as rotas, migrações e integrações. Não realizei pentest, benchmark, execução SQL, acesso a segredos, rede externa, produção ou Docker. Não há teste novo ou suíte executada; fontes de teste foram lidas como contratos e evidências históricas foram apenas reutilizadas/atribuídas.
- Gates financeiros, Meta, ACS/OLT/RADIUS e demais efeitos físicos permanecem fechados. Chatwoot/Webchat permanecem excluídos. Não houve mudança de produto, testes, política ou referência visual, nem push, commit, merge ou deploy.

## Verificação desta entrega

Único check automático autorizado: `git diff --check`, executado ao término do bloco documental. O resultado efetivo consta de `.paseo-result.json`; não é teste funcional nem evidência de homologação.
