select d.prefix::text as prefix, d.created_at, k.id as contract_id, s.id as subscriber_id, s.name, s.document, s.phone, s.email,
                  concat_ws(', ', s.address_street, s.address_number, s.address_district, s.address_city, s.address_state) as address
           from ip6_delegations d join contracts k on k.id = d.contract_id join subscribers s on s.id = k.subscriber_id
           where d.prefix >>= $1::inet and d.created_at <= $2