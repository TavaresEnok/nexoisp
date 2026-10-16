update satisfaction_surveys set score = $3, comment = $4, answered_at = now()
         where id = $1 and subscriber_id = $2 and answered_at is null and expires_at > now() returning id, score