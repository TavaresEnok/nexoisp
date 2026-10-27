# ACS — propriedade e intenções duráveis — 27/10/2026

Base anterior `526cd47`, tag `base/pre-b09-acs-2026-10-27`. Continuação no checkout `NexoISP/`, branch `dev/lote01-consolidado-2026-10-26`. Integração exclusivamente local. A interface oficial/componentes/referência v0 permanecem preservados.

## Funcionalidade

O inventário GenieACS é a autoridade de propriedade: exatamente uma tag `nexoisp-tenant:<UUID canônico>`. Somente o operador SaaS global, fora de sessão de suporte, atribui um CPE ainda livre, informando ID, serial e justificativa. Há auditoria antes da chamada externa, serialização local por dispositivo e confirmação por leitura. Não se transfere/remova propriedade automaticamente. Uma segunda entrega da mesma atribuição pode confirmar a tag existente; não toma equipamento de outro tenant. A tag é criada com **POST**, conforme `lib/nbi.ts` do GenieACS inspecionado, e não PUT. Administradores de tenant não têm essa permissão. As credenciais NBI são da instalação, não do navegador.

Pesquisar/vincular/consultar CPE exige propriedade além do contrato/assinante/POP autorizado. Saber serial ou usuário PPP não confere propriedade. O filtro enviado ao ACS é conferido novamente na resposta. Inventário livre, ambíguo ou alheio não entra na seleção. Vínculos legados são preservados, mas não são automaticamente legitimados; dependem de atribuição verificada pelo operador. Instalações atuais com NBI sem tags precisam dessa preparação antes dos comandos.

Wi-Fi, refresh e reboot passam por `acs_task_intents`: identidade/contrato/dispositivo/instância, payload cifrado, pedido congelado, baseline, IDs local/remoto e estado persistem antes de POST. A mesma intenção com outro conteúdo conflita; repetição idêntica consulta/reutiliza o journal. Outra intenção e alteração do vínculo ficam bloqueadas enquanto houver resultado pendente/revisão. A interface persiste somente UUID/tipo, por tenant/ator/contrato; nunca PSK em localStorage. Após perda de resposta, consultar histórico antes de redigitar: o backend não aceita mudar o corpo da mesma intenção.

`prepared` → `uncertain` é confirmado antes de enviar; somente esse caminho envia uma vez. `queued` significa aceite ACS, inclusive HTTP200, e não alteração aplicada. Depois há somente consulta de tarefa/fault e leitura fresca. Wi-Fi compara valores/timestamps; refresh usa `_timestamp` do objeto efetivamente persistido pelo GenieACS; reboot exige UpTime reduzido e timestamp novo. Password mascarado, timestamp ausente/antigo e tarefa desaparecida não provam aplicação. `observed` é observação do ACS, não homologação física independente.

POST usa a fila para o próximo Inform, sem forçar connection_request. O `uniqueKey=nexo:<id local>` serve para localizar a tarefa. Não é tratado como idempotência do GenieACS: o fonte local `modulos/acs-tr069-tr369/genieacs/lib/api-functions.ts::insertTasks` remove tarefa anterior de mesma chave antes de inserir outra. Portanto não se repete POST após incerteza. IDs/falhas não são apagados pelo cliente. `retry-lookup` agenda apenas consulta. Wake-up próprio preserva pedido que chega enquanto o job anterior ainda está running; a trava por tenant e a transição da intenção continuam impedindo envio duplicado.

## Caminhos e interfaces

