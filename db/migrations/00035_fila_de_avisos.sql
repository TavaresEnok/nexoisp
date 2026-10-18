-- +goose Up
-- +goose StatementBegin
-- Avisos ao assinante com fila persistente: o título é enfileirado numa transação curta e o envio acontece FORA de transação,
-- um a um, com o resultado gravado em seguida. Envio interrompido (processo caiu entre enviar e gravar) fica "uncertain" e
-- NÃO é reenviado sozinho: melhor um aviso a conferir do que cobrar o assinante duas vezes.
alter table notice_log drop constraint notice_log_status_check;
alter table notice_log add constraint notice_log_status_check
  check (status in ('queued','sending','sent','failed','uncertain','skipped_no_consent','test'));
alter table notice_log
  add column channel_id uuid,
  add column message text check (char_length(message) <= 600),      -- só enquanto está na fila; apagada ao terminar
  add column claimed_at timestamptz;
create index notice_log_queue on notice_log (tenant_id, id) where status = 'queued';
-- +goose StatementEnd
