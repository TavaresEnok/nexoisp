insert into radius_account (tenant_id, username, secret_enc, policy, profile, prev_profile, by_profile, applied_version, updated_at)
       values ($1,$2,pgp_sym_encrypt($3,$4),$5,$6,null,$7,$8,now())
       on conflict (tenant_id, username) do update set secret_enc = excluded.secret_enc, policy = excluded.policy, by_profile = excluded.by_profile,
         prev_profile = case when radius_account.profile <> excluded.profile then radius_account.profile end,
         profile = excluded.profile, applied_version = excluded.applied_version, updated_at = now()