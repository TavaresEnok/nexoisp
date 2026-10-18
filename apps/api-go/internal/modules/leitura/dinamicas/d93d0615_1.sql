select id, latitude::float8 as lat, longitude::float8 as lng, name, kind, ports, address from ftth_boxes
           where latitude between $1 and $3 and {{lng}} order by name limit 3000