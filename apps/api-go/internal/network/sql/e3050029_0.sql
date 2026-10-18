update operations set status = 'SUCCEEDED', result = $2, finished_at = now(), updated_at = now(), lease_until = null,
                   note = $3 where id = $1