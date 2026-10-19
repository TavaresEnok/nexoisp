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

Os testes utilizaram PostgreSQL e API Go isolados, com dados sintéticos e jobs desativados. Não foram executadas operações em NAS, OLT, ACS, instituições financeiras ou canais de mensagem externos. Neste primeiro incremento, o código Go e as migrations permaneceram sem alterações.

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

## Incremento comercial — 19 de outubro de 2026

O catálogo e a ficha de contratos utilizam os componentes originais `Plans`, `PlanDetails`, `Contracts` e `ContractDetails`, extraídos para receber dados do Go. Os editores adicionais usam os componentes e tokens do v0. O frontend anterior continua somente como referência de contratos HTTP.

- 145 testes locais aprovados; TypeScript e build Vite aprovados.
- Oito comparações visuais idênticas, incluindo catálogo/configuração de plano e lista/ficha de contratos; 16 capturas em `evidencias/`.
- Nove verificações comerciais compostas aprovadas contra Go isolado, em `evidencias/integracao-comercial.json`: criação e versão imutável, políticas, reaplicação sem contas, filtros/contagem, troca de plano/vencimento, restrição, POP/empresa/área/endereço/etiquetas/campos personalizados, condições e cancelamentos, adicionais com preço preservado, encerramento e isolamento.
- A ficha apresenta indicadores comerciais e técnicos separados, com confirmação do equipamento explícita. A consulta vazia de equipamentos foi validada; equipamentos instalados e recolhimento serão verificados com OS/estoque.
- Dois filtros opcionais (`plan_id`, `subscriber_id`) foram acrescentados à leitura Go de contratos. Lista e contagem usam os mesmos filtros, autorização e escopo existentes. UUID inválido retorna 400; filtro de outro provedor não revela registros. Não houve alteração de migrations ou regras comerciais.
- Testes Go direcionados de leitura, autenticação, validação e erros passaram. Duas fixtures históricas referenciadas pela suíte foram restauradas, sem reintroduzir servidor Node.

Os cenários de ativação/desativação e paginação/exportação comercial foram posteriormente validados na fumaça sequencial. A prova de aceite pelo portal permanece parcial. Reaplicação foi verificada sem contas, sem operação em hardware. A imagem Docker foi posteriormente reconstruída e validada com os incrementos comercial e financeiro descritos abaixo. A etapa 6 está em andamento e a etapa 7 permanece pendente. As funcionalidades de financeiro/rede/atendimento dentro das fichas ainda dependem desses módulos.

## Incremento financeiro — 19 de outubro de 2026

A tabela e o diálogo de fatura foram extraídos dos componentes originais do v0 para receber dados reais. O gráfico utiliza a série mensal do Go; não se inventa uma série de comparação. Os novos editores usam os componentes e tokens oficiais. O código de financeiro e seus gráficos são carregados sob demanda, inclusive nas fichas.

- TypeScript e build aprovados; 148 testes locais aprovados, sem falhas.
- Dez comparações visuais com capturas idênticas, incluindo lista e detalhe de fatura (20 capturas).
- Fumaça sequencial contra Go isolado: 41 verificações compostas aprovadas (16 assinantes, 5 sessão, 10 comercial, 10 financeiro).
- Financeiro: geração idempotente, consulta de saldo e itens, baixa parcial, estorno, quitação com desconto, aplicação de encargos calculados no Go, fatura avulsa, cancelamento, extrato por contrato, acordo, política, aviso público/configuração/desativação, exportações, relatórios, permissões e isolamento.
- Gateway demonstrativo: webhooks normal e duplicado registram um único recebimento; divergência exige decisão; a conciliação recupera pagamento com webhook perdido. Nenhum pagamento bancário real foi executado.
- Os percentuais `numeric` retornados pelo PostgreSQL são normalizados no adaptador antes de nova gravação. Há teste local de regressão.
- Busca e reinício da paginação agora usam uma única navegação. Isso evita que o reinício tardio feche uma fatura aberta imediatamente após a busca. Há teste local de regressão e cobertura no navegador.
- A edição de etiquetas em contrato encerrado foi mantida conforme o comportamento do frontend anterior e do Go; as ações comerciais que exigem contrato ativo continuam condicionadas a esse estado.

