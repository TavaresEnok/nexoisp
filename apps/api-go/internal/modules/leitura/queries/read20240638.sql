-- name: Read20240638 :many
select b.*, u.name as created_by_name,
                (select count(*) from service_resources r join import_rows ir on ir.batch_id = b.id and ir.external_id = r.external_id
                  where r.external_source = b.source and r.desired_version = 0 and r.secret_enc is not null) as accounts_to_provision
         from import_batches b left join users u on u.id = b.created_by order by b.created_at desc limit 50;
