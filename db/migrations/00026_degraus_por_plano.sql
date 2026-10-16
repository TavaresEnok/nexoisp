-- +goose Up
-- +goose StatementBegin
-- Degraus de inadimplência por plano: avisar, reduzir a velocidade, bloquear. Valores vazios = vale a política do provedor (comportamento anterior).
alter table plans
  add column warn_after_days integer check (warn_after_days between 0 and 365),
  add column reduce_after_days integer check (reduce_after_days between 0 and 365),
  add column block_after_days integer check (block_after_days between 0 and 365),
  add column reduced_profile text check (reduced_profile ~ '^[A-Za-z0-9_.-]{1,60}$'),
  add constraint plans_dunning_order_chk check (
    (warn_after_days is null or reduce_after_days is null or warn_after_days <= reduce_after_days)
    and (reduce_after_days is null or block_after_days is null or reduce_after_days <= block_after_days)
    and (warn_after_days is null or block_after_days is null or warn_after_days <= block_after_days)
    and (reduce_after_days is null or reduced_profile is not null));

-- Em que degrau a conta está agora (vazio = normal). 'blocked' também vale para a suspensão manual.
alter table service_resources
  add column desired_stage text check (desired_stage in ('reduced','blocked')),
  add constraint service_resources_stage_chk check ((desired_stage is null) or desired_policy = 'suspended');
-- +goose StatementEnd