A concessão/expiração de confiança, a execução da política de suspensão e os cenários com equipamentos instalados serão validados junto aos módulos de rede, OS e estoque. O aceite efetivo e seu comprovante ainda dependem da etapa do portal. A inexistência de conector bancário real está registrada como limitação preservada, sem simular homologação.

## Verificação da imagem atual

Imagem `nexo-v0-frontend:validation`, construída com o Dockerfile de produção (Node 22 e Caddy), verificada em `http://127.0.0.1:18390` contra o Go isolado. Os 20 cenários compostos de comercial/financeiro passaram nessa imagem, incluindo carregamento dos módulos sob demanda, página pública e operações autenticadas, sem erros de execução ou bloqueios de CSP detectados. A política de segurança existente não foi flexibilizada. Isso é uma validação local da imagem, não publicação no ambiente operacional do usuário.

Evidência resumida em `evidencias/producao-comercial-financeiro.json`. O ambiente existente em 18081 foi preservado.

## Incremento de CRM — 19 de outubro de 2026

A fila e a ficha de atendimento usam os componentes originais `Support`/`TicketDetails` do v0, extraídos para receber dados do Go. O funil de prospectos e seus editores utilizam a mesma estrutura de páginas, painéis, fichas e formulários. Nenhuma página, componente ou CSS do frontend antigo foi importado.

- TypeScript e build Vite aprovados; 149 testes locais aprovados, sem falhas.
- Doze comparações visuais com capturas idênticas (24 capturas), agora incluindo fila e ficha demonstrativas de atendimento.
- Doze verificações compostas aprovadas contra o Go isolado: cadastro/edição de prospecto e validação de contato; etapas/perda/retomada; contato/histórico; conversão; criação de protocolo com titular/contrato; responsável; nota interna/resposta; criação de OS vinculada com endereço; encerramento/reabertura; restauração por URL e ficha do titular; busca/paginação/exportação/relatório; perfis e isolamento.
- A privacidade da nota interna foi conferida também pela API do portal: o assinante recebe a resposta pública e não recebe a nota da equipe. O frontend completo do portal continua pendente.
- Os estados de atendimento correspondem aos valores do Go. Incidentes do cenário fictício não aparecem no modo operacional. A ausência de prazo é explícita; não há relógio de espera ou SLA inventado para preencher o contrato visual.
- O módulo CRM foi verificado no servidor de desenvolvimento. A evidência da imagem de produção acima continua referente ao checkpoint comercial/financeiro.

A operação completa de OS, auxiliares, materiais, estoque e agenda ainda está em implementação. Criar uma OS pelo protocolo não comprova esses módulos e não encerra a etapa 6.

## Incremento de OS e agenda — 19 de outubro de 2026

O quadro, a lista e o diálogo de OS usam os componentes originais `FieldOperations`, `FieldOrderBoard` e `ServiceOrderDetails`, extraídos para receber os registros operacionais. Agenda, Meu trabalho e os controles adicionais usam os componentes, fontes e tokens do v0. A referência original e os componentes básicos de UI continuam preservados.

- TypeScript e build aprovados; 150 testes locais aprovados. O teste Go de filtros de OS passou, incluindo UUID inválido e precedência de `mine=1`.
- Quatorze comparações visuais com capturas idênticas (28 capturas), incluindo quadro e ficha demonstrativos de OS.
- Dezoito verificações compostas de OS aprovadas em desenvolvimento e na imagem de produção: criação e endereço específico; atribuição/agendamento e horário local; agenda com sobreposição/janelas/fila de espera; Meu trabalho no celular; fichas de assinante e contrato; auxiliares/checklist; rejeição de saída sem saldo e devolução excessiva; material/devolução/kit; instalação por série; espera/reagendamento/deslocamento/execução/conclusão; ficha A4 sem notas internas; filtro por responsável/CSV; cancelamento; paginação/busca; falha operacional sem seeds; comodato a recolher; perfis; isolamento entre provedores.
- O checklist mostra a marcação durante a gravação e restaura o estado anterior se o servidor rejeitar a alteração. OS finalizada oculta controles de execução, equipe e consumo; anotações posteriores continuam permitidas conforme o Go.
- A lista pagina oito registros no servidor. As fichas consultam até oito OS do vínculo, respeitando a ordenação do Go, e oferecem acesso à lista completa. A agenda usa o fuso do provedor e as janelas calculadas no backend. Meu trabalho consulta até 50 OS pendentes do usuário e atualiza a cada 30 segundos; exige conexão.
- A ficha imprimível informa o contrato e distingue o endereço do serviço do cadastro do titular. Não inclui descrição e notas internas nem presume plano, velocidade, anexos ou assinatura eletrônica ausentes.
- O filtro opcional `assignee_id` foi acrescentado à leitura Go de OS, reutilizando o mesmo SQL, contagem, autorização e isolamento existentes. `mine=1` mantém precedência. Não houve alteração de migrations ou regras comerciais.
- A imagem foi construída com Node 22/Caddy e verificada localmente em `http://127.0.0.1:18390`, contra Go/PostgreSQL isolados e somente dados sintéticos. Os cenários não detectaram erros de execução ou de CSP; a política original foi mantida. Isso não representa publicação no ambiente operacional do usuário.

Evidências: `evidencias/integracao-os.json`, `evidencias/producao-os.json`, `evidencias/os-conectada-desktop.png` e `evidencias/meu-trabalho-conectado-celular.png`. O CRM também foi revalidado após os novos acessos nas fichas; o resultado de produção é registrado em `evidencias/producao-crm.json`.

A instalação e o alerta de comodato a recolher foram validados. O catálogo completo de estoque, distribuição, retirada, defeito, conserto, baixa e histórico de unidades continuam pendentes (OS-11–14). O cartão de equipamentos permanece parcial até a integração do recolhimento efetivo. A etapa 6 continua em andamento e a etapa 7 permanece pendente.

## Incremento de estoque — 19 de outubro de 2026

A referência do v0 não possui uma tela operacional de estoque. O catálogo, movimentos e unidades foram compostos com `PageHeading`, `Panel`, `Table`, `Dialog`, formulários, fontes e tokens da interface oficial. Não foram importadas páginas, componentes ou CSS do frontend anterior.

- TypeScript/build de produção e 150 testes locais aprovados.
- Doze verificações compostas aprovadas contra o Go isolado, em desenvolvimento e na imagem com Node 22/Caddy: cadastro e mínimo; entrada/saída/ajuste; edição/ativação e bloqueio de serialização após movimento; lote com normalização e rollback por série duplicada; distribuição e custódia; contrato/instalação/retirada/recolhimento; defeito/conserto/baixa definitiva; histórico; celular; permissão de consulta sem movimentação; isolamento; falha operacional sem seeds.
- A busca do catálogo filtra somente os itens retornados pelo servidor; a tela informa essa abrangência. As consultas de movimentos e unidades preservam os limites existentes de 200 e 2.000 registros, respectivamente. Lotes preservam o limite de 500 séries por entrada.
- A unidade instalada aponta para contrato e OS reais. A retirada exige confirmação, retorna ao saldo e elimina a pendência de comodato a recolher do contrato encerrado. Defeito, conserto, custódia e baixa seguem as regras existentes do Go. O histórico é preservado, sem edição ou exclusão.
- O cache compartilhado de itens, unidades, movimentos, eventos e equipamentos do contrato é atualizado após as mutações. O perfil Atendimento consulta unidades e histórico, mas não recebe controles nem autorização para movimentar estoque.
- O backend Go não foi alterado neste incremento. Não foram acrescentados banco no navegador, regras comerciais paralelas ou simulação de registros operacionais. A imagem foi validada localmente, sem publicação no ambiente do usuário.

Evidências: `evidencias/integracao-estoque.json`, `evidencias/producao-estoque.json` e `evidencias/estoque-conectado-celular.png`. A matriz passa a registrar 71 unidades validadas, 7 parciais, 64 pendentes e 27 capacidades internas/limitações preservadas. Isso não corresponde a um percentual de esforço concluído. Rede, administração, portal e SaaS continuam entre os escopos pendentes; a etapa 7 não está concluída.
