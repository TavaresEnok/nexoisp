insert into api_rate (tenant_id, token_id, bucket, n) values ($1,$2,date_trunc('minute', now()),1)
         on conflict (token_id, bucket) do update set n = api_rate.n + 1 returning n