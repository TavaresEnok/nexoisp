\set ON_ERROR_STOP on
begin;
select set_config('nexo.restore_tenants',coalesce((select jsonb_agg(id)::text from tenants),'[]'),true) as tenants \gset
set local role nexo_go;
do $$
declare tenant text; subscriber uuid; tbl record; leaked bigint;
begin
  if exists(select 1 from pg_roles where pg_has_role(current_user,oid,'MEMBER') and (rolsuper or rolbypassrls)) then
    raise exception 'papel de execução privilegiado';
  end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind in ('r','p') and pg_has_role(current_user,c.relowner,'MEMBER')) then
    raise exception 'papel de execução é dono de tabela';
  end if;
  for tenant in select jsonb_array_elements_text(current_setting('nexo.restore_tenants')::jsonb) loop
    perform set_config('app.tenant_id',tenant,true);
    perform set_config('app.is_operator','off',true);
    perform set_config('app.subscriber_id','',true);
    perform set_config('app.pop_ids','',true);
    for tbl in select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p') and has_table_privilege(current_user,c.oid,'select')
      and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='tenant_id' and not a.attisdropped) loop
      if not tbl.relrowsecurity then raise exception 'RLS ausente: %',tbl.relname; end if;
      execute format('select count(*) from public.%I where tenant_id<>$1::uuid',tbl.relname) into leaked using tenant;
      if leaked<>0 then raise exception 'vazamento entre provedores em %',tbl.relname; end if;
    end loop;
    select id into subscriber from subscribers limit 1;
    if subscriber is not null then
      perform set_config('app.subscriber_id',subscriber::text,true);
      select count(*) into leaked from subscribers where id<>subscriber;
      if leaked<>0 then raise exception 'portal acessou outro assinante'; end if;
      for tbl in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p') and has_table_privilege(current_user,c.oid,'select')
        and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='subscriber_id' and not a.attisdropped) loop
        execute format('select count(*) from public.%I where subscriber_id<>$1',tbl.relname) into leaked using subscriber;
        if leaked<>0 then raise exception 'portal acessou dados de outro assinante em %',tbl.relname; end if;
      end loop;
    end if;
  end loop;
end $$;
rollback;
