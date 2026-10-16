select (select count(*) from agents where status = 'active' and (last_seen_at is null or last_seen_at <= now() - interval '30 seconds'))::int as agents,
                  (select count(*) from operations where status = 'UNCERTAIN')::int as uncertain,
                  (select count(*) from operations where status in ('FAILED','EXPIRED') and finished_at > now() - interval '24 hours')::int as failed,
                  (select count(*) from onus where desired_state = 'authorized' and observed_at is not null and (observed_state = 'absent' or observed_online is false))::int as onus