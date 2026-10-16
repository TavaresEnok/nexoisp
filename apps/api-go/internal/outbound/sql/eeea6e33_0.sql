select s.* from scheduled_changes s
     where s.status = 'pending' and s.effective_date <= (now() at time zone coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo'))::date
     order by s.effective_date, s.created_at limit 50