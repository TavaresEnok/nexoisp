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

## Incremento de inventário e operações de rede — 19 de outubro de 2026

A tabela de equipamentos foi extraída do `NetworkCenter` original do v0 para receber o inventário do Go. O componente compartilhado fica em `components/network-equipment-table.tsx`; sua extração evita carregar os gráficos demonstrativos no inventário operacional. Fichas, agentes, concentradores e operações usam os componentes, fontes e tokens oficiais. Nenhuma página ou CSS do frontend anterior foi importado.

- TypeScript/build e 151 testes locais aprovados. Um teste de adaptador impede que agente online e contas cadastradas sejam tratados como prova de conectividade ou telemetria do NAS.
- Dezesseis comparações visuais com capturas idênticas (32 capturas), incluindo o inventário e a ficha de rede demonstrativos.
- Doze verificações compostas aprovadas contra o Go isolado: emissão de credenciais; rotação e invalidação de token/revogação/reativação/hello/sincronização; cadastro de equipamento; parâmetros/manutenção; NAS integrado e instruções sem recuperação de segredo; novo segredo; bloqueio de conversão com operação aberta; reaplicação/conversão; evidências e restauração por URL; celular; permissões/isolamento; falha operacional sem seeds.
- O Go continua responsável pelo motor de operações. Reaplicar solicita somente contas elegíveis e ignora contas com operações abertas. Converter é bloqueado enquanto há operação aberta; nenhuma dessas ações é apresentada como prova de conectividade física do NAS.
- O cenário usa o protocolo real do agente no ambiente sintético, com mTLS desligado exclusivamente no harness descartável. Emissão de token, autenticação/revogação, versão e sincronização foram verificadas. Um relato explicitamente sintético encerra uma tentativa para permitir a conversão; não houve conexão a NAS ou OLT físico, nem homologação de hardware.
- A fila usa paginação do servidor e mostra intenção, status, tentativas, etapas, datas, validade, motivo e chave de idempotência. A ficha não oferece repetição manual de operações incertas; a recuperação continua sob controle do Go.
- CPU, latência, tráfego e POP ausentes são exibidos como indisponíveis. Agente online não implica NAS acessível. O RADIUS integrado não é apresentado como dependente de agente local.
- Segredos de agente/concentrador ficam somente no estado da janela de emissão, sem persistência no navegador. A janela de emissão abre antes de atualizar o inventário; uma falha dessa atualização não descarta o segredo, e a consulta pode ser recuperada pelo botão de nova tentativa. Consultas posteriores usam os marcadores emitidos pelo Go. Copiar comandos não configura o equipamento automaticamente.

Evidências de desenvolvimento e imagem local de produção: `evidencias/integracao-rede.json` e `evidencias/producao-rede.json`; amostra operacional em `evidencias/rede-conectada-celular.png`. A política de segurança do Caddy foi mantida. O ambiente operacional existente do usuário não recebeu escritas de teste.

RE-02 permanece parcial: redefinição de certificado está implementada, mas não foi validada com certificado fixado/mTLS neste ambiente. RE-05 permanece parcial: parâmetros, segredo, instruções e reaplicação foram validados; criação/refazimento de túneis e handshake aguardam ambiente com VPN/L2TP habilitados. Essas limitações não foram convertidas em sucesso fictício. A matriz registra 76 unidades validadas, 9 parciais, 57 pendentes e 27 capacidades internas/limitações preservadas. A etapa 7 permanece pendente.


## Incremento de acesso, infraestrutura e workspace — 19 de outubro de 2026

A integração usa os componentes oficiais do v0. `NetworkOnlineView` foi extraído da página original de conexões; indicadores/prioridades e o gráfico de barras do painel inicial foram extraídos para composição com dados operacionais. A referência original e todos os componentes UI, fontes e estilos globais permanecem íntegros. Vinte e duas comparações visuais foram idênticas, incluindo início claro/escuro/celular/rede e conexões online.

