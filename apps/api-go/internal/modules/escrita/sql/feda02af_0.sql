insert into api_tokens (tenant_id, name, token_hash, prefix, scopes, rate_limit_per_min, expires_at, created_by)
         values ($1,$2,$3,$4,$5,$6, case when $7::int is null then null else now() + make_interval(days => $7::int) end, $8)
         on conflict (tenant_id, name) do nothing returning id, name, prefix, scopes, rate_limit_per_min, expires_at