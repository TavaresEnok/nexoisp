-- +goose Up
-- +goose StatementBegin
-- SLA com calendário de expediente e feriados por provedor. Políticas marcadas
-- com business_hours contam apenas minutos dentro do expediente; as demais
-- continuam em minutos corridos.
alter table sla_policies add column business_hours boolean not null default false;

create table sla_calendars (
  tenant_id uuid primary key references tenants(id),
  timezone text not null default 'America/Sao_Paulo' check (timezone ~ '^America/[A-Za-z_]+$'),
  -- sete posições, domingo a sábado: {"start": "08:00", "end": "18:00"} ou null (sem expediente)
  hours jsonb not null check (jsonb_typeof(hours) = 'array' and jsonb_array_length(hours) = 7),
  updated_at timestamptz not null default now()
);
create table sla_holidays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  day date not null,
  name text not null check (char_length(name) between 2 and 80),
  unique (tenant_id, day)
);
alter table sla_calendars enable row level security;
alter table sla_holidays enable row level security;
create policy t_sla_calendars on sla_calendars for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_sla_holidays on sla_holidays for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_sla_calendars on sla_calendars as restrictive for all using (app_subscriber() is null);
create policy portal_sla_holidays on sla_holidays as restrictive for all using (app_subscriber() is null);
grant select, insert, update, delete on sla_calendars, sla_holidays to nexo_app;

-- Soma p_minutes a p_start. Com p_business e calendário cadastrado, conta só
-- os minutos dentro do expediente, no fuso do provedor, pulando feriados.
-- Sem calendário (ou sem nenhum dia de expediente em um ano) usa tempo corrido.
create function sla_due(p_tenant uuid, p_start timestamptz, p_minutes int, p_business boolean)
returns timestamptz language plpgsql stable set search_path = public as $$
declare
  cal record;
  remaining numeric := p_minutes * 60;
  cur timestamp;
  d date;
  entry jsonb;
  seg_start timestamp;
  seg_end timestamp;
  available numeric;
begin
  if not p_business then
    return p_start + make_interval(mins => p_minutes);
  end if;
  select timezone, hours into cal from sla_calendars where tenant_id = p_tenant;
  if not found then
    return p_start + make_interval(mins => p_minutes);
  end if;
  cur := p_start at time zone cal.timezone;
  for i in 1..400 loop
    d := cur::date;
    entry := cal.hours -> extract(dow from d)::int;
    if jsonb_typeof(entry) = 'object'
       and not exists (select 1 from sla_holidays h where h.tenant_id = p_tenant and h.day = d) then
      seg_start := greatest(cur, d + (entry ->> 'start')::time);
      seg_end := d + (entry ->> 'end')::time;
      if seg_end > seg_start then
        available := extract(epoch from seg_end - seg_start);
        if available >= remaining then
          return (seg_start + make_interval(secs => remaining)) at time zone cal.timezone;
        end if;
        remaining := remaining - available;
      end if;
    end if;
    cur := (d + 1)::timestamp;
  end loop;
  return p_start + make_interval(mins => p_minutes);
end $$;
grant execute on function sla_due(uuid, timestamptz, int, boolean) to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
drop function sla_due(uuid, timestamptz, int, boolean);
drop table sla_holidays;
drop table sla_calendars;
alter table sla_policies drop column business_hours;
-- +goose StatementEnd