- `frontend-v0-access.mjs`: doze verificações compostas aprovadas no desenvolvimento e na imagem local de produção. Abrange PPPoE com senha gerada, senha/MAC e versão mínima do agente, suspensão/retorno/reaplicação/desconexão, ficha do titular, accounting sintético, sessões/CSV/consumo/disponibilidade, lote com recusas, IPoE/Hotspot, driver demo identificado, permissões/RLS e falha sem seeds.
- `frontend-v0-cpe.mjs`: cinco verificações compostas aprovadas no desenvolvimento e na imagem local de produção, contra outro Go/PostgreSQL isolado com ACS sintético TR-098/TR-181. Vínculo, leitura, Wi-Fi com validação, releitura, reinício e desvínculo. Tarefa aplicada altera o estado retornado; tarefa enfileirada conserva o SSID observado e apresenta a nota do servidor. Nenhuma senha Wi-Fi é recuperada pela consulta posterior.
- `frontend-v0-optical.mjs`: seis verificações compostas aprovadas no desenvolvimento e na imagem local de produção. Descoberta via relato de agente, vínculo ONU/PON/perfis/VLAN, operação/versão/potências, reaplicação, limiares do NOC, diagnóstico, desautorização confirmada e substituição. O teste usa protocolo sintético, sem OLT física; a falta de homologação Huawei permanece visível.
- `frontend-v0-maintenance.mjs`: cinco verificações compostas aprovadas no desenvolvimento e na imagem local de produção. CRUD operacional de POP, manutenção com datas e público, avisos de início/normalização com consentimento e confirmação, cancelamento, consulta móvel e permissões. Canal de teste em loopback; nenhuma mensagem externa foi enviada. O teste restaura os módulos originais do provedor sintético.
- `frontend-v0-workspace.mjs`: sete verificações compostas aprovadas no desenvolvimento e na imagem local de produção. Contas demo condicionadas a health, busca por cadastro/login/IP/MAC/ONU/OS, abertura de fichas, busca do shell, dashboard/prioridades, tema/celular, perfil financeiro e saída de suporte, erro sem seeds.
- `frontend-v0-ftth.mjs`: seis verificações compostas aprovadas no desenvolvimento e na imagem local de produção. CEO/CTO com coordenadas e hierarquia, portas reservadas/vinculadas a contrato, concorrência, restauração por URL, liberação, ciclos e dependências bloqueados no Go, esquema acessível por teclado e exclusão. Linhas não representam caminho físico de fibra; fusões, OTDR e GIS não foram acrescentados.

As evidências JSON correspondentes usam os prefixos `integracao-` e `producao-` em `evidencias/`. A imagem Node 22/Caddy mantém a CSP existente. Os testes locais passaram com 151 casos; o backend operacional do usuário em 18081 não recebeu escritas. O harness ACS é opcional (`NEXO_V0_ACS=1`) e usa portas distintas do harness padrão, com fixture local e encerramento próprio.

A matriz registra 98 unidades validadas, 6 parciais, 37 pendentes e 28 capacidades internas/limitações preservadas. A restrição a uma única célula `c1` foi confirmada em `apps/api-go/internal/db/db.go`; distribuição multicélula não é uma capacidade disponível. IPAM/CGNAT/consulta legal e demais escopos continuam sendo trabalhados; a etapa 7 não está concluída.


## Incremento de endereçamento e rastreabilidade — 19 de outubro de 2026

O catálogo operacional reutiliza a composição e o CSS do catálogo Core Network do v0, sem converter a resposta do Go em uma base fictícia `TechnicalCatalog`. `frontend-v0-ipam.mjs` aprovou cinco verificações compostas no desenvolvimento e na imagem local de produção: pool IPv4, edição, reserva automática/manual, vínculo ao contrato, unicidade, IPv6 individual, delegação /56, consulta da ficha, liberação e exclusão com RLS. `frontend-v0-ftth.mjs` também verifica positivamente a porta da caixa na ficha do contrato.

`frontend-v0-cgnat-legal.mjs` aprovou seis verificações compostas nos dois ambientes: cálculo de capacidade no Go, criação imutável, mapa de portas/lookup/script, titulares históricos `holders_at`, encerramento com rastreabilidade e bloqueio de exclusão dos pools; consulta legal por IP/porta/período com fuso explícito, referência auditada, CSV e impressão isolada; consulta direta sem CGNAT; IPv6 cadastral com limite histórico explícito. O relatório impresso usa um iframe isolado, sanitiza os campos e não imprime controles ou cadastro de outras telas. A senha não integra consultas ou exportações.

Reservas IPv6 não são anunciadas automaticamente ao NAS. Script CGNAT é exportado para revisão, sem execução no equipamento. Sessão atual e cadastro fixo atual são separados das sessões no instante histórico. A consulta IPv6 informa que não mantém todos os titulares de prefixos já liberados. Evidências: `integracao-ipam.json`, `producao-ipam.json`, `integracao-cgnat-legal.json`, `producao-cgnat-legal.json`.

