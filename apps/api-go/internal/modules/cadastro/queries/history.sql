-- name: History :many
select h.at, h.event, h.detail, u.name as actor_name from contract_history h left join users u on u.id = h.actor_id
         where h.contract_id = $1 order by h.id desc;
