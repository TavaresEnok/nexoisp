update agents set status = coalesce($2,status), token_hash = coalesce($3,token_hash),
                cert_fingerprint = case when $4 then null else cert_fingerprint end, cert_pinned_at = case when $4 then null else cert_pinned_at end
         where id = $1 returning id, name, status