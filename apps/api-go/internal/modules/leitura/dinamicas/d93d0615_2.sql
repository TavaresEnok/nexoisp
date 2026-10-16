select id, latitude::float8 as lat, longitude::float8 as lng, name, city from pops
           where active and latitude between $1 and $3 and {{lng}} order by name limit 500