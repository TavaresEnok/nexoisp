update service_resources r set observed_policy = a.policy, observed_profile = a.profile, observed_at = now(),
              observed_session = (select jsonb_build_object('online', true, 'ip', x.framed_ip, 'caller_id', x.calling_station, 'since', x.started_at, 'profile', a.profile)
                                  from radius_acct x where x.tenant_id = r.tenant_id and x.username = r.pppoe_username and x.stopped_at is null order by x.started_at desc limit 1)
       from radius_account a, devices d
       where a.tenant_id = r.tenant_id and a.username = r.pppoe_username and d.id = r.device_id and d.driver = 'radius' and r.desired_version > 0
         and r.pppoe_username in (select username from radius_account where $1::timestamptz is null or updated_at > $1
                      union select username from radius_acct where $1::timestamptz is not null and seen_at > $1)