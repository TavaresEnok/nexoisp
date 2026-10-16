select i.due_date as vencimento, s.name as assinante, s.document as cpf_cnpj, i.kind as tipo, to_char(i.competence, 'YYYY-MM') as competencia,
                  i.amount_cents as valor_fatura, (select coalesce(sum(x.signed_cents),0)::int from payments x where x.invoice_id = i.id) as valor_pago,
                  i.status as situacao, to_char(i.paid_at at time zone $3, 'YYYY-MM-DD') as data_pagamento, i.id as fatura
           from invoices i join subscribers s on s.id = i.subscriber_id
           where i.due_date between $1::date and $2::date and ($4::uuid is null or i.company_id = $4) order by i.due_date, i.id