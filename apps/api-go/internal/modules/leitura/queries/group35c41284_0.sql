-- name: Group35c412840 :many
select r.pppoe_username, d.driver from service_resources r join devices d on d.id = r.device_id where r.contract_id = $1;
