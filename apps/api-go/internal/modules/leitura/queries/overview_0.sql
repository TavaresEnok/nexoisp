-- name: Overview0 :many
select name, document, email, phone, address_street, address_number, address_city, address_state from subscribers where id = $1;
