# Inventário de rotas do Fastify

Gerado a partir do código em `apps/api/src/routes/*.ts`, `app.ts` e `agent-api.ts` (commit de trabalho de 16/10/2026) e revisado à mão nos pontos marcados.
A extração é estática: lê cada declaração `app.get/post/put/patch/delete`, o `guard(...)` da rota, o SQL do corpo do handler e o SQL das funções
auxiliares chamadas (até dois níveis) e das constantes SQL compartilhadas (`CONTRACT_SELECT`, `LEAD_SELECT` etc.).

**Limites da extração (ler antes de usar a tabela):**

- "Tabelas" é uma aproximação por cima: inclui tabelas de funções auxiliares que podem não ser tocadas em todos os caminhos da rota. Rotas com `—` montam a resposta sem SQL direto (configuração, cálculo ou chamada a serviço externo) ou usam funções `security definer`.
- O módulo vem das mesmas expressões regulares de `MODULE_ROUTES` em `auth.ts`. Rotas sem módulo pertencem ao núcleo (sempre liberado).
- "Complexidade" (B/M/A) é heurística: tamanho do handler, número de tabelas, escrita, financeiro, operação de rede, E/S externa e `for update`. Serve para ordenar o trabalho, não para estimar prazo.
- Antes de migrar cada rota, o responsável confirma a linha correspondente lendo o handler. Divergências encontradas devem corrigir esta tabela no mesmo PR.

Legenda — **Tipo**: leitura, leitura + auditoria (grava em `audit_events`) ou escrita. **Cx**: B baixa, M média, A alta. **Fase**: ver `PLANO.md` (1 = piloto, 2 = leituras de maior tráfego, 3 = demais leituras, 4 = escritas simples, 5 = escritas complexas / identidade / rede / API pública, 6 = financeiro, 7 = API de agentes, 8 = permanece no Fastify até o desligamento).

## Resumo

- **344 rotas** HTTP: DELETE 18, GET 149, PATCH 27, POST 128, PUT 22.
- Por tipo: leitura 137, leitura + auditoria 14, escrita 193.
- Por complexidade: B 136, M 183, A 25.
- Por fase sugerida: F1: 3, F2: 12, F3: 104, F4: 115, F5: 81, F6: 18, F7: 10, F8: 1.
- **25 GETs com escrita lateral** (ex.: `sweep()` que expira operações vencidas, contador de uso da API pública, auditoria de relatório). Eles não podem ser tratados como leitura pura: o Go precisa reproduzir o efeito, e o teste de contrato compara também o estado do banco depois da chamada.

| Arquivo | Rotas | Leitura | Escrita | A | Fase predominante |
|---|---:|---:|---:|---:|---|
| `aceites.ts` | 6 | 3 | 3 | 0 | F4 |
| `adicionais.ts` | 6 | 2 | 4 | 0 | F4 |
| `anatel.ts` | 5 | 2 | 3 | 0 | F4 |
| `atendimento.ts` | 12 | 7 | 5 | 1 | F3 |
| `avisos-assinante.ts` | 14 | 4 | 10 | 1 | F4 |
| `cadastro.ts` | 15 | 7 | 8 | 1 | F4 |
| `condicoes.ts` | 13 | 5 | 8 | 0 | F4 |
| `consulta-ip.ts` | 2 | 1 | 1 | 1 | F5 |
| `crm.ts` | 23 | 9 | 14 | 0 | F4 |
| `empresas.ts` | 4 | 1 | 3 | 0 | F4 |
| `escopo-docs.ts` | 9 | 5 | 4 | 0 | F3 |
| `estados.ts` | 5 | 2 | 3 | 0 | F4 |
| `extras.ts` | 9 | 3 | 6 | 1 | F4 |
| `field.ts` | 31 | 12 | 19 | 2 | F4 |
| `finance.ts` | 23 | 10 | 13 | 5 | F6 |
| `fluxo-os.ts` | 15 | 8 | 7 | 0 | F3 |
| `identity.ts` | 16 | 5 | 11 | 0 | F5 |
| `import.ts` | 5 | 2 | 3 | 3 | F6 |
| `integracoes.ts` | 12 | 4 | 8 | 0 | F4 |
| `ipam.ts` | 20 | 11 | 9 | 2 | F3 |
| `lgpd.ts` | 4 | 2 | 2 | 0 | F4 |
| `mapa.ts` | 4 | 2 | 2 | 0 | F3 |
| `network.ts` | 20 | 9 | 11 | 6 | F5 |
| `noc.ts` | 5 | 4 | 1 | 0 | F3 |
| `olt.ts` | 5 | 3 | 2 | 0 | F5 |
| `portal.ts` | 5 | 3 | 2 | 1 | F2 |
| `produtividade.ts` | 13 | 5 | 8 | 0 | F4 |
| `public-api.ts` | 8 | 6 | 2 | 0 | F5 |
| `radius.ts` | 9 | 4 | 5 | 1 | F5 |
| `relatorios.ts` | 5 | 5 | 0 | 0 | F5 |
| `tr069.ts` | 10 | 4 | 6 | 0 | F5 |
| `app.ts` | 1 | 1 | 0 | 0 | F8 |
| `agent-api.ts` | 10 | 0 | 10 | 0 | F7 |

## Rotas e caminhos fora de `/api/*`

O proxy precisa conhecer estes prefixos além de `/api/*` (ver `ARQUITETURA.md`, seção do proxy):

- `/aviso/:slug` — página HTML pública de aviso, com CSP própria.
- `/public/v1/*` — API pública por token (escopos e limite por token gravado no banco, tabela `api_rate`).
- `/agent/v1/*` — API dos agentes, **em outra porta (8443) com mTLS direto na API**, fora do Caddy. Não passa pelo proxy do painel.
- `/api/webhooks/gateway/:gateway` — entrada de pagamentos do gateway (assinatura HMAC, sem sessão). É financeiro: fase 6.
- Exportação CSV: as listas `subscribers`, `contracts`, `invoices`, `work-orders`, `tickets`, `leads`, `stock/items`, `stock/units` e `audit` aceitam `?format=csv` por um hook `onSend` global (`csv.ts`), que também audita `export.csv`. Quem migrar uma dessas listas migra junto o CSV.

## `aceites.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/contracts/:id/acceptances` | `contracts:read` | núcleo | `acceptances`, `users` | leitura | B | F3 |  |
| POST | `/api/contracts/:id/acceptances` | `contracts:write` | núcleo | `acceptances`, `contract_amendments`, `contracts`, `users`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/acceptances/:id/cancel` | `contracts:write` | núcleo | `acceptances`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/acceptances/:id/evidence` | `contracts:read` | núcleo | `acceptances`, `subscribers`, `users` | leitura | B | F3 |  |
| GET | `/api/portal/acceptances` | `portal:self` | núcleo | `acceptances` | leitura | B | F2 |  |
| POST | `/api/portal/acceptances/:id/accept` | `portal:self` | núcleo | `acceptances`, `audit_events` | escrita | M | F4 |  |

