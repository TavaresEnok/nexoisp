-- Aviso de manutenção/queda enviado aos assinantes afetados pela fila de mensagens de saída (mesmo canal da régua),
-- disparado pelo operador: um no início e, se ele quiser, outro quando normalizar. Um por assinante, aviso e fase.
alter table notice_log add column maintenance_notice_id uuid, add column phase text check (phase in ('start','resolved')),
  add constraint notice_log_maint_fk foreign key (maintenance_notice_id) references maintenance_notices (id);
create unique index notice_log_maint_once on notice_log (maintenance_notice_id, subscriber_id, phase) where maintenance_notice_id is not null;
alter table maintenance_notices add column notified_start_at timestamptz, add column notified_resolved_at timestamptz;
