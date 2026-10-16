select case when observed_rx_dbm > -7 then '> -7 dBm' when observed_rx_dbm > -16 then '-7 a -16' when observed_rx_dbm > -20 then '-16 a -20'
                       when observed_rx_dbm > -24 then '-20 a -24' when observed_rx_dbm > -28 then '-24 a -28' when observed_rx_dbm > -30 then '-28 a -30' else '< -30 dBm' end as label,
                  count(*)::int as n
           from onus where observed_state = 'authorized' and observed_rx_dbm is not null group by 1 order by min(observed_rx_dbm) desc