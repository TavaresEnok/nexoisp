-- name: Readca6b07f3 :many
select id, name, url, phone_field, message_field, extra_body, active, (headers_enc is not null) as has_headers, created_at from notice_channels order by name;
