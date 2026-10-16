insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day, start_date, notes, loyalty_until, penalty_model, penalty_cents)
         values ($1,$2,$3,$4,coalesce($5::date, current_date),$6,
                 case when $7::int is null then null else coalesce($5::date, current_date) + make_interval(months => $7::int) end, $8, $9) returning *