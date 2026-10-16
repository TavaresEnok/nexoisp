select b.id, b.name, count(*)::int as total, count(*) filter (where n.observed_state = 'absent' or n.observed_online is false)::int as down
         from ftth_drops x join ftth_boxes b on b.id = x.box_id join onus n on n.contract_id = x.contract_id
         where n.desired_state = 'authorized' and n.observed_at is not null group by b.id, b.name having count(*) >= 2