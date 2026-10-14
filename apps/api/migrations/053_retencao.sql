-- Retenção por provedor (vazio = padrão da instalação). Os mínimos ficam no banco: registro de conexão não pode ficar abaixo de 1 ano
-- (Marco Civil, art. 13) e o log de autenticação, abaixo de 7 dias (o atendimento usa).
alter table tenant_settings
  add column retention_auth_log_days integer check (retention_auth_log_days between 7 and 365),
  add column retention_sessions_days integer check (retention_sessions_days between 365 and 1825),
  add column retention_notice_log_days integer check (retention_notice_log_days between 30 and 1825);
-- a limpeza por prazo (rotina periódica, escopo do provedor) apaga registros de aviso já concluídos
grant delete on notice_log to nexo_app;
