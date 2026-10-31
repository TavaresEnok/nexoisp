update invoices i set status = $3, status_note = $2,
 paid_at = case when $3 = 'paid' then
   (select max(p.paid_at) from payments p where p.invoice_id = i.id and p.kind = 'payment'
      and p.amount_cents::bigint > coalesce((select sum(r.amount_cents) from payments r where r.reversal_of = p.id),0))
 else null end
where i.id = $1
