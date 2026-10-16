-- Exclusivamente para banco descartável de laboratório.
\set ON_ERROR_STOP 1
do $$ begin if current_database() <> 'nexo_contrato_lab' then raise exception 'banco recusado'; end if; end $$;

begin;

-- Usar o seed multi-provedor do laboratório antes deste arquivo.
insert into pops(id,tenant_id,name)
select md5(t.id::text || ':pop:' || n)::uuid,t.id,'POP '||n
from tenants t cross join generate_series(1,2) n where t.slug like 'bench-%'
on conflict do nothing;
update contracts k set pop_id=case when mod(abs(hashtext(k.id::text)::bigint),3)=0 then null
  else md5(k.tenant_id::text || ':pop:' || (1+mod(abs(hashtext(k.id::text)::bigint),2)))::uuid end;

insert into users(id,tenant_id,email,name,password_hash,role,mfa_enabled,subscriber_id)
select md5(t.id::text||':'||r)::uuid,t.id,t.slug||'-'||r||'@contrato.invalid',r,'unused',
  case when r in ('pop','inactive','pending') then case when r='pop' then 'attendant' else 'admin' end else r end,
  r<>'pending',case when r='subscriber' then (select id from subscribers where tenant_id=t.id order by id limit 1) end
from tenants t cross join unnest(array['admin','attendant','finance','noc','subscriber','pop','inactive','pending']) r
where t.slug like 'bench-%' on conflict do nothing;
update users set active=false where email like '%-inactive@contrato.invalid';
insert into user_pops(tenant_id,user_id,pop_id)
select tenant_id,id,md5(tenant_id::text||':pop:1')::uuid from users where email like '%-pop@contrato.invalid' on conflict do nothing;
insert into users(id,email,name,password_hash,role,mfa_enabled)
values (md5('contrato:operator')::uuid,'operator@contrato.invalid','Operador','unused','saas_operator',true) on conflict do nothing;
insert into sessions(user_id,token_hash,expires_at)
select id,encode(digest('contrato:'||id::text,'sha256'),'hex'),now()+interval '12 hours' from users
where email like '%@contrato.invalid' on conflict do nothing;
insert into sessions(user_id,token_hash,expires_at)
select id,encode(digest('expired:'||id::text,'sha256'),'hex'),now()-interval '1 minute' from users
where email like '%-admin@contrato.invalid' on conflict do nothing;
insert into sessions(user_id,token_hash,support_tenant_id,expires_at)
select md5('contrato:operator')::uuid,encode(digest('support:'||t.id::text,'sha256'),'hex'),t.id,now()+interval '12 hours'
from tenants t where slug like 'bench-%' on conflict do nothing;
-- Casos de serialização e CSV: objetos, acentos, fórmulas, aspas, datas e numeric com escala.
update subscribers set name='=Teste; "Árvore"',notes=E'linha 1\nlinha 2',birth_date='1990-01-02',
 custom='{"z":1,"aa":2,"nested":{"html":"<b>&"}}'
where id in (select min(id::text)::uuid from subscribers group by tenant_id);
update contracts set latitude=-3.12345,longitude=-38.54321,custom='{"z":1,"aa":2}',loyalty_until='2027-01-02',penalty_model='fixed',penalty_cents=1000
where id in (select min(id::text)::uuid from contracts group by tenant_id);
delete from contract_history where event='fixture';
insert into contract_history(tenant_id,contract_id,actor_id,event,detail,at)
select tenant_id,id,null,'fixture','{"z":1,"aa":2}', '2026-01-02T03:04:05.123Z' from contracts
where id in (select min(id::text)::uuid from contracts group by tenant_id);

commit;
