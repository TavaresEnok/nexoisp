select cnpj, ibge_code, case when length(coalesce(document, '')) = 14 then 'PJ' else 'PF' end as tipo_cliente,
                case service_area when 'rural' then 'RURAL' else 'URBANO' end as tipo_atendimento, meio, access_technology as tecnologia,
                round(down_kbps / 1000.0, 2)::float as velocidade_mbps, count(*)::int as acessos
         from (
  with params as (select ($1::date + interval '1 month' - interval '1 day')::date as last_day),
  ativos as (
    select k.id, k.service_area, s.document, coalesce(k.company_id, (select id from companies d where d.is_default and d.active)) as company_id,
           coalesce(nullif(k.install_city, ''), s.address_city) as city, upper(coalesce(nullif(k.install_state, ''), s.address_state)) as state,
           p.access_technology, case p.access_technology when 'FTTH' then 'fibra' when 'FTTB' then 'fibra' when 'HFC' then 'cabo_coaxial' when 'XDSL' then 'cabo_metalico' when 'ETHERNET' then 'cabo_metalico' when 'RADIO' then 'radio' when 'LTE' then 'radio' when 'SATELITE' then 'satelite' when 'OUTRA' then 'outro' end as meio, pv.down_kbps
    from contracts k join subscribers s on s.id = k.subscriber_id join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id, params
    where k.start_date <= params.last_day and (k.status = 'active' or k.end_date > params.last_day))
  select a.*, c.document as cnpj, m.ibge_code
  from ativos a left join companies c on c.id = a.company_id
  left join municipalities m on m.state = a.state and norm_city(m.name) = norm_city(a.city)) x where cnpj is not null and ibge_code is not null and access_technology is not null
         group by 1, 2, 3, 4, 5, 6, 7 order by 1, 2, 3, 4, 6, 7