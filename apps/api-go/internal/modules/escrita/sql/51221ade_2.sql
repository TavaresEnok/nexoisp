update companies set name = coalesce($2, name), document = case when $3::boolean then $4 else document end,
                is_default = coalesce($5, is_default), active = coalesce($6, active)
         where id = $1 returning id, name, document, is_default, active