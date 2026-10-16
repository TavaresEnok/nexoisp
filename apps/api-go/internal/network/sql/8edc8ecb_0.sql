update service_resources set observed_policy = $2, observed_profile = $3, observed_session = $4, observed_at = $5,
            observed_version = coalesce($6, observed_version)
     where id = $1 and (observed_at is null or observed_at <= $5)