## `adicionais.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/addons` | `plans:read` | núcleo | `addon_products`, `contract_addons` | leitura | B | F3 |  |
| POST | `/api/addons` | `plans:write` | núcleo | `addon_products`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/addons/:id` | `plans:write` | núcleo | `addon_products`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/contracts/:id/addons` | `contracts:read` | núcleo | `contract_addons` | leitura | B | F3 |  |
| POST | `/api/contracts/:id/addons` | `contracts:write` | núcleo | `addon_products`, `contract_addons`, `contract_history`, `contracts`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/contracts/:id/addons/:addonId` | `contracts:write` | núcleo | `contract_addons`, `contract_history`, `audit_events` | escrita | M | F4 |  |

## `anatel.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/anatel/dici` | `settings:manage` | núcleo | `companies`, `contracts`, `municipalities`, `plan_versions`, `plans`, `subscribers`, `audit_events` | leitura + auditoria | M | F5 | **GET com escrita lateral** |
| GET | `/api/anatel/municipalities` | `settings:manage` | núcleo | `municipalities` | leitura | B | F3 |  |
| PUT | `/api/anatel/municipalities` | `settings:manage` | núcleo | `municipalities`, `audit_events` | escrita | M | F4 |  |
| PUT | `/api/plans/:id/technology` | `plans:write` | núcleo | `plans`, `audit_events` | escrita | M | F4 |  |
| PUT | `/api/contracts/:id/service-area` | `contracts:write` | núcleo | `contracts`, `audit_events` | escrita | M | F4 |  |

## `atendimento.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/search` | `subscribers:read` | núcleo | `contracts`, `invoices`, `ip_allocations`, `onus`, `plan_versions`, `plans`, `service_resources`, `service_sessions`, `subscribers`, `tickets`, `work_orders` | leitura | M | F3 | toca financeiro |
| GET | `/api/subscribers/:id/timeline` | `subscribers:read` | núcleo | `contract_history`, `contracts`, `invoices`, `operations`, `payments`, `service_resources`, `subscriber_notes`, `subscribers`, `tickets`, `trust_releases`, `users`, `work_orders` | leitura | M | F3 | toca financeiro |
| GET | `/api/contracts/:id/sessions` | `network:read` | núcleo | `service_resources`, `service_sessions`, `sessions`, `tenant_settings`, `users`, `audit_events` | leitura + auditoria | M | F5 | **GET com escrita lateral** |
| GET | `/api/contracts/:id/availability` | `network:read` | núcleo | `service_resources`, `service_sessions`, `sessions`, `tenant_settings`, `users` | leitura | B | F3 |  |
| GET | `/api/network/online` | `network:read` | núcleo | `contracts`, `devices`, `pops`, `service_resources`, `subscribers`, `audit_events` | leitura + auditoria | B | F5 | **GET com escrita lateral** |
| POST | `/api/network/disconnect` | `network:operate` | núcleo | `agents`, `contracts`, `devices`, `ip_allocations`, `onus`, `operations`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `tenants`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | A | F5 | operação de rede (fila) |
| GET | `/api/subscribers/:id/contacts` | `subscribers:read` | núcleo | `subscriber_contacts` | leitura | B | F3 |  |
| PUT | `/api/subscribers/:id/contacts` | `subscribers:write` | núcleo | `subscriber_contacts`, `subscribers`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/pops` | `contracts:read` | núcleo | `contracts`, `pops`, `service_resources` | leitura | B | F3 |  |
| POST | `/api/pops` | `network:write` | núcleo | `pops`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/pops/:id` | `network:write` | núcleo | `pops`, `audit_events` | escrita | M | F4 |  |
| PUT | `/api/contracts/:id/pop` | `contracts:write` | núcleo | `contracts`, `pops`, `audit_events` | escrita | M | F4 |  |

## `avisos-assinante.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/notice-channels` | `settings:manage` | messages | `notice_channels` | leitura | B | F3 |  |
| POST | `/api/notice-channels` | `settings:manage` | messages | `notice_channels`, `audit_events` | escrita | M | F5 | E/S externa |
| PATCH | `/api/notice-channels/:id` | `settings:manage` | messages | `notice_channels`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/notice-channels/:id` | `settings:manage` | messages | `notice_channels`, `notice_rules`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/notice-channels/:id/test` | `settings:manage` | messages | `notice_channels`, `notice_log`, `audit_events` | escrita | M | F5 | E/S externa |
| GET | `/api/notice-templates` | `settings:manage` | messages | `notice_templates` | leitura | B | F3 |  |
| POST | `/api/notice-templates` | `settings:manage` | messages | `notice_templates`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/notice-templates/:id` | `settings:manage` | messages | `notice_rules`, `notice_templates`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/notice-rules` | `settings:manage` | messages | `notice_channels`, `notice_log`, `notice_rules`, `notice_templates` | leitura | B | F3 |  |
| POST | `/api/notice-rules` | `settings:manage` | messages | `notice_channels`, `notice_rules`, `notice_templates`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/notice-rules/:id` | `settings:manage` | messages | `notice_rules`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/notice-rules/:id` | `settings:manage` | messages | `notice_rules`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/notice-rules/run` | `settings:manage` | messages | `contract_tags`, `contracts`, `invoices`, `notice_channels`, `notice_log`, `notice_rules`, `notice_templates`, `payments`, `plan_versions`, `plans`, `subscriber_contacts`, `subscribers`, `tenant_settings`, `tenants`, `audit_events` | escrita | A | F6 | E/S externa; toca financeiro |
| GET | `/api/notice-log` | `settings:manage` | messages | `maintenance_notices`, `notice_log`, `notice_rules`, `subscribers` | leitura | B | F3 |  |

## `cadastro.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/subscribers` | `subscribers:read` | núcleo | `audit_events`, `contracts`, `subscribers` | leitura + auditoria | B | F1 | `?format=csv` grava `export.csv` em transação própria; conferido na fase 1 |
| GET | `/api/subscribers/:id` | `subscribers:read` | núcleo | `contract_tags`, `contracts`, `plan_versions`, `plans`, `subscribers`, `tags` | leitura | B | F1 |  |
| POST | `/api/subscribers` | `subscribers:write` | núcleo | `subscribers`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/subscribers/:id` | `subscribers:write` | núcleo | `subscribers`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/plans` | `plans:read` | núcleo | `contracts`, `plan_versions`, `plans` | leitura | B | F2 |  |
| GET | `/api/plans/:id/versions` | `plans:read` | núcleo | `contracts`, `plan_versions` | leitura | B | F2 |  |
| POST | `/api/plans` | `plans:write` | núcleo | `plan_versions`, `plans`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/plans/:id/versions` | `plans:write` | núcleo | `plan_versions`, `plans`, `audit_events` | escrita | M | F4 |  |
| PUT | `/api/plans/:id/dunning` | `plans:write` | núcleo | `plans`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/plans/:id` | `plans:write` | núcleo | `plans`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/contracts` | `contracts:read` | núcleo | `contract_tags`, `contracts`, `plan_versions`, `plans`, `subscribers`, `tags` | leitura | B | F2 | `?format=csv` + auditoria |
| GET | `/api/contracts/:id` | `contracts:read` | núcleo | `contract_history`, `contract_tags`, `contracts`, `plan_versions`, `plans`, `subscribers`, `tags`, `users` | leitura | B | F1 |  |
| POST | `/api/contracts` | `contracts:write` | núcleo | `contract_history`, `contracts`, `plan_versions`, `plans`, `subscribers`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/contracts/:id` | `contracts:write` | núcleo | `catalog_items`, `contract_history`, `contract_tags`, `contracts`, `invoice_items`, `invoices`, `plan_versions`, `plans`, `subscribers`, `tags`, `tenant_settings`, `audit_events` | escrita | A | F6 | operação de rede (fila); toca financeiro |
| GET | `/api/dashboard` | `subscribers:read` | núcleo | `contracts`, `plan_versions`, `plans`, `subscribers` | leitura | B | F2 |  |

## `condicoes.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| PUT | `/api/plans/:id/loyalty` | `plans:write` | núcleo | `plans`, `audit_events` | escrita | M | F4 |  |
| PUT | `/api/contracts/:id/loyalty` | `contracts:write` | núcleo | `contract_history`, `contracts`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/contracts/:id/termination-quote` | `contracts:read` | núcleo | `contracts`, `invoices`, `tenant_settings` | leitura | B | F3 | toca financeiro |
| GET | `/api/contracts/:id/discounts` | `contracts:read` | núcleo | `contract_discounts`, `users` | leitura | B | F3 |  |
| POST | `/api/contracts/:id/discounts` | `finance:write` | núcleo | `contract_discounts`, `contracts`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/discounts/:id` | `finance:write` | núcleo | `contract_discounts`, `audit_events` | escrita | M | F4 |  |
| PUT | `/api/contracts/:id/referral` | `contracts:write` | núcleo | `contracts`, `subscribers`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/reports/referrals` | `finance:read` | núcleo | `contracts`, `subscribers` | leitura | B | F3 |  |
| GET | `/api/contracts/:id/scheduled-changes` | `contracts:read` | núcleo | `plans`, `scheduled_changes`, `users` | leitura | B | F3 |  |
| POST | `/api/contracts/:id/scheduled-changes` | `contracts:write` | núcleo | `catalog_items`, `contracts`, `plan_versions`, `plans`, `scheduled_changes`, `tenant_settings`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/scheduled-changes/:id` | `contracts:write` | núcleo | `scheduled_changes`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/contracts/:id/amendments` | `contracts:read` | núcleo | `contract_amendments`, `users` | leitura | B | F3 |  |
| POST | `/api/contracts/:id/amendments` | `contracts:write` | núcleo | `contract_amendments`, `contract_history`, `contracts`, `audit_events` | escrita | M | F4 |  |

## `consulta-ip.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| POST | `/api/legal/ip-lookup` | `legal:query` | núcleo | `cgnat_plans`, `contracts`, `ip6_delegations`, `ip_allocations`, `service_resources`, `service_sessions`, `sessions`, `subscribers`, `users`, `audit_events` | escrita | A | F5 |  |
| GET | `/api/legal/ip-lookup/history` | `legal:query` | núcleo | `users`, `audit_events` | leitura | B | F3 |  |

## `crm.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/leads` | `crm:read` | crm | `leads`, `plans`, `subscribers`, `users` | leitura | B | F3 | `?format=csv` + auditoria |
| GET | `/api/leads/summary` | `crm:read` | crm | `leads` | leitura | B | F3 |  |
| GET | `/api/leads/:id` | `crm:read` | crm | `lead_events`, `leads`, `plans`, `subscribers`, `users` | leitura | B | F3 |  |
| POST | `/api/leads` | `crm:write` | crm | `leads`, `users`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/leads/:id` | `crm:write` | crm | `leads`, `users`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/leads/:id/stage` | `crm:write` | crm | `leads`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/leads/:id/notes` | `crm:write` | crm | `leads` | escrita | M | F4 |  |
| POST | `/api/leads/:id/convert` | `crm:write` | crm | `leads`, `subscribers`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/tickets` | `crm:read` | crm | `subscribers`, `ticket_messages`, `tickets`, `users` | leitura | B | F3 | `?format=csv` + auditoria |
| GET | `/api/tickets/:id` | `crm:read` | crm | `subscribers`, `ticket_messages`, `tickets`, `users`, `work_orders` | leitura | B | F3 |  |
| POST | `/api/tickets` | `crm:write` | crm | `catalog_items`, `contracts`, `sla_policies`, `subscribers`, `tenant_counters`, `tenants`, `ticket_messages`, `tickets`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/tickets/:id` | `crm:write` | crm | `catalog_items`, `sla_policies`, `tickets`, `users`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/tickets/:id/messages` | `crm:write` | crm | `ticket_messages`, `tickets` | escrita | M | F4 |  |
| POST | `/api/tickets/:id/status` | `crm:write` | crm | `tickets`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/notifications` | `settings:manage` | notices | `notifications`, `tenant_settings` | leitura | B | F3 |  |
| PUT | `/api/notifications/settings` | `settings:manage` | notices | `tenant_settings`, `audit_events` | escrita | M | F5 | E/S externa |
| POST | `/api/notifications/test` | `settings:manage` | notices | `tenant_settings` | escrita | M | F5 | E/S externa |
| POST | `/api/notifications/deliver` | `settings:manage` | notices | `notifications`, `tenant_settings` | escrita | M | F4 |  |
| GET | `/api/crm/report` | `crm:read` | crm | `leads`, `tenant_settings`, `ticket_messages`, `tickets`, `work_orders` | leitura | B | F3 |  |
| GET | `/api/portal/tickets` | `portal:self` | crm | `tickets` | leitura | B | F2 |  |
| GET | `/api/portal/tickets/:id` | `portal:self` | crm | `ticket_messages`, `tickets` | leitura | B | F2 |  |
| POST | `/api/portal/tickets` | `portal:self` | crm | `notifications`, `sla_policies`, `tenant_counters`, `tenant_settings`, `tenants`, `ticket_messages`, `tickets`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/portal/tickets/:id/messages` | `portal:self` | crm | `notifications`, `tenant_settings`, `ticket_messages`, `tickets` | escrita | M | F4 |  |

## `empresas.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/companies` | `contracts:read` | núcleo | `companies`, `contracts` | leitura | B | F3 |  |
| POST | `/api/companies` | `settings:manage` | núcleo | `companies`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/companies/:id` | `settings:manage` | núcleo | `companies`, `audit_events` | escrita | M | F4 |  |
| PUT | `/api/contracts/:id/company` | `contracts:write` | núcleo | `companies`, `contracts`, `audit_events` | escrita | M | F4 |  |

## `escopo-docs.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/users/:id/pops` | `users:manage` | núcleo | `pops`, `user_pops` | leitura | B | F3 |  |
| PUT | `/api/users/:id/pops` | `users:manage` | núcleo | `pops`, `user_pops`, `users`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/notice-page` | `settings:manage` | núcleo | `tenant_settings`, `tenants` | leitura | B | F3 |  |
| PUT | `/api/notice-page` | `settings:manage` | núcleo | `tenant_settings`, `audit_events` | escrita | M | F4 |  |
| GET | `/aviso/:slug` | `pública` | núcleo | — | leitura | B | F3 |  |
| GET | `/api/subscribers/:id/documents` | `subscribers:read` | núcleo | `documents`, `users` | leitura | B | F3 |  |
| POST | `/api/subscribers/:id/documents` | `subscribers:write` | núcleo | `contracts`, `documents`, `subscribers`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/documents/:id/download` | `subscribers:write` | núcleo | `documents`, `audit_events` | leitura + auditoria | B | F5 | **GET com escrita lateral** |
| DELETE | `/api/documents/:id` | `subscribers:write` | núcleo | `documents`, `audit_events` | escrita | M | F4 |  |

## `estados.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/contracts/:id/states` | `contracts:read` | núcleo | `catalog_items`, `contracts`, `operations`, `service_resources` | leitura | B | F3 |  |
| PUT | `/api/contracts/:id/credit-restriction` | `finance:write` | núcleo | `contract_history`, `contracts`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/subscribers/:id/notes` | `subscribers:read` | núcleo | `catalog_items`, `subscriber_notes`, `users` | leitura | B | F3 |  |
| POST | `/api/subscribers/:id/notes` | `subscribers:write` | núcleo | `catalog_items`, `contracts`, `subscriber_notes`, `subscribers`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/notes/:id` | `subscribers:write` | núcleo | `subscriber_notes`, `audit_events` | escrita | M | F4 |  |

## `extras.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/tags` | `contracts:read` | núcleo | `contract_tags`, `tags` | leitura | B | F3 |  |
| POST | `/api/tags` | `contracts:write` | núcleo | `tags`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/tags/:id` | `contracts:write` | núcleo | `tags`, `audit_events` | escrita | M | F4 |  |
| PUT | `/api/contracts/:id/tags` | `contracts:write` | núcleo | `contract_tags`, `contracts`, `devices`, `maintenance_notices`, `service_resources`, `tags`, `users`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/maintenance-notices` | `network:read` | núcleo | `contracts`, `devices`, `maintenance_notices`, `service_resources`, `users` | leitura | B | F3 |  |
| POST | `/api/maintenance-notices` | `network:write` | núcleo | `contracts`, `devices`, `maintenance_notices`, `service_resources`, `users`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/maintenance-notices/:id/cancel` | `network:write` | núcleo | `maintenance_notices`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/maintenance-notices/channels` | `network:write` | núcleo | `notice_channels` | leitura | B | F3 |  |
| POST | `/api/maintenance-notices/:id/notify` | `network:write` | núcleo | `contract_tags`, `contracts`, `devices`, `invoices`, `maintenance_notices`, `notice_channels`, `notice_log`, `notice_rules`, `notice_templates`, `payments`, `plan_versions`, `plans`, `service_resources`, `subscriber_contacts`, `subscribers`, `tenant_settings`, `tenants`, `users`, `audit_events` | escrita | A | F6 | E/S externa; toca financeiro |

## `field.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/staff` | `os:read` | núcleo | `users` | leitura | B | F3 |  |
| GET | `/api/work-orders` | `os:read` | field | `catalog_items`, `subscribers`, `users`, `work_orders` | leitura | B | F3 | `?format=csv` + auditoria |
| GET | `/api/work-orders/:id` | `os:read` | field | `catalog_items`, `stock_items`, `stock_movements`, `subscribers`, `users`, `work_order_checklist`, `work_order_events`, `work_order_helpers`, `work_orders` | leitura | B | F3 |  |
| POST | `/api/work-orders` | `os:write` | field | `catalog_items`, `contracts`, `notifications`, `sla_policies`, `subscribers`, `tenant_counters`, `tenant_settings`, `tenants`, `tickets`, `users`, `webhook_deliveries`, `webhook_endpoints`, `work_order_events`, `work_orders`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/work-orders/:id` | `os:write` | field | `notifications`, `tenant_settings`, `users`, `work_order_events`, `work_orders`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/work-orders/:id/status` | `os:write` | field | `catalog_items`, `satisfaction_surveys`, `tenants`, `webhook_deliveries`, `webhook_endpoints`, `work_order_events`, `work_orders`, `audit_events` | escrita | A | F5 |  |
| POST | `/api/work-orders/:id/notes` | `os:write` | field | `work_order_events`, `work_orders` | escrita | M | F4 |  |
| POST | `/api/work-orders/:id/materials` | `os:write` | field | `stock_items`, `stock_movements`, `work_order_events`, `work_orders` | escrita | M | F4 |  |
| GET | `/api/stock/items` | `stock:read` | field | `stock_items`, `stock_movements`, `stock_units` | leitura | B | F3 | `?format=csv` + auditoria |
| POST | `/api/stock/items` | `stock:write` | field | `stock_items`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/stock/items/:id` | `stock:write` | field | `stock_items`, `stock_movements`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/stock/items/:id/movements` | `stock:read` | field | `stock_movements`, `users`, `work_orders` | leitura | B | F3 |  |
| POST | `/api/stock/items/:id/movements` | `stock:write` | field | `contracts`, `stock_items`, `stock_movements`, `stock_unit_events`, `stock_units`, `subscribers`, `users`, `work_orders`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/stock/items/:id/units` | `stock:read` | field | `contracts`, `stock_items`, `stock_units`, `subscribers`, `users`, `work_orders` | leitura | B | F3 |  |
| GET | `/api/stock/units` | `stock:read` | field | `contracts`, `stock_items`, `stock_units`, `subscribers`, `users`, `work_orders` | leitura | B | F3 | `?format=csv` + auditoria |
| GET | `/api/stock/units/:id/events` | `stock:read` | field | `stock_unit_events`, `users` | leitura | B | F3 |  |
| POST | `/api/stock/items/:id/units` | `stock:write` | field | `stock_items`, `stock_movements`, `stock_units`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/stock/units/:id/transfer` | `stock:write` | field | `stock_units`, `users` | escrita | M | F4 |  |
| POST | `/api/stock/units/:id/status` | `stock:write` | field | `stock_items`, `stock_movements`, `stock_units`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/work-orders/:id/checklist` | `os:write` | field | `work_order_checklist`, `work_order_events`, `work_orders` | escrita | M | F4 |  |
| POST | `/api/work-orders/:id/checklist/:itemId` | `os:write` | field | `work_order_checklist`, `work_order_events`, `work_orders` | escrita | M | F4 |  |
| GET | `/api/contracts/:id/equipment` | `stock:read` | field | `contracts`, `stock_items`, `stock_units`, `subscribers`, `users`, `work_orders` | leitura | B | F3 |  |
| POST | `/api/work-orders/:id/units` | `os:write` | field | `devices`, `ftth_boxes`, `stock_items`, `stock_movements`, `stock_units`, `work_order_events`, `work_orders` | escrita | A | F5 |  |
| GET | `/api/ftth/boxes` | `network:read` | ftth | `devices`, `ftth_boxes`, `ftth_drops` | leitura | B | F3 |  |
| GET | `/api/ftth/boxes/:id` | `network:read` | ftth | `contracts`, `devices`, `ftth_boxes`, `ftth_drops`, `subscribers` | leitura | B | F3 |  |
| POST | `/api/ftth/boxes` | `network:write` | ftth | `ftth_boxes`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/ftth/boxes/:id` | `network:write` | ftth | `ftth_boxes`, `ftth_drops`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/ftth/boxes/:id` | `network:write` | ftth | `devices`, `ftth_boxes`, `ftth_drops`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/ftth/boxes/:id/drops` | `network:write` | ftth | `contracts`, `ftth_boxes`, `ftth_drops`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/ftth/drops/:id` | `network:write` | ftth | `ftth_drops`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/contracts/:id/ftth` | `network:read` | ftth | `contracts`, `devices`, `ftth_boxes`, `ftth_drops`, `subscribers` | leitura | B | F3 |  |

## `finance.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/finance/settings` | `finance:read` | núcleo | `tenant_settings` | leitura | B | F3 |  |
| PUT | `/api/finance/settings` | `settings:manage` | núcleo | `tenant_settings`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/finance/generate` | `finance:write` | núcleo | `contract_addons`, `contract_discounts`, `contracts`, `invoice_items`, `invoices`, `plan_versions`, `plans`, `tenant_settings`, `audit_events` | escrita | A | F6 | toca financeiro |
| GET | `/api/invoices` | `finance:read` | núcleo | `contracts`, `invoices`, `payments`, `plan_versions`, `plans`, `subscribers`, `tenant_settings` | leitura | B | F3 | `?format=csv` + auditoria; toca financeiro |
| GET | `/api/invoices/:id` | `finance:read` | núcleo | `contracts`, `gateway_events`, `invoice_items`, `invoices`, `payments`, `plan_versions`, `plans`, `subscribers`, `tenant_settings`, `users` | leitura | B | F3 | toca financeiro |
| POST | `/api/invoices` | `finance:write` | núcleo | `contracts`, `invoice_items`, `invoices`, `tenant_settings`, `audit_events` | escrita | M | F6 | toca financeiro |
| POST | `/api/invoices/:id/cancel` | `finance:write` | núcleo | `invoices`, `audit_events` | escrita | M | F6 | toca financeiro |
| POST | `/api/invoices/:id/manual-payment` | `finance:write` | núcleo | `invoice_items`, `invoices`, `payments`, `tenant_settings`, `audit_events` | escrita | M | F6 | toca financeiro |
| GET | `/api/invoices/:id/due` | `finance:read` | núcleo | `invoices`, `payments`, `tenant_settings` | leitura | B | F3 | toca financeiro |
| POST | `/api/invoices/:id/payments/:paymentId/reverse` | `finance:write` | núcleo | `invoices`, `payments`, `audit_events` | escrita | M | F6 | toca financeiro |
| POST | `/api/contracts/:id/agreement` | `finance:write` | núcleo | `agents`, `agreements`, `contracts`, `devices`, `invoice_items`, `invoices`, `ip_allocations`, `operations`, `payments`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `audit_events` | escrita | A | F6 | toca financeiro |
| GET | `/api/contracts/:id/trust-release` | `contracts:read` | núcleo | `contracts`, `service_resources`, `tenant_settings`, `trust_releases`, `users` | leitura | B | F3 | toca financeiro |
| POST | `/api/contracts/:id/trust-release` | `trust:grant` | núcleo | `agents`, `contracts`, `devices`, `ip_allocations`, `operations`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `trust_releases`, `users`, `audit_events` | escrita | A | F6 | toca financeiro |
| POST | `/api/invoices/:id/resolve` | `finance:write` | núcleo | `invoices`, `audit_events` | escrita | A | F6 | toca financeiro |
| GET | `/api/contracts/:id/finance` | `finance:read` | núcleo | `contracts`, `invoices`, `payments`, `plan_versions`, `plans`, `subscribers`, `tenant_settings` | leitura | B | F3 | toca financeiro |
| GET | `/api/finance/summary` | `finance:read` | núcleo | `invoices`, `payments`, `tenant_settings` | leitura | B | F3 | toca financeiro |
| GET | `/api/finance/export` | `finance:read` | núcleo | `invoices`, `payments`, `subscribers`, `tenant_settings`, `audit_events` | leitura + auditoria | B | F5 | **GET com escrita lateral**; toca financeiro |
| GET | `/api/finance/monthly` | `finance:read` | núcleo | `payments`, `tenant_settings` | leitura | B | F3 | toca financeiro |
| GET | `/api/finance/reconciliation` | `finance:read` | núcleo | `contracts`, `gateway_events`, `invoices`, `payments`, `plan_versions`, `plans`, `subscribers`, `tenant_settings` | leitura | B | F3 | toca financeiro |
| POST | `/api/finance/reconcile` | `finance:write` | núcleo | `invoices`, `payments`, `audit_events` | escrita | M | F6 | toca financeiro |
| POST | `/api/finance/run-auto-suspend` | `settings:manage` | núcleo | `agents`, `contracts`, `devices`, `invoices`, `ip_allocations`, `operations`, `payments`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `trust_releases`, `audit_events` | escrita | A | F6 | toca financeiro |
| POST | `/api/webhooks/gateway/:gateway` | `pública` | núcleo | `gateway_events`, `invoices`, `payments` | escrita | M | F6 | toca financeiro |
| POST | `/api/demo-gateway/pay` | `finance:write` | núcleo | `demo_gateway_charges`, `invoices` | escrita | M | F6 | toca financeiro |

## `fluxo-os.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/catalogs` | `subscribers:read` | núcleo | `catalog_items` | leitura | B | F3 |  |
| POST | `/api/catalogs` | `settings:manage` | núcleo | `catalog_items`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/catalogs/:id` | `settings:manage` | núcleo | `catalog_items`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/sla-policies` | `subscribers:read` | crm|field | `catalog_items`, `sla_policies`, `tickets`, `users`, `work_orders` | leitura | B | F3 |  |
| POST | `/api/sla-policies` | `settings:manage` | crm|field | `catalog_items`, `sla_policies`, `users`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/sla-policies/:id` | `settings:manage` | crm|field | `sla_policies`, `users`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/sla-policies/:id` | `settings:manage` | crm|field | `sla_policies`, `tickets`, `work_orders`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/reports/sla` | `subscribers:read` | crm|field | `sla_policies`, `tenant_settings`, `tickets`, `work_orders` | leitura | B | F3 |  |
| GET | `/api/contracts/:id/install-address` | `contracts:read` | núcleo | `contracts` | leitura | B | F3 |  |
| PUT | `/api/contracts/:id/install-address` | `contracts:write` | núcleo | `contracts`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/agenda` | `os:read` | field | `subscribers`, `tenant_settings`, `users`, `work_orders` | leitura | B | F3 |  |
| GET | `/api/agenda/free` | `os:read` | field | `tenant_settings`, `work_orders` | leitura | B | F3 |  |
| GET | `/api/surveys` | `os:read` | field | `satisfaction_surveys`, `subscribers`, `users`, `work_orders` | leitura | B | F3 |  |
| GET | `/api/portal/surveys` | `portal:self` | field | `satisfaction_surveys` | leitura | B | F2 |  |
| POST | `/api/portal/surveys/:id` | `portal:self` | field | `satisfaction_surveys`, `tenants`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | M | F4 |  |

## `identity.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| POST | `/api/auth/login` | `pública` | núcleo | `login_throttle`, `sessions`, `users`, `audit_events` | escrita | M | F5 |  |
| POST | `/api/auth/logout` | (sessão, MFA pendente aceito) | núcleo | `sessions`, `users` | escrita | M | F5 |  |
| GET | `/api/me` | (sessão, MFA pendente aceito) | núcleo | `tenants` | leitura | B | F2 |  |
| POST | `/api/me/password` | (sessão, MFA pendente aceito) | núcleo | `audit_events` | escrita | M | F5 |  |
| POST | `/api/me/mfa/setup` | (sessão, MFA pendente aceito) | núcleo | — | leitura | B | F5 |  |
| POST | `/api/me/mfa/enable` | (sessão, MFA pendente aceito) | núcleo | `audit_events` | escrita | M | F5 |  |
| POST | `/api/me/mfa/disable` | (sessão, MFA pendente aceito) | núcleo | `audit_events` | escrita | M | F5 |  |
| GET | `/api/tenants` | `tenants:manage` | núcleo | `agents`, `operations`, `tenants`, `users` | leitura | B | F3 |  |
| POST | `/api/tenants` | `tenants:manage` | núcleo | `tenants`, `users`, `audit_events` | escrita | M | F5 |  |
| PATCH | `/api/tenants/:id` | `tenants:manage` | núcleo | `tenants`, `audit_events` | escrita | M | F5 |  |
| POST | `/api/support/enter` | `tenants:manage` | núcleo | `sessions`, `tenants`, `users`, `audit_events` | escrita | M | F5 |  |
| POST | `/api/support/exit` | (sessão; só saas_operator) | núcleo | `sessions`, `users`, `audit_events` | escrita | M | F5 |  |
| GET | `/api/users` | `users:manage` | núcleo | `pops`, `user_pops`, `users` | leitura | B | F3 |  |
| POST | `/api/users` | `users:manage` | núcleo | `users`, `audit_events` | escrita | M | F5 |  |
| PATCH | `/api/users/:id` | `users:manage` | núcleo | `users`, `audit_events` | escrita | M | F5 |  |
| GET | `/api/audit` | `audit:read` | núcleo | `users`, `audit_events` | leitura | B | F3 | `?format=csv` + auditoria |

## `import.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| POST | `/api/import/preview` | `import:run` | núcleo | `contract_history`, `contracts`, `devices`, `import_batches`, `import_rows`, `invoice_items`, `invoices`, `payments`, `plan_versions`, `plans`, `service_resources`, `subscriber_contacts`, `subscriber_notes`, `subscribers`, `ticket_messages`, `tickets`, `work_orders`, `audit_events` | escrita | A | F6 | toca financeiro |
| POST | `/api/import/apply` | `import:run` | núcleo | `contract_history`, `contracts`, `devices`, `import_batches`, `import_rows`, `invoice_items`, `invoices`, `payments`, `plan_versions`, `plans`, `service_resources`, `subscriber_contacts`, `subscriber_notes`, `subscribers`, `ticket_messages`, `tickets`, `work_orders`, `audit_events` | escrita | A | F6 | toca financeiro |
| GET | `/api/import/batches` | `import:run` | núcleo | `import_batches`, `import_rows`, `service_resources`, `users` | leitura | B | F3 |  |
| GET | `/api/import/batches/:id` | `import:run` | núcleo | `import_rows` | leitura | B | F3 |  |
| POST | `/api/import/batches/:id/provision` | `import:run` | núcleo | `agents`, `contracts`, `devices`, `import_batches`, `import_rows`, `ip_allocations`, `onus`, `operations`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `tenants`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | A | F5 | operação de rede (fila) |

## `integracoes.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/integrations/catalog` | `settings:manage` | api | — | leitura | B | F3 |  |
| GET | `/api/api-tokens` | `settings:manage` | api | `api_tokens` | leitura | B | F3 |  |
| POST | `/api/api-tokens` | `settings:manage` | api | `api_tokens`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/api-tokens/:id` | `settings:manage` | api | `api_tokens`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/webhook-endpoints` | `settings:manage` | api | `webhook_deliveries`, `webhook_endpoints` | leitura | B | F3 |  |
| POST | `/api/webhook-endpoints` | `settings:manage` | api | `webhook_endpoints`, `audit_events` | escrita | M | F5 | E/S externa |
| PATCH | `/api/webhook-endpoints/:id` | `settings:manage` | api | `webhook_endpoints`, `audit_events` | escrita | M | F5 | E/S externa |
| POST | `/api/webhook-endpoints/:id/rotate-secret` | `settings:manage` | api | `webhook_endpoints`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/webhook-endpoints/:id` | `settings:manage` | api | `webhook_endpoints`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/webhook-endpoints/:id/test` | `settings:manage` | api | `webhook_endpoints` | escrita | M | F5 | E/S externa |
| GET | `/api/webhook-deliveries` | `settings:manage` | api | `webhook_deliveries`, `webhook_endpoints` | leitura | B | F3 |  |
| POST | `/api/webhook-deliveries/:id/retry` | `settings:manage` | api | `api_idempotency`, `api_rate`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | M | F4 |  |

## `ipam.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/ipam/pools` | `network:read` | ipam | `cgnat_plans`, `devices`, `ip6_delegations`, `ip_allocations`, `ip_pools` | leitura | B | F3 |  |
| POST | `/api/ipam/pools` | `network:write` | ipam | `ip_pools`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/ipam/pools/:id` | `network:write` | ipam | `ip_pools`, `audit_events` | escrita | M | F4 |  |
| DELETE | `/api/ipam/pools/:id` | `network:write` | ipam | `cgnat_plans`, `devices`, `ip6_delegations`, `ip_allocations`, `ip_pools`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/ipam/pools/:id/allocations` | `network:read` | ipam | `contracts`, `ip_allocations`, `ip_pools`, `subscribers`, `users` | leitura | B | F3 |  |
| GET | `/api/contracts/:id/ips` | `network:read` | ipam | `contracts`, `ip_allocations`, `ip_pools`, `subscribers`, `users` | leitura | B | F3 |  |
| POST | `/api/ipam/pools/:id/allocations` | `network:write` | ipam | `agents`, `cgnat_plans`, `contracts`, `devices`, `ip6_delegations`, `ip_allocations`, `ip_pools`, `operations`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `audit_events` | escrita | A | F5 |  |
| DELETE | `/api/ipam/allocations/:id` | `network:write` | ipam | `agents`, `contracts`, `devices`, `ip6_delegations`, `ip_allocations`, `ip_pools`, `operations`, `plan_versions`, `plans`, `service_resources`, `subscribers`, `tenant_settings`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/ipam/pools/:id/delegations` | `network:read` | ipam | `contracts`, `ip6_delegations`, `ip_pools`, `subscribers` | leitura | B | F3 |  |
| GET | `/api/contracts/:id/ipv6` | `network:read` | ipam | `contracts`, `ip6_delegations`, `ip_pools`, `subscribers` | leitura | B | F3 |  |
| POST | `/api/ipam/pools/:id/delegations` | `network:write` | ipam | `cgnat_plans`, `contracts`, `devices`, `ip6_delegations`, `ip_allocations`, `ip_pools`, `audit_events` | escrita | A | F5 |  |
| DELETE | `/api/ipam/delegations/:id` | `network:write` | ipam | `ip6_delegations`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/cgnat/plans` | `network:read` | ipam | `cgnat_plans`, `ip_pools`, `users` | leitura | B | F3 |  |
| POST | `/api/cgnat/plans/check` | `network:read` | ipam | — | leitura | B | F4 |  |
| POST | `/api/cgnat/plans` | `network:write` | ipam | `cgnat_plans`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/cgnat/plans/:id/retire` | `network:write` | ipam | `cgnat_plans`, `ip_pools`, `users`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/cgnat/plans/:id/map` | `network:read` | ipam | — | leitura | B | F3 |  |
| GET | `/api/cgnat/plans/:id/script` | `network:write` | ipam | `audit_events` | leitura + auditoria | B | F5 | **GET com escrita lateral** |
| GET | `/api/cgnat/trace` | `network:read` | ipam | `cgnat_plans`, `contracts`, `ip_allocations`, `ip_pools`, `service_resources`, `service_sessions`, `subscribers`, `users`, `audit_events` | leitura + auditoria | M | F5 | **GET com escrita lateral** |
| GET | `/api/cgnat/plans/:id/lookup` | `network:read` | ipam | — | leitura | B | F3 |  |

## `lgpd.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/subscribers/:id/lgpd-export` | `settings:manage` | núcleo | `acceptances`, `contracts`, `documents`, `invoices`, `plan_versions`, `plans`, `service_resources`, `service_sessions`, `subscriber_contacts`, `subscriber_notes`, `subscribers`, `ticket_messages`, `tickets`, `users`, `work_orders`, `audit_events` | leitura + auditoria | M | F5 | **GET com escrita lateral**; toca financeiro |
| POST | `/api/subscribers/:id/anonymize` | `settings:manage` | núcleo | `subscribers` | escrita | M | F4 |  |
| GET | `/api/settings/retention` | `settings:manage` | núcleo | `tenant_settings` | leitura | B | F3 |  |
| PUT | `/api/settings/retention` | `settings:manage` | núcleo | `tenant_settings`, `audit_events` | escrita | M | F4 |  |

## `mapa.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/map/points` | `contracts:read` | núcleo | `contracts`, `ftth_boxes`, `pops`, `service_resources`, `subscribers` | leitura | B | F3 |  |
| GET | `/api/map/coverage` | `contracts:read` | núcleo | `contracts`, `ftth_boxes`, `pops` | leitura | B | F3 |  |
| PUT | `/api/contracts/:id/location` | `contracts:write` | núcleo | `contracts`, `audit_events` | escrita | M | F4 |  |
| PUT | `/api/pops/:id/location` | `network:write` | núcleo | `pops`, `audit_events` | escrita | M | F4 |  |

## `network.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/agents` | `network:read` | núcleo | `agents`, `devices`, `operations` | leitura | B | F3 |  |
| POST | `/api/agents` | `network:write` | núcleo | `agents`, `audit_events` | escrita | M | F5 |  |
| PATCH | `/api/agents/:id` | `network:write` | núcleo | `agents`, `audit_events` | escrita | M | F5 |  |
| GET | `/api/devices` | `network:read` | núcleo | `agents`, `devices`, `l2tp_peers`, `onus`, `radius_nas`, `service_resources`, `vpn_peers` | leitura | B | F3 |  |
| POST | `/api/devices` | `network:write` | núcleo | `devices`, `audit_events` | escrita | M | F5 |  |
| PATCH | `/api/devices/:id` | `network:write` | núcleo | `devices`, `audit_events` | escrita | M | F5 |  |
| POST | `/api/devices/:id/reapply` | `network:write` | núcleo | `agents`, `contracts`, `devices`, `ip_allocations`, `onus`, `operations`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `tenants`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | A | F5 | operação de rede (fila) |
| GET | `/api/contracts/:id/service` | `network:read` | núcleo | `agents`, `devices`, `operations`, `service_resources`, `users` | leitura | B | F5 | **GET com escrita lateral** |
| GET | `/api/contracts/:id/usage` | `network:read` | núcleo | `service_resources`, `sessions`, `usage_monthly`, `users` | leitura | B | F3 |  |
| GET | `/api/contracts/:id/usage-series` | `network:read` | núcleo | `service_resources`, `tenant_settings`, `usage_daily`, `usage_hourly` | leitura | B | F3 |  |
| POST | `/api/contracts/:id/service` | `network:operate` | núcleo | `agents`, `contracts`, `devices`, `ip_allocations`, `onus`, `operations`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `tenants`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | A | F5 | operação de rede (fila) |
| POST | `/api/resources/:id/:action` | `network:operate` | núcleo | `agents`, `contracts`, `devices`, `ip_allocations`, `onus`, `operations`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `tenants`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | A | F5 | operação de rede (fila) |
| PUT | `/api/plans/:id/network` | `network:write` | núcleo | `contracts`, `plan_versions`, `plans`, `service_resources`, `audit_events` | escrita | M | F5 |  |
| POST | `/api/plans/:id/reapply` | `network:operate` | núcleo | `agents`, `contracts`, `devices`, `ip_allocations`, `onus`, `operations`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `tenants`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | A | F5 | operação de rede (fila) |
| PATCH | `/api/resources/:id/mac` | `network:operate` | núcleo | `agents`, `contracts`, `devices`, `ip_allocations`, `onus`, `operations`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `tenants`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | A | F5 | operação de rede (fila) |
| PATCH | `/api/resources/:id/secret` | `network:operate` | núcleo | `agents`, `contracts`, `devices`, `ip_allocations`, `onus`, `operations`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `tenants`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | A | F5 | operação de rede (fila) |
| GET | `/api/operations` | `network:read` | núcleo | `contracts`, `devices`, `onus`, `operations`, `service_resources`, `subscribers` | leitura | B | F5 | **GET com escrita lateral** |
| GET | `/api/operations/:id` | `network:read` | núcleo | `operation_attempts`, `operations` | leitura | B | F5 | **GET com escrita lateral** |
| GET | `/api/network/health` | `network:read` | núcleo | `agents`, `devices`, `operations`, `service_resources` | leitura | B | F5 | **GET com escrita lateral** |
| GET | `/api/network/drift` | `network:read` | núcleo | `agents`, `contracts`, `devices`, `operations`, `service_resources`, `subscribers`, `tenant_settings`, `usage_daily`, `usage_hourly` | leitura | B | F3 |  |

## `noc.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/noc/settings` | `network:read` | noc | `tenant_settings` | leitura | B | F3 |  |
| PUT | `/api/noc/settings` | `network:write` | noc | `tenant_settings`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/noc/overview` | `network:read` | noc | `agents`, `contracts`, `devices`, `ftth_boxes`, `ftth_drops`, `onus`, `operations`, `service_resources`, `subscribers`, `tenant_settings`, `tickets`, `work_orders` | leitura | M | F5 | **GET com escrita lateral** |
| GET | `/api/today` | `subscribers:read` | núcleo | `agents`, `invoices`, `leads`, `onus`, `operations`, `stock_items`, `stock_movements`, `tenant_settings`, `tickets`, `work_orders` | leitura | M | F3 | toca financeiro |
| GET | `/api/contracts/:id/diagnosis` | `network:read` | noc | `agents`, `contracts`, `devices`, `ftth_boxes`, `ftth_drops`, `invoices`, `onus`, `operations`, `service_resources`, `sessions`, `subscribers`, `tenant_settings`, `tickets`, `users`, `work_orders` | leitura | M | F5 | **GET com escrita lateral**; toca financeiro |

## `olt.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/olt/discoveries` | `network:read` | olt | `devices`, `onu_discoveries`, `onus` | leitura | B | F3 |  |
| GET | `/api/onus` | `network:read` | olt | `agents`, `contracts`, `devices`, `onus`, `operations`, `subscribers` | leitura | B | F3 |  |
| GET | `/api/contracts/:id/onu` | `network:read` | olt | `agents`, `contracts`, `devices`, `onus`, `operations`, `subscribers`, `users` | leitura | B | F5 | **GET com escrita lateral** |
| POST | `/api/contracts/:id/onu` | `network:operate` | olt | `contracts`, `devices`, `onus`, `operations`, `audit_events` | escrita | M | F5 |  |
| POST | `/api/onus/:id/:action` | `network:operate` | olt | `contracts`, `devices`, `onus`, `operations`, `audit_events` | escrita | M | F5 |  |

## `portal.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| POST | `/api/subscribers/:id/portal-access` | `subscribers:write` | núcleo | `subscribers`, `users`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/subscribers/:id/portal-access` | `subscribers:read` | núcleo | `users` | leitura | B | F2 |  |
| GET | `/api/portal/overview` | `portal:self` | núcleo | `contracts`, `invoices`, `maintenance_notices`, `plan_versions`, `plans`, `service_resources`, `subscribers`, `tenant_settings`, `trust_releases`, `usage_monthly`, `users` | leitura | M | F2 | toca financeiro |
| GET | `/api/portal/usage-series` | `portal:self` | núcleo | `contracts`, `service_resources`, `tenant_settings`, `usage_daily`, `usage_hourly` | leitura | B | F2 |  |
| POST | `/api/portal/trust-release` | `portal:self` | núcleo | `agents`, `contracts`, `devices`, `ip_allocations`, `operations`, `plan_versions`, `plans`, `service_resources`, `tenant_settings`, `trust_releases`, `users`, `audit_events` | escrita | A | F6 | toca financeiro |

## `produtividade.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/custom-fields` | `subscribers:read` | núcleo | `custom_fields` | leitura | B | F3 |  |
| POST | `/api/custom-fields` | `settings:manage` | núcleo | `custom_fields`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/custom-fields/:id` | `settings:manage` | núcleo | `custom_fields`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/install-kits` | `stock:read` | field | `install_kit_items`, `install_kits`, `stock_items` | leitura | B | F3 |  |
| POST | `/api/install-kits` | `stock:write` | field | `install_kit_items`, `install_kits`, `stock_items`, `audit_events` | escrita | M | F4 |  |
| PATCH | `/api/install-kits/:id` | `stock:write` | field | `install_kits`, `audit_events` | escrita | M | F4 |  |
| POST | `/api/work-orders/:id/kit` | `os:write` | field | `install_kit_items`, `install_kits`, `stock_items`, `stock_movements`, `work_order_events`, `work_orders`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/work-orders/:id/helpers` | `os:read` | field | `users`, `work_order_helpers` | leitura | B | F3 |  |
| POST | `/api/work-orders/:id/helpers` | `os:write` | field | `users`, `work_order_events`, `work_order_helpers`, `work_orders` | escrita | M | F4 |  |
| DELETE | `/api/work-orders/:id/helpers/:userId` | `os:write` | field | `work_order_events`, `work_order_helpers` | escrita | M | F4 |  |
| GET | `/api/commission-rules` | `finance:read` | núcleo | `commission_rules` | leitura | B | F3 |  |
| POST | `/api/commission-rules` | `settings:manage` | núcleo | `commission_rules`, `audit_events` | escrita | M | F4 |  |
| GET | `/api/reports/commissions` | `finance:read` | núcleo | `commission_rules`, `leads`, `tenant_settings`, `users`, `work_order_helpers`, `work_orders`, `audit_events` | leitura + auditoria | M | F5 | **GET com escrita lateral** |

## `public-api.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/public/v1` | `pública` | núcleo | — | leitura | B | F5 |  |
| GET | `/public/v1/subscribers` | `token API: subscribers:read` | núcleo | `api_rate`, `api_tokens`, `login_throttle`, `subscribers` | leitura | B | F5 | **GET com escrita lateral** |
| GET | `/public/v1/subscribers/:id` | `token API: subscribers:read` | núcleo | `api_rate`, `api_tokens`, `login_throttle`, `subscribers` | leitura | B | F5 | **GET com escrita lateral** |
| GET | `/public/v1/contracts` | `token API: contracts:read` | núcleo | `api_rate`, `api_tokens`, `contracts`, `login_throttle`, `plan_versions`, `plans`, `service_resources` | leitura | B | F5 | **GET com escrita lateral** |
| GET | `/public/v1/invoices` | `token API: invoices:read` | núcleo | `api_rate`, `api_tokens`, `invoices`, `login_throttle` | leitura | B | F5 | **GET com escrita lateral**; toca financeiro |
| POST | `/public/v1/tickets` | `token API: tickets:write` | núcleo | `api_rate`, `api_tokens`, `contracts`, `login_throttle`, `notifications`, `sla_policies`, `subscribers`, `tenant_counters`, `tenant_settings`, `tenants`, `ticket_messages`, `tickets`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | M | F5 |  |
| POST | `/public/v1/work-orders` | `token API: work_orders:write` | núcleo | `api_rate`, `api_tokens`, `catalog_items`, `contracts`, `login_throttle`, `notifications`, `sla_policies`, `subscribers`, `tenant_counters`, `tenant_settings`, `tenants`, `tickets`, `users`, `webhook_deliveries`, `webhook_endpoints`, `work_order_events`, `work_orders`, `audit_events` | escrita | M | F5 |  |
| GET | `/public/v1/work-orders/:id` | `token API: work_orders:read` | núcleo | `api_rate`, `api_tokens`, `login_throttle`, `work_orders` | leitura | B | F5 | **GET com escrita lateral** |

## `radius.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/radius/status` | `network:read` | núcleo | `vpn_settings` | leitura | B | F3 |  |
| GET | `/api/radius/allowed-sources` | `network:read` | núcleo | `devices`, `l2tp_peers`, `radius_nas`, `vpn_peers` | leitura | B | F3 |  |
| POST | `/api/radius/devices` | `network:write` | núcleo | `agents`, `devices`, `l2tp_peers`, `radius_nas`, `vpn_peers`, `vpn_settings`, `audit_events` | escrita | M | F5 |  |
| PATCH | `/api/radius/devices/:id` | `network:write` | núcleo | `devices`, `radius_nas`, `vpn_peers`, `audit_events` | escrita | M | F5 |  |
| GET | `/api/radius/devices/:id/setup` | `network:read` | núcleo | `devices`, `l2tp_peers`, `radius_nas`, `vpn_peers`, `vpn_settings` | leitura | B | F3 |  |
| POST | `/api/radius/devices/:id/secret` | `network:write` | núcleo | `devices`, `l2tp_peers`, `radius_nas`, `vpn_peers`, `vpn_settings`, `audit_events` | escrita | M | F5 |  |
| POST | `/api/radius/devices/:id/tunnel` | `network:write` | núcleo | `devices`, `l2tp_peers`, `radius_nas`, `vpn_peers`, `vpn_settings`, `audit_events` | escrita | M | F5 |  |
| POST | `/api/devices/:id/convert-to-integrated` | `network:write` | núcleo | `agents`, `contracts`, `devices`, `ip_allocations`, `l2tp_peers`, `onus`, `operations`, `plan_versions`, `plans`, `radius_nas`, `service_resources`, `tenant_settings`, `tenants`, `vpn_peers`, `vpn_settings`, `webhook_deliveries`, `webhook_endpoints`, `audit_events` | escrita | A | F5 | operação de rede (fila) |
| GET | `/api/contracts/:id/radius-log` | `network:read` | núcleo | `devices`, `radius_postauth`, `service_resources` | leitura | B | F3 |  |

## `relatorios.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/finance/reports/aging` | `finance:read` | núcleo | `contract_tags`, `contracts`, `invoices`, `payments`, `plan_versions`, `tenant_settings`, `audit_events` | leitura + auditoria | B | F5 | **GET com escrita lateral**; toca financeiro |
| GET | `/api/finance/reports/receipts` | `finance:read` | núcleo | `contracts`, `invoices`, `payments`, `plan_versions`, `plans`, `tenant_settings`, `audit_events` | leitura + auditoria | B | F5 | **GET com escrita lateral**; toca financeiro |
| GET | `/api/finance/reports/without-invoice` | `finance:read` | núcleo | `contracts`, `invoices`, `plan_versions`, `plans`, `subscribers`, `tenant_settings`, `audit_events` | leitura + auditoria | B | F5 | **GET com escrita lateral**; toca financeiro |
| GET | `/api/finance/reports/to-cancel` | `finance:read` | núcleo | `contracts`, `invoices`, `plan_versions`, `plans`, `subscribers`, `tenant_settings`, `audit_events` | leitura + auditoria | B | F5 | **GET com escrita lateral**; toca financeiro |
| GET | `/api/dashboard/panels` | `network:read` | núcleo | `contracts`, `invoices`, `onus`, `operations`, `payments`, `plan_versions`, `service_resources`, `service_sessions`, `subscribers`, `tenant_settings` | leitura | M | F3 | toca financeiro |

## `tr069.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/acs/status` | `network:read` | núcleo | — | leitura | B | F3 |  |
| GET | `/api/contracts/:id/cpe` | `network:read` | núcleo | `contracts`, `cpe_links` | leitura | M | F5 | E/S externa |
| GET | `/api/contracts/:id/cpe/candidates` | `network:operate` | núcleo | `contracts`, `service_resources` | leitura | M | F5 | E/S externa |
| POST | `/api/contracts/:id/cpe/link` | `network:operate` | núcleo | `cpe_links`, `service_resources`, `audit_events` | escrita | M | F5 | E/S externa |
| DELETE | `/api/contracts/:id/cpe/link` | `network:operate` | núcleo | `cpe_links`, `audit_events` | escrita | M | F5 | E/S externa |
| POST | `/api/contracts/:id/cpe/wifi` | `network:operate` | núcleo | `audit_events` | escrita | M | F5 |  |
| POST | `/api/contracts/:id/cpe/reboot` | `network:operate` | núcleo | `audit_events` | escrita | M | F5 | E/S externa |
| POST | `/api/contracts/:id/cpe/refresh` | `network:operate` | núcleo | `audit_events` | escrita | M | F5 | E/S externa |
| GET | `/api/portal/cpe` | `portal:self` | núcleo | `contracts`, `cpe_links` | leitura | M | F5 | E/S externa |
| POST | `/api/portal/cpe/:contractId/wifi` | `portal:self` | núcleo | `contracts`, `cpe_links`, `audit_events` | escrita | M | F5 |  |

## `app.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/health` | `pública` | núcleo | — | leitura | B | F8 |  |

## `agent-api.ts`

| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |
|---|---|---|---|---|---|---|---|---|
| POST | `/agent/v1/hello` | `mTLS do agente` | núcleo | `agents`, `devices`, `onus`, `service_resources`, `sessions`, `users` | escrita | M | F7 |  |
| POST | `/agent/v1/sync-done` | `mTLS do agente` | núcleo | `agents`, `service_resources`, `sessions`, `users` | escrita | M | F7 |  |
| POST | `/agent/v1/poll` | `mTLS do agente` | núcleo | `agents`, `devices`, `operation_attempts`, `operations`, `sessions`, `users` | escrita | M | F7 |  |
| POST | `/agent/v1/attempts/:id/begin` | `mTLS do agente` | núcleo | `contracts`, `devices`, `onus`, `operation_attempts`, `operations`, `service_resources` | escrita | M | F7 |  |
| POST | `/agent/v1/attempts/:id/progress` | `mTLS do agente` | núcleo | `operation_attempts`, `operations` | escrita | M | F7 |  |
| POST | `/agent/v1/attempts/:id/result` | `mTLS do agente` | núcleo | `onus`, `operation_attempts`, `operations`, `service_resources`, `audit_events` | escrita | M | F7 |  |
| POST | `/agent/v1/olt-report` | `mTLS do agente` | núcleo | `devices`, `onu_discoveries`, `onus` | escrita | M | F7 |  |
| POST | `/agent/v1/usage-report` | `mTLS do agente` | núcleo | `devices`, `service_resources`, `sessions`, `usage_monthly`, `users` | escrita | M | F7 |  |
| POST | `/agent/v1/sessions-report` | `mTLS do agente` | núcleo | `devices`, `service_resources`, `service_sessions`, `sessions`, `users` | escrita | M | F7 |  |
| POST | `/agent/v1/observations` | `mTLS do agente` | núcleo | `agents`, `devices`, `onu_discoveries`, `onus`, `service_resources`, `service_sessions`, `sessions`, `usage_monthly`, `users`, `audit_events` | escrita | M | F7 |  |

## Acoplamentos que a tabela não mostra

Estes efeitos atravessam rotas e precisam ser portados junto com a primeira rota que os dispara (e testados no contrato pelo estado do banco):

- **`contractChangeHooks`** (`hooks.ts`): `changeContract()` executa, na mesma transação, ganchos registrados por `network.ts` e `olt.ts`. Trocar plano, vencimento ou encerrar contrato pode **gerar operação de rede** (`operations`) e mudar ONU, mesmo em rotas de `cadastro.ts`. Também é usado pelas mudanças agendadas (`scheduled.ts`).
- **`emitEvent()`** (`webhooks.ts`): grava em `webhook_deliveries` (saída de webhooks) na transação da rota, se o provedor tem o módulo `api` e um endpoint inscrito no evento. Funciona como uma fila de saída: a entrega é feita depois, pela rotina periódica.
- **`queueNotice()`** (`notify.ts`): grava em `notifications` para envio posterior.
- **`audit()`** (`auth.ts`): grava em `audit_events` na transação da rota, ou em transação própria quando chamada fora dela (ex.: negativa de permissão no `guard`, que também é auditada).
- **`sweep()`** (`network/engine.ts`): expira operações e tentativas vencidas; é chamada por leituras (`GET /api/operations`, `GET /api/noc/overview` e outras) e pela reserva do executor.
- **`nextNumber()`** (`db.ts`): contador por provedor em `tenant_counters` (número de OS e protocolo), dentro da transação.

## Rotinas sem rota HTTP (não são roteadas pelo proxy)

Rodam dentro do processo da API Fastify hoje e só mudam de lugar na fase 7 (River). Até lá continuam no Node.

| Rotina | Arquivo | Frequência atual | Trava | Escreve em |
|---|---|---|---|---|
| Rotina periódica (cobrança automática, reconciliação, alertas de plataforma, entrega de avisos e webhooks, limpeza de throttle) | `worker.ts`, `finance/core.ts`, `notify.ts`, `webhooks.ts` | 60 s | `pg_try_advisory_lock(7411002)` | `invoices`, `payments`, `notifications`, `webhook_deliveries`, `login_throttle` e outras |
| Executor do RADIUS integrado (fila de operações → `radius_*` + desconexão CoA) | `radius/executor.ts`, `network/engine.ts` | 2 s (contabilização a cada ~14 s) | `for update ... skip locked` na reserva | `operations`, `operation_attempts`, `radius_account`, `radius_check`, `radius_reply`, `service_sessions`, `usage_*` |
| Mudanças de contrato agendadas | `scheduled.ts` | chamada pela rotina periódica | transação por mudança | `scheduled_changes`, `contracts`, `contract_history`, `invoices` |
| SLA de chamados e OS | `sla.ts` | chamada pela rotina periódica | — | `tickets`, `work_orders` |
| Avisos ao assinante | `notices.ts` | chamada pela rotina periódica | — | `notice_log` |
| Serviço de túnel (WireGuard/L2TP) | `vpn.ts` | processo próprio (serviço `vpn`) | — | `vpn_peers`, `l2tp_peers` — **mantido em Node** (fora do escopo) |
