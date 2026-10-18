-- name: Read0180ec74 :many
select * from commission_rules where active order by subject, os_kind nulls first;
