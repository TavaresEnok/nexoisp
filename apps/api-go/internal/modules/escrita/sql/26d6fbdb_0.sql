select r.id from service_resources r join contracts k on k.id = r.contract_id join plan_versions pv on pv.id = k.plan_version_id
       where pv.plan_id = $1 and k.status = 'active' and r.desired_version > 0 and r.desired_policy = 'active' and r.secret_enc is not null
         and not exists (select 1 from operations o where o.resource_id = r.id and o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN'))
       order by r.id limit 500