update devices d set last_check_at = now(), last_check = jsonb_build_object('ok', n.last_packet_at > now() - interval '15 minutes',
              'detail', case when n.last_packet_at is null then 'nenhum pacote recebido deste concentrador ainda'
                             else 'último pacote recebido em ' || to_char(n.last_packet_at at time zone 'UTC', 'DD/MM HH24:MI') || ' UTC' end)
       from radius_nas n where n.device_id = d.id