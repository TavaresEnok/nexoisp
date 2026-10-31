update service_resources r set observed_policy = a.policy, observed_profile = a.profile, observed_at = now(),
              observed_session = (select jsonb_build_object('online', true, 'ip', x.framed_ip, 'caller_id', x.calling_station, 'since', x.started_at, 'profile', a.profile, 'ipv6_address',host(x.framed_ipv6_address),'ipv6_prefix',x.framed_ipv6_prefix::text,'delegated_ipv6_prefix',x.delegated_ipv6_prefix::text)
                                  from radius_acct x where x.tenant_id = r.tenant_id and x.username = r.pppoe_username and x.stopped_at is null and (x.nas_device_id=r.device_id or (x.nas_device_id is null and x.nas_ip=(select n.nas_ip from radius_nas n where n.device_id=r.device_id))) order by x.started_at desc limit 1)
       from radius_account a, devices d
       where a.tenant_id = r.tenant_id and a.username = r.pppoe_username and d.id = r.device_id and d.driver = 'radius' and r.desired_version > 0
         and r.pppoe_username in (select username from radius_account where $1::timestamptz is null or updated_at > $1
                      union select username from radius_acct where ($1::timestamptz is not null and changed_at > $1) or id in (select accounting_id from r05_accounting_batch))
