-- name: PortalAccess0 :many
select email, active from users where subscriber_id = $1;
