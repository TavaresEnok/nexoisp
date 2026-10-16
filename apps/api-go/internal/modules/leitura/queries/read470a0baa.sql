-- name: Read470a0baa :many
select row_number as row, external_id, status, messages from import_rows where batch_id = $1 and (status = 'error' or messages <> '[]') order by row_number limit 1000;
