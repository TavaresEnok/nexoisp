select r.*, k.status as contract_status, d.maintenance from service_resources r join contracts k on k.id = r.contract_id
       join devices d on d.id = r.device_id where r.id = $1 for update of r