A matriz passa a 105 unidades validadas, 6 parciais, 30 pendentes e 28 capacidades internas/limitações preservadas. Administração, portal e SaaS continuam pendentes. A etapa 7 permanece aberta.


O mapa operacional foi validado por `frontend-v0-map.mjs`: cinco verificações compostas no desenvolvimento e na imagem local de produção. Reutiliza a composição e os estilos do mapa v0, consulta os pontos por região, camadas e situação, posiciona contrato e POP com coordenadas exatas ou clique, remove localização com confirmação e abre a ficha de portas da caixa. Cobertura, celular, RLS e CSP foram conferidos. Blocos OSM foram substituídos por imagens sintéticas somente no teste; o produto usa o OpenStreetMap permitido pela CSP original. Endereços não são geocodificados. Evidências: `integracao-mapa.json`, `producao-mapa.json`, `mapa-conectado-celular.png`.

Cobertura atual: 106 unidades validadas, 6 parciais, 29 pendentes e 28 capacidades internas/limitações preservadas. A etapa 7 continua pendente.


## Administração e portal — 19 de outubro de 2026

Quatro cenários dirigidos de administração passaram no desenvolvimento e na imagem Node 22/Caddy: `frontend-v0-admin-team.mjs` (7 verificações compostas), `frontend-v0-quality.mjs` (8), `frontend-v0-admin-reports.mjs` (5) e `frontend-v0-saas.mjs` (5). Validam gravações reais de usuários, senha/MFA e restrição por POP; empresas, empresa padrão e vínculo ao contrato; catálogos e tipo do atendimento, SLA aplicado e protegido em uso, campos personalizados e opções, baixa de kit na OS, regras e apuração de comissão, resposta de pesquisa, retenção com mínimos do Go, auditoria paginada e DICI com município/tecnologia/CSV. SaaS cria provedor/administrador, atualiza nome/módulos, suspende e reativa acesso, entra com motivo em suporte e registra as ações na auditoria. O Go impede gerenciar provedores durante suporte; o operador continua autorizado a consultar sua lista no backend. Administrador de provedor não recebe essa autorização.

`frontend-v0-portal.mjs` passou com 8 verificações compostas no desenvolvimento e na imagem: contratos/faturas/dados próprios e manutenção, ausência de cobrança versus gateway explicitamente demo, aceite e hashes conferidos, comprovante sanitizado em iframe de impressão, chamado/mensagens sem notas internas, protocolo encerrado, pesquisa de OS, confiança com intervalo e intenção de reativação, consumo recebido do agente e isolamento entre titulares do mesmo provedor. O consumo permite escolher contrato. O teste confirma intenção no Go, sem afirmar que houve aplicação em NAS físico.

`frontend-v0-portal-wifi.mjs` passou com 3 verificações nos dois ambientes, usando o Go do harness ACS e fixture TR-098/TR-181: troca de SSID/senha aplicada, tarefa enfileirada que conserva o SSID observado, bloqueio de contrato de outro titular e celular. CPE físico não foi homologado por este teste. Os vínculos criados pelo cenário são removidos ao final. Evidências JSON usam os nomes `integracao-` e `producao-` para equipe-empresas, qualidade, auditoria-anatel, saas, portal e portal-wifi.

Typecheck, build Vite e imagem Node 22/Caddy aprovados; testes locais: 151 aprovados. A alteração condicional da navegação foi conferida contra a referência: início em desktop claro/escuro e celular continuam com capturas idênticas (`comparacao-visual-administracao-portal.json`). Componentes `ui`, fontes e CSS global originais foram preservados. Somente bancos e serviços locais isolados receberam dados sintéticos. Não houve envio a instituições, assinantes ou serviços externos.

Cobertura atual: 127 unidades validadas, 5 parciais, 8 pendentes e 29 capacidades internas/limitações preservadas. Avisos, integrações, importação e revisão das unidades parciais continuam em execução; a etapa 7 não está concluída.

## Avisos, integrações, importação e revisão de paridade — 19 de outubro de 2026

`frontend-v0-messages.mjs` aprovou seis verificações compostas no desenvolvimento e na imagem Caddy: webhook interno recebe teste e evento de chamado real, canal mantém Authorization cifrado, prévia de modelo usa variáveis do Go, régua filtra plano/data/janela, consentimento impede envio ao contato sem autorização, repetição não duplica título/regra e exclusões respeitam dependências. O receptor é um servidor HTTP local; não há envio a assinantes ou canais externos.

`frontend-v0-integrations.mjs` aprovou seis verificações nos dois ambientes: token aparece uma vez, API pública aplica escopo/validade/limite, revogação é imediata, webhook recebe assinatura HMAC correta e distingue sucesso/falha HTTP, rotação muda a assinatura, edição/pausa/reativação e exclusão funcionam, entrega real pode ser reenviada pela UI. Somente o estado de falha anterior foi preparado no banco descartável; o evento, a fila, a tentativa de reenvio, a assinatura e o resultado são operações reais do Go. Essa preparação exige variável explícita do contêiner de laboratório e confere seu rótulo. Sem essa variável, a fumaça valida a entrega pendente e seu filtro.

`frontend-v0-import.mjs` aprovou seis verificações nos dois ambientes: leitura de CSV, correspondência de campos e planos, prévia transacional sem gravar, erro de linha e conta sem senha, aplicação somente das linhas válidas, aviso/erro por lote, provisionamento explícito apenas das contas com senha, reimportação sem duplicação, títulos com pagamento parcial e cancelamento, histórico com data original sem SLA ou disparo de avisos e isolamento. A configuração da prévia tem assinatura em memória: mudar um campo ou plano exige simular novamente antes de aplicar. O backend continua aceitando CSV intermediário; uma migração universal direta não foi implementada nem presumida.

`frontend-v0-finance-access.mjs` aprovou quatro verificações nos dois ambientes. A política salva pela UI solicita suspensão por inadimplência; a equipe concede confiança com dias/motivo/autor e consulta histórico; confiança ativa protege de suspensão automática e uma repetição é recusada; pagamento quita a confiança e retoma uma suspensão automática, preservando suspensão manual. A ficha permite cadastrar outro contrato e abrir o contrato específico com preço e versão preservados. A confirmação física continua dependente do agente e do NAS; jobs periódicos estavam desligados e a verificação foi executada explicitamente.

`frontend-v0-network-final.mjs` aprovou três verificações em desenvolvimento e imagem Caddy com harness separado: remoção confirmada de associação de certificado preparada no banco, emissão/regeneração WireGuard, instrução posterior sem chave privada, leitura de timestamp sintético de handshake e troca/regeneração L2TP com senha/PSK ocultas nas consultas posteriores. A fixture `NEXO_V0_NETWORK=1` prepara somente chave pública, PSK de laboratório e contratos de geração das instruções. Não inicia VPN/IPsec, não instala interface e não realiza handshake físico ou validação de cadeia mTLS.

Os testes locais passaram com **152 casos**, incluindo paridade dos destinos estáticos do frontend anterior, preservação dos componentes UI/fontes/CSS e dos **231 hashes** da referência. Nenhuma página, componente ou CSS do legado é importado pela aplicação oficial. TypeScript, build Vite e imagem Node 22/Caddy foram aprovados. O wrapper de CI passou a informar explicitamente a porta do protocolo do agente e a gerar secrets próprios do laboratório; a compilação Python dos wrappers foi verificada.

## Fechamento das sete etapas

A regressão conjunta aprovou os **25 cenários da fumaça oficial**, usando um novo Go/PostgreSQL descartável em 18885/15453. Os quatro primeiros cenários passaram; a execução continuou de CRM até cobrança/acesso após ajustar duas esperas de testes que consultavam o resultado antes da resposta da API. A continuação encerrou com código 0. Não foi necessário alterar regras do Go. CPE, Wi-Fi do portal e rede complementar têm cenários dirigidos em laboratórios próprios, também aprovados na imagem Caddy.

A cobertura final é **139 unidades integradas e validadas, 30 capacidades internas/limitações preservadas, zero unidades de integração parciais ou pendentes**. Todos os caminhos de teste/evidência da matriz existem; observações foram separadas dos caminhos e as notas antigas de trabalho pendente foram atualizadas. O teste de paridade verifica que cada destino estático do frontend anterior possui uma apresentação operacional oficial.

As sete etapas ficam concluídas no escopo de integração e validação. O frontend antigo continua preservado somente para consulta. A aplicação oficial e a imagem usam exclusivamente `apps/web`; a referência v0 permanece íntegra. A imagem de fechamento é registrada em `evidencias/fechamento-sete-etapas.json`. Essa imagem foi validada localmente; não houve publicação em servidor externo ou alegação de homologação física.
