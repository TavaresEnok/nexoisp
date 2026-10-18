-- name: Group7cd376611 :many
select count(*)::int as total, count(latitude)::int as located from ftth_boxes;
