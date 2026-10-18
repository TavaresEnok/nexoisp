-- name: Group29ec64410 :many
select a.*, s.name as subscriber_name, s.document as subscriber_document, pu.email as accepted_email
         from acceptances a join subscribers s on s.id = a.subscriber_id left join users pu on pu.id = a.accepted_by where a.id = $1;
