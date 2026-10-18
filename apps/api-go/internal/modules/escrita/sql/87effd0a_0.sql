insert into webhook_endpoints (tenant_id, name, url, secret_enc, events) values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, name) do nothing returning id, name, url, events, active