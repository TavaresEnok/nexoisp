update contracts set
           loyalty_until = case when $2::int is null then null else coalesce($3::date, start_date) + make_interval(months => $2::int) end,
           penalty_model = $4, penalty_cents = $5, updated_at = now()
         where id = $1 and status = 'active' returning loyalty_until, penalty_model, penalty_cents