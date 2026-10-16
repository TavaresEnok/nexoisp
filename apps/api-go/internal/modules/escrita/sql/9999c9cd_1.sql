insert into users (tenant_id, email, name, password_hash, role, subscriber_id) values ($1,$2,$3,$4,'subscriber',$5)
         on conflict (subscriber_id) where subscriber_id is not null do update set email = excluded.email, password_hash = excluded.password_hash, active = true
         returning id, email