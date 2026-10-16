update onus set observed_state = $2, observed_online = $3, observed_rx_dbm = $4, observed_tx_dbm = $5, observed_detail = $6, observed_at = $7,
            observed_version = coalesce($8, observed_version)
     where id = $1 and (observed_at is null or observed_at <= $7)