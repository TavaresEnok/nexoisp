-- name: Reada08ddb18 :many
select install_street as street, install_number as number, install_district as district, install_city as city, install_state as state, install_zip as zip
         from contracts where id = $1;
