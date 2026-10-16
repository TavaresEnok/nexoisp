-- Massa SINTÉTICA multi-tenant para o LABORATÓRIO (banco nexo_bench com as migrations do NexoISP).
-- Executar como OWNER. Nenhum dado pessoal real: nomes combinados de listas fixas, documentos com prefixo 9
-- (não são CPFs válidos), e-mails no domínio reservado .invalid.
--
-- Variáveis (psql -v):
--   tenants         quantidade de provedores sintéticos           (padrão 40)
--   subscribers     total aproximado de assinantes                (padrão 300000)
--   skew            expoente da distribuição de tamanho (Zipf)    (padrão 1.1: poucos grandes, muitos pequenos)
--   min_per_tenant  mínimo de assinantes por provedor             (padrão 200)
-- Exemplos: 500 mil → -v tenants=200 -v subscribers=500000 ; 5 milhões → -v tenants=2000 -v subscribers=5000000
-- ATENÇÃO: os índices trigram do produto tornam a inserção lenta (ordem de minutos por 100 mil linhas).
\set ON_ERROR_STOP 1
\if :{?tenants}
\else
\set tenants 40
\endif
\if :{?subscribers}
\else
\set subscribers 300000
\endif
\if :{?skew}
\else
\set skew 1.1
\endif
\if :{?min_per_tenant}
\else
\set min_per_tenant 200
\endif

do $$
begin
  if current_database() !~ '(bench|lab)' then
    raise exception 'recusado: o banco "%" não parece de laboratório (nome deve conter bench ou lab)', current_database();
  end if;
  if exists (select 1 from tenants where slug like 'bench-%') then
    raise exception 'já existem tenants bench-*: recrie o banco nexo_bench antes de semear de novo';
  end if;
end $$;

begin;

create temp table bt on commit drop as
with w as (select i, 1.0 / power(i, :skew) as w from generate_series(1, :tenants) i),
     s as (select sum(w) as sw from w)
select i, greatest(:min_per_tenant, round(:subscribers * w / sw))::int as n from w, s;

insert into tenants (name, slug, modules)
select 'Provedor Sintetico ' || lpad(i::text, 4, '0'), 'bench-' || lpad(i::text, 4, '0'), '{}'::text[] from bt order by i;

create temp table btt on commit drop as
select bt.i, bt.n, t.id as tenant_id, t.slug
  from bt join tenants t on t.slug = 'bench-' || lpad(bt.i::text, 4, '0');

insert into plans (tenant_id, name)
select btt.tenant_id, p.name from btt cross join (values ('Fibra 300'), ('Fibra 600'), ('Fibra 1 Giga')) p(name);

insert into plan_versions (tenant_id, plan_id, version, price_cents, down_kbps, up_kbps, profile_name)
select p.tenant_id, p.id, 1,
       case p.name when 'Fibra 300' then 8990 when 'Fibra 600' then 10990 else 14990 end,
       case p.name when 'Fibra 300' then 300000 when 'Fibra 600' then 600000 else 1000000 end,
       case p.name when 'Fibra 300' then 150000 when 'Fibra 600' then 300000 else 500000 end,
       'perfil-' || replace(lower(p.name), ' ', '-')
  from plans p join btt on btt.tenant_id = p.tenant_id;

create temp table bpv on commit drop as
select tenant_id, array_agg(id order by price_cents) as ids from plan_versions
 where tenant_id in (select tenant_id from btt) group by tenant_id;

-- assinantes: h = hash estável (0..2^32-1) para escolhas determinísticas
insert into subscribers (tenant_id, name, document, email, phone, status, created_at)
select g.tenant_id,
       (array['Ana','Bruno','Carla','Diego','Elaine','Fabio','Gabriela','Heitor','Isabela','Joao','Karina','Lucas','Mariana','Nicolas','Olivia','Pedro','Quiteria','Rafael','Sofia','Tiago','Ursula','Vitor','Wesley','Yasmin','Zeca','Alice','Bernardo','Cecilia','Davi','Eduarda','Felipe','Giovana','Henrique','Iara','Jose','Larissa','Miguel','Natalia','Otavio','Paula'])[1 + (g.h % 40)]
       || ' ' || chr(65 + ((g.h / 40) % 26)::int) || '. ' ||
       (array['Silva','Santos','Oliveira','Souza','Rodrigues','Ferreira','Alves','Pereira','Lima','Gomes','Costa','Ribeiro','Martins','Carvalho','Almeida','Lopes','Soares','Fernandes','Vieira','Barbosa','Rocha','Dias','Nascimento','Andrade','Moreira','Nunes','Marques','Machado','Mendes','Freitas','Cardoso','Ramos','Goncalves','Santana','Teixeira','Araujo','Pinto','Correia','Batista','Moura'])[1 + ((g.h / 1040) % 40)],
       '9' || lpad((g.i * 10000000 + g.k)::text, 10, '0'),
       'cliente' || g.k || '@' || g.slug || '.invalid',
       '119' || lpad(((g.h / 7) % 100000000)::text, 8, '0'),
       case when g.h % 20 = 0 then 'inactive' else 'active' end,
       now() - make_interval(days => (g.h % 1500)::int, secs => (g.h % 86400)::int)
  from (select btt.tenant_id, btt.i, btt.slug, k,
               (hashtext(btt.slug || ':' || k)::bigint + 2147483648) as h
          from btt cross join lateral generate_series(1, btt.n) k) g;

-- 1 contrato por assinante (inativo → encerrado) + 20% com um segundo contrato
insert into contracts (tenant_id, subscriber_id, plan_version_id, status, due_day, start_date, end_date, created_at)
select s.tenant_id, s.id, bpv.ids[1 + (x.h % 3)],
       case when s.status = 'inactive' then 'ended' else 'active' end,
       1 + (x.h % 28)::int, s.created_at::date,
       case when s.status = 'inactive' then s.created_at::date + 200 end,
       s.created_at + interval '1 hour'
  from subscribers s
  join bpv on bpv.tenant_id = s.tenant_id
  cross join lateral (select hashtext(s.id::text)::bigint + 2147483648 as h) x;

insert into contracts (tenant_id, subscriber_id, plan_version_id, status, due_day, start_date, created_at)
select s.tenant_id, s.id, bpv.ids[1 + ((x.h / 3) % 3)], 'active', 1 + ((x.h / 7) % 28)::int,
       s.created_at::date + 30, s.created_at + interval '30 days'
  from subscribers s
  join bpv on bpv.tenant_id = s.tenant_id
  cross join lateral (select hashtext('2:' || s.id::text)::bigint + 2147483648 as h) x
 where s.status = 'active' and x.h % 5 = 0;

commit;

vacuum analyze tenants;
vacuum analyze plans;
vacuum analyze plan_versions;
vacuum analyze subscribers;
vacuum analyze contracts;

select count(*) as tenants_bench, sum(n) as assinantes, max(n) as maior, min(n) as menor
  from (select t.id, count(s.*) as n from tenants t left join subscribers s on s.tenant_id = t.id
         where t.slug like 'bench-%' group by t.id) x;
