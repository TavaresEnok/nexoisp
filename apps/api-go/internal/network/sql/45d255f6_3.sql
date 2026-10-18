update operations set status = 'SUPERSEDED', finished_at = now(), updated_at = now(), note = 'substituída pela versão ' || $2 || ' antes de iniciar'
     where resource_id = $1 and status = 'PENDING'