- `apps/api-go/internal/acs/client.go`: transporte limitado, sem redirects/proxy, TLS>=1.2, propriedade/atribuição, aceite e evidência de tarefa.
- `internal/acs/intents.go`: journal cifrado, salt interno, compare/replay, dispatcher e readback; `internal/jobs/jobs.go` / `internal/db/jobs.go`: worker/acionamento transacional.
- `internal/modules/escrita/cpe.go`: operações existentes agora exigem `intent_id`; `acs_tasks.go`: histórico/reconsulta e atribuição. Clientes antigos de Wi-Fi/refresh/reboot devem enviar UUID novo por intenção e preservá-lo em retry; recebem estado preparado em vez de “applied”. UI e portal oficiais foram adaptados.
- `GET /api/contracts/{id}/cpe/tasks` (`network:read`); `POST .../{taskId}/retry-lookup` (`network:operate`, justificativa).
- `GET /api/portal/cpe/{id}/tasks`, `POST .../{taskId}/retry-lookup` (`portal:self`, só titular).
- `POST /api/acs/ownership/assign` (`tenants:manage`, exclusivamente saas_operator sem tenant/suporte).
- `apps/web/features/network/{cpe,cpe-tasks,cpe-intent}.tsx/.ts`, `features/portal/wifi.tsx`, `features/admin/tenants.tsx`: integração nos painéis existentes. Histórico mostra estados separados e consulta fundamentada; revalida leitura observada sem alterar a referência visual.

## Configuração e dados

Todos os gates novos ficam 0 por padrão: `NEXO_GO_JOB_ACS_TASKS`, `NEXO_ACS_TASKS_ENABLED`, `NEXO_ACS_TASK_WRITE`, `NEXO_ACS_OWNERSHIP_ENABLED`. Worker exige também `NEXO_GO_JOBS=1`. `NEXO_ACS_URL` é configuração exclusiva do servidor; autenticação HTTP opcional por `NEXO_ACS_USERNAME/PASSWORD` quando o NBI/proxy a exigir. NBI não deve ser oferecido a tenants. `NEXO_ACS_INSTANCE_ID` persistente (3–128 caracteres) e `NEXO_SECRET_KEY` persistente são obrigatórios para preparar intenções. Alterar URL/identidade da instância põe intenções antigas em revisão, sem encaminhá-las ao novo servidor. Reutilizar o mesmo ID para outro inventário viola esse contrato operacional.

Migração aditiva **75**, sem alterar tabelas/histórico financeiro. RLS herda visibilidade do contrato e função cifrada verifica tenant/titular/POP, inclusive a regra já existente para contratos sem POP. `payload_enc` não tem SELECT direto para nexo_app; leitura interna usa função de escopo fixo. Identidade/instância/envelope são imutáveis para a aplicação. Só proprietário da tabela pode recifrar o envelope; `rotate-secrets` e `verify-restore` incluem a tabela e toleram sua ausência em schema74. Não registrar senha ou request completo em auditoria. `request_hash` usa salt aleatório cifrado para evitar verificador público de PSK.

Recuperação: manter schema75/journal, chaves e histórico; não há down destrutivo. Antes de eventual troca de binário, desabilitar envio/worker/atribuição ACS e impedir o caminho de mutação da versão anterior (retirar sua URL ACS); ela não entende o journal e não é substituto seguro para resolver incerteza. Uma restauração em cópia deve validar segredos e reconciliar IDs/readback antes de qualquer reativação. Integridade/decifragem não demonstram restauração física do CPE.

## Validação e limites

Referência local conferida: GenieACS `1.3.0-dev`, commit `4aa5cbfa33c40d17fcbb0b391ce2262e5e70dd79`. Examinaram-se NBI de tags/tarefas, sanitização/inserção/uniqueKey, faults e persistência CWMP de timestamps. Hashes/trechos em `evidencias/genieacs-source.json`. Essa inspeção não identifica a versão efetivamente implantada, que não foi acessada.

Evidências dirigidas em `implementacao-codex/lote13-b09-acs-2026-10-27/`. Relatório do lote acompanha comandos/resultados e falhas corrigidas. Não se repetiu a auditoria/inventário nem a suíte global.

C/T locais; H/P ausentes. Uma instância ACS configurada por instalação; múltiplos ACS/credenciais por tenant não foram implementados. Modelo/firmware e semântica real de timestamp/PSK dependem de bancada. Perda de resposta sem tarefa localizável nem leitura suficiente continua pendente; não há botão para “assumir sucesso” ou recriar comando. Transferência de propriedade, descarte do journal/PSKs por retenção e resolução administrativa de incerteza sem readback permanecem frentes delimitadas. CWMP TLS/credenciais, NBI privado e hardening do servidor GenieACS também exigem preparação/homologação da instalação; este lote não implantou um ACS.
