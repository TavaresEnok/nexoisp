-- name: Me1 :many
select mfa_enabled from user_self_get($1);
