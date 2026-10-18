select to_char(p.paid_at at time zone $3, 'YYYY-MM-DD') as data_pagamento, s.name as assinante, s.document as cpf_cnpj, i.kind as tipo,
                  to_char(i.competence, 'YYYY-MM') as competencia, i.due_date as vencimento, i.amount_cents as valor_fatura, p.signed_cents as valor_pago,
                  p.method as meio, case when p.kind = 'reversal' then 'estorno' else p.source end as origem, coalesce(p.gateway, '') as gateway, coalesce(p.gateway_payment_id, '') as id_pagamento, i.id as fatura
           from payments p join invoices i on i.id = p.invoice_id join subscribers s on s.id = i.subscriber_id
           where (p.paid_at at time zone $3)::date between $1::date and $2::date and ($4::uuid is null or i.company_id = $4) order by p.paid_at, p.id