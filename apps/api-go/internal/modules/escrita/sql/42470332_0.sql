insert into tenant_settings (tenant_id, gateway, billing_auto, auto_suspend, suspend_after_days, auto_resume_on_payment, suspension_mode, suspension_profile, updated_by,
           trust_release_enabled, trust_release_days, trust_release_gap_days, late_fee_percent, interest_monthly_percent, prorate_first_month)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         on conflict (tenant_id) do update set gateway = excluded.gateway, billing_auto = excluded.billing_auto, auto_suspend = excluded.auto_suspend,
           suspend_after_days = excluded.suspend_after_days, auto_resume_on_payment = excluded.auto_resume_on_payment,
           suspension_mode = excluded.suspension_mode, suspension_profile = excluded.suspension_profile, updated_by = excluded.updated_by, updated_at = now(),
           trust_release_enabled = excluded.trust_release_enabled, trust_release_days = excluded.trust_release_days, trust_release_gap_days = excluded.trust_release_gap_days,
           late_fee_percent = excluded.late_fee_percent, interest_monthly_percent = excluded.interest_monthly_percent, prorate_first_month = excluded.prorate_first_month
         returning *