# API pública v1 e webhooks de saída

Para sistemas **do próprio provedor** (site, ERP, integrador). O que entra pela API vira **atendimento** ou **ordem de serviço**; não há conversa nem caixa de entrada.
Módulo `api`, liberado por provedor em Provedores → Módulos. Tokens e webhooks são criados em **Integrações**.

## Autenticação, escopo e limite

```
Authorization: Bearer nxk_…        (ou X-API-Key: nxk_…)
```

- O token aparece **uma única vez**, na criação; no banco fica só o hash. Revogar vale na hora.
- Cada token tem **escopos** (o mínimo que a aplicação precisa) e um limite de **chamadas por minuto** (padrão 120). Passou do limite: `429` com `Retry-After`.
  Cabeçalhos `X-RateLimit-Limit` e `X-RateLimit-Remaining` em toda resposta.
- Escopos: `subscribers:read`, `contracts:read`, `invoices:read`, `tickets:write`, `work_orders:read`, `work_orders:write`.
- O token só enxerga o provedor que o criou.

## Rotas

| Método e rota | Escopo | Observação |
|---|---|---|
| `GET /public/v1/subscribers?q=&document=&limit=&offset=` | `subscribers:read` | `document` compara só os dígitos |
| `GET /public/v1/subscribers/:id` | `subscribers:read` | |
| `GET /public/v1/contracts?subscriber_id=&status=` | `contracts:read` | `access`: `active`, `suspended` ou nulo (sem conta) |
| `GET /public/v1/invoices?subscriber_id=&contract_id=&status=` | `invoices:read` | |
| `POST /public/v1/tickets` | `tickets:write` | cria atendimento com origem `api`; `201` |
| `POST /public/v1/work-orders` | `work_orders:write` | cria OS; não escolhe responsável nem endereço livre; `201` |
| `GET /public/v1/work-orders/:id` | `work_orders:read` | |

**Repetição segura:** nos `POST`, envie `Idempotency-Key` (até 64 caracteres). A segunda chamada com a mesma chave devolve a resposta da primeira
(`Idempotent-Replay: true`) e **não** cria outro registro. A chave vale por 24 horas.

```bash
curl -sS https://SEU-NEXOISP/public/v1/tickets \
  -H "Authorization: Bearer $NEXO_TOKEN" -H "Idempotency-Key: pedido-123" -H 'content-type: application/json' \
  -d '{"subscriber_id":"…","subject":"Pedido de visita","category":"technical","body":"Sem sinal desde ontem"}'
```

## Webhooks de saída

Cadastre um endereço **HTTPS** e escolha os eventos. Cada evento chega por `POST` JSON:

```json
{ "event": "ticket.created", "created_at": "2026-10-13T15:04:05.000Z", "data": { "ticket_id": "…", "number": 1042, "origin": "api" } }
```

| Evento | `data` |
|---|---|
| `invoice.paid` | `invoice_id`, `contract_id`, `subscriber_id`, `amount_cents`, `paid_at` |
| `access.suspended` / `access.resumed` | `contract_id`, `stage` (`reduced`/`blocked`), `reason` — é a **intenção** registrada; o efeito no equipamento é confirmado pelo agente |
| `ticket.created` | `ticket_id`, `number`, `subscriber_id`, `category`, `priority`, `origin` |
| `work_order.created` | `work_order_id`, `number`, `kind`, `subscriber_id`, `contract_id` |
| `work_order.status_changed` | `work_order_id`, `number`, `from`, `to`, `subscriber_id` |
| `sla.breached` | `entity` (`ticket`/`work_order`), `id`, `number` |
| `survey.answered` | `survey_id`, `score` |

**Assinatura.** Cabeçalhos: `X-Nexo-Event`, `X-Nexo-Delivery`, `X-Nexo-Timestamp` (segundos) e `X-Nexo-Signature: sha256=<hex>`, onde o hex é
`HMAC-SHA256(segredo, "<timestamp>.<corpo bruto>")`. Confira a assinatura e **recuse timestamp com mais de 5 minutos**:

```js
const ok = req.headers['x-nexo-signature'] ===
  'sha256=' + crypto.createHmac('sha256', SEGREDO).update(`${req.headers['x-nexo-timestamp']}.${rawBody}`).digest('hex');
```

**Entrega.** Responda `2xx` em até 8 segundos. Falha repete em 1 min, 5 min, 30 min, 2 h e 12 h (6 tentativas); depois fica como **falhou** e pode ser
reenviada em Integrações → Entregas. A entrega é **pelo menos uma vez**: trate repetição usando `X-Nexo-Delivery`. Não há garantia de ordem entre eventos.
O segredo aparece só ao criar o endpoint e ao trocá-lo.

## O que esta API não é

Não recebe mensagens de assinante, não substitui o portal e não expõe dados de outro provedor. Dados pessoais retornados (documento, telefone, endereço) são os
do cadastro do próprio provedor: guarde o token como credencial e dê o menor escopo possível.
