-- name: Group9fb1f09c0 :many
select count(*)::int as sent, count(*) filter (where answered_at is not null)::int as answered,
                count(*) filter (where answered_at is null and expires_at <= now())::int as expired,
                coalesce(round(avg(score), 2), 0)::float as average,
                count(*) filter (where score >= 4)::int as satisfied
         from satisfaction_surveys;
