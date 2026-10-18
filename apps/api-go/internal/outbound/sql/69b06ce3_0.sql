select coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo') as tz,
              (select 'messages' = any(modules) from tenants where id = $1) as enabled,
              extract(hour from now() at time zone coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo'))::int as hour,
              extract(dow from now() at time zone coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo'))::int as dow