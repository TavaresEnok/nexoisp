select r.id, r.desired_policy, k.status from service_resources r join contracts k on k.id = r.contract_id
         where r.device_id = $1 and r.desired_version > 0 and r.secret_enc is not null
           and not exists (select 1 from operations o where o.resource_id = r.id and o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN'))