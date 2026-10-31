-- +goose Up
-- +goose StatementBegin
create or replace function invoice_settlement_version() returns trigger language plpgsql as $$
begin
 if TG_OP='INSERT' then
  new.settlement_version=0;
 else
  new.settlement_version=old.settlement_version+case
   when new.status='paid' and old.status<>'paid'
    and coalesce(current_setting('nexo.reversal_reclassification', true),'') <> 'on' then 1 else 0 end;
 end if;
 return new;
end $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
create or replace function invoice_settlement_version() returns trigger language plpgsql as $$
begin
 if TG_OP='INSERT' then new.settlement_version=0;
 else new.settlement_version=old.settlement_version+case when new.status='paid' and old.status<>'paid' then 1 else 0 end;
 end if;
 return new;
end $$;
-- +goose StatementEnd
