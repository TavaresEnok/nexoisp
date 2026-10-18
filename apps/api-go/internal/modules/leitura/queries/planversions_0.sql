-- name: PlanVersions0 :many
select v.*, (select count(*) from contracts c where c.plan_version_id = v.id) as contracts
         from plan_versions v where v.plan_id = $1 order by version desc;
