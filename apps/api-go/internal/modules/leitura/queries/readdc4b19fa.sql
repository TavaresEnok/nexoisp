-- name: Readdc4b19fa :many
select count(*) filter (where stage = 'new') as new, count(*) filter (where stage = 'contacted') as contacted, count(*) filter (where stage = 'proposal') as proposal,
                count(*) filter (where stage = 'won' and updated_at >= date_trunc('month', now())) as won_month,
                count(*) filter (where stage = 'lost' and updated_at >= date_trunc('month', now())) as lost_month from leads;
