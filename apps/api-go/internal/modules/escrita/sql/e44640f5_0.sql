select (select count(*) from agents where status = 'active' and (last_seen_at is null or last_seen_at <= now() - interval '30 seconds')) as agents_offline,
                (select count(*) from agents where status = 'active') as agents,
                (select count(*) from operations where status = 'UNCERTAIN') as uncertain,
                (select count(*) from operations where status in ('FAILED','EXPIRED') and finished_at > now() - interval '7 days') as failed_recent,
                (select count(*) from operations where status in ('PENDING','RESERVED','EXECUTING','VERIFYING')) as in_progress,
                (select extract(epoch from now() - min(created_at))::int from operations where status in ('PENDING','UNCERTAIN')) as oldest_pending_s,
                (select count(*) from devices where maintenance) as devices_maintenance,
                (select count(*) from (
  select r.id, r.contract_id, r.device_id, r.pppoe_username, (r.secret_enc is not null) as has_secret,
         r.desired_version, r.desired_policy, r.desired_stage, r.desired_profile, r.desired_reason, r.desired_at,
         r.observed_policy, r.observed_profile, r.observed_session, r.observed_version, r.observed_at, r.mac, r.access_type,
         d.name as device_name, d.driver, d.maintenance, a.id as agent_id, a.name as agent_name, a.last_seen_at as agent_last_seen,
         (a.last_seen_at is not null and a.last_seen_at > now() - interval '30 seconds') as agent_online,
         (r.observed_at is not null and (r.observed_policy <> r.desired_policy or (r.observed_policy = 'active' and r.observed_profile is distinct from r.desired_profile))
           and not exists (select 1 from operations o where o.resource_id = r.id and o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN'))) as drift
  from service_resources r join devices d on d.id = r.device_id left join agents a on a.id = d.agent_id) x where x.drift) as drift