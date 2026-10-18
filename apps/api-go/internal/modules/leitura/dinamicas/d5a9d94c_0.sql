select d.id, d.name, d.vendor, host(n.nas_ip) as nas_ip, n.coa_host, n.coa_port, n.last_packet_at,
            (select p.last_handshake_at from vpn_peers p where p.device_id = d.id) as tunnel_handshake_at
     from devices d join radius_nas n on n.device_id = d.id where d.id = $1