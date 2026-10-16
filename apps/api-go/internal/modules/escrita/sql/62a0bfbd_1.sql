select id, name, host(public_cidr) || '/' || masklen(public_cidr) as public_cidr, host(private_cidr) || '/' || masklen(private_cidr) as private_cidr,
                  ports_per_subscriber, port_start, created_at, retired_at
           from cgnat_plans where $1::inet << public_cidr and created_at <= $3 and (retired_at is null or retired_at >= $2) order by created_at