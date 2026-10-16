-- name: Group35c412841 :many
select at, reply, calling_station, host(nas_ip) as nas_ip from radius_postauth where username = $1 order by id desc limit 50;
