select r.id from service_resources r join contracts k on k.id = r.contract_id
           where r.device_id = $1 and r.desired_version > 0 and r.secret_enc is not null and k.status = 'active'