select r.id from service_resources r join import_batches b on b.id = $1 and b.source = r.external_source
         join import_rows ir on ir.batch_id = b.id and ir.external_id = r.external_id
         join contracts k on k.id = r.contract_id
         where r.desired_version = 0 and r.secret_enc is not null and k.status = 'active'