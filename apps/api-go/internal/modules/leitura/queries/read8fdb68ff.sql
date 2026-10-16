-- name: Read8fdb68ff :many
select id, name, prefix, scopes, rate_limit_per_min, active, expires_at, last_used_at, created_at, revoked_at
         from api_tokens order by revoked_at nulls first, created_at desc;
