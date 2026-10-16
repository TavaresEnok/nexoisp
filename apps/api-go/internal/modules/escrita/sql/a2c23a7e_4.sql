insert into work_orders (tenant_id, number, kind, status, subscriber_id, contract_id, assignee_id, scheduled_for, description, created_by, ticket_id,
                              reason_id, estimated_minutes, address_origin, address_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *