-- name: Groupb01b24910 :many
select retention_auth_log_days, retention_sessions_days, retention_notice_log_days from tenant_settings where tenant_id = $1;
