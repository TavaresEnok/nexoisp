update operations set status = 'EXPIRED', finished_at = now(), updated_at = now(), note = 'prazo de validade vencido sem execução'
     where status = 'PENDING' and valid_until < now()