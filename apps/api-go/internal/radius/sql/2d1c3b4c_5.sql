update radius_nas n set last_packet_at = greatest(n.last_packet_at, v.last)
       from (select nas_ip, max(at) as last from (select nas_ip, at from radius_postauth where at > coalesce($1, now() - interval '1 day')) z group by nas_ip) v
       where v.nas_ip = n.nas_ip