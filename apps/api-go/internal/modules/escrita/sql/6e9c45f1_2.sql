insert into satisfaction_surveys (tenant_id, work_order_id, work_order_number, kind, subscriber_id) values ($1,$2,$3,$4,$5)
         on conflict (work_order_id) do nothing