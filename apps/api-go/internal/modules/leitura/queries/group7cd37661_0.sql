-- name: Group7cd376610 :many
select count(*)::int as total, count(latitude)::int as located,
                min(latitude)::float8 as south, max(latitude)::float8 as north, min(longitude)::float8 as west, max(longitude)::float8 as east
         from contracts where status = 'active';
