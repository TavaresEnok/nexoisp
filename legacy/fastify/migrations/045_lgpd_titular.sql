-- LGPD: anonimização de titular (direito de eliminação, com a retenção que a lei exige).
-- Fica o que o provedor é obrigado a guardar (faturas e pagamentos, registros de conexão pelo prazo configurado, aceites assinados);
-- sai o que identifica a pessoa fora disso. Tudo numa função só, com a conferência do provedor feita aqui dentro.
alter table subscribers add column anonymized_at timestamptz, add column anonymized_reason text check (char_length(anonymized_reason) <= 300);

create function lgpd_anonymize_subscriber(p_id uuid, p_reason text, p_actor uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app_tenant();
  v_sub subscribers%rowtype;
  v_n jsonb := '{}'::jsonb;
  v_c integer;
begin
  if v_tenant is null then raise exception 'sem provedor no contexto' using errcode = '42501'; end if;
  select * into v_sub from subscribers where id = p_id and tenant_id = v_tenant for update;
  if not found then raise exception 'assinante não encontrado' using errcode = 'P0002'; end if;
  if v_sub.anonymized_at is not null then raise exception 'este titular já foi anonimizado' using errcode = 'P0001'; end if;
  if exists (select 1 from contracts where subscriber_id = p_id and status = 'active') then
    raise exception 'há contrato vigente: encerre os contratos antes de anonimizar' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices where subscriber_id = p_id and status in ('open', 'reconciling')) then
    raise exception 'há faturas em aberto ou em conciliação: resolva-as antes de anonimizar' using errcode = 'P0001'; end if;

  update subscribers set name = 'Titular anonimizado', document = null, email = null, phone = null,
         address_street = null, address_number = null, address_district = null, address_city = null, address_state = null, address_zip = null,
         notes = null, birth_date = null, rg = null, rg_issuer = null, mother_name = null, trade_name = null, custom = '{}'::jsonb,
         external_source = null, external_id = null, status = 'inactive', anonymized_at = now(), anonymized_reason = p_reason, updated_at = now()
   where id = p_id;
  delete from subscriber_contacts where subscriber_id = p_id;                                   get diagnostics v_c = row_count; v_n := v_n || jsonb_build_object('contacts', v_c);
  update subscriber_notes set body = '[removido a pedido do titular]', alert = false where subscriber_id = p_id; get diagnostics v_c = row_count; v_n := v_n || jsonb_build_object('notes', v_c);
  update documents set content = null, deleted_at = coalesce(deleted_at, now()), name = '[removido]' where subscriber_id = p_id and content is not null;
                                                                                                get diagnostics v_c = row_count; v_n := v_n || jsonb_build_object('documents', v_c);
  update contracts set install_street = null, install_number = null, install_district = null, install_city = null, install_state = null, install_zip = null,
         latitude = null, longitude = null, notes = null where subscriber_id = p_id;
  update work_orders set address_text = null where subscriber_id = p_id;
  update tickets set subject = '[removido a pedido do titular]' where subscriber_id = p_id;
  update ticket_messages set body = '[conteúdo removido a pedido do titular]' where ticket_id in (select id from tickets where subscriber_id = p_id);
  get diagnostics v_c = row_count; v_n := v_n || jsonb_build_object('ticket_messages', v_c);
  update notice_log set contact_value = null where subscriber_id = p_id;
  -- prospecto convertido: a ficha comercial também sai (o prospecto exige um contato, então fica um endereço inválido)
  update leads set name = 'Titular anonimizado', phone = null, email = 'removido@anonimizado.invalid', document = null,
         address_street = null, address_number = null, address_district = null, address_city = null, address_state = null, address_zip = null, notes = null
   where subscriber_id = p_id;
  -- acesso ao portal: desativado, sem e-mail e sem senha utilizável; sessões abertas caem
  delete from sessions where user_id in (select id from users where subscriber_id = p_id);
  update users set active = false, name = 'Titular anonimizado', email = 'anonimizado-' || id || '@anonimizado.invalid', password_hash = '!' where subscriber_id = p_id;
  insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, result, detail)
    values (v_tenant, 'user', p_actor, 'subscriber.anonymize', 'subscriber', p_id, 'ok', jsonb_build_object('reason', p_reason, 'counts', v_n));
  return v_n;
end $$;
revoke execute on function lgpd_anonymize_subscriber(uuid, text, uuid) from public;
grant execute on function lgpd_anonymize_subscriber(uuid, text, uuid) to nexo_app;
