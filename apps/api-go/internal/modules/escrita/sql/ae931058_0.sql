select 1 from subscribers where id = $1 and anonymized_at is null for update
