insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, note, created_by, kind, reversal_of)
                   values ($1,$2,$3,now(),$4,'manual',$5,$6,'reversal',$7)