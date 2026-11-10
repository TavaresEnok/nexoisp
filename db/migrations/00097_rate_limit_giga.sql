-- +goose Up
-- +goose StatementBegin
-- Velocidade do plano também em giga (ex.: 1G/1G), presente nos rate-limit reais estudados (docs/estudo-campo).
alter table plans drop constraint plans_rate_limit_check;
alter table plans add constraint plans_rate_limit_check check (rate_limit ~ '^\d{1,7}[kKmMgG]?/\d{1,7}[kKmMgG]?( \d{1,7}[kKmMgG]?/\d{1,7}[kKmMgG]?){0,3}( [1-8]( \d{1,7}[kKmMgG]?/\d{1,7}[kKmMgG]?)?)?$');
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
alter table plans drop constraint plans_rate_limit_check;
alter table plans add constraint plans_rate_limit_check check (rate_limit ~ '^\d{1,7}[kKmM]?/\d{1,7}[kKmM]?( \d{1,7}[kKmM]?/\d{1,7}[kKmM]?){0,3}( [1-8]( \d{1,7}[kKmM]?/\d{1,7}[kKmM]?)?)?$') not valid;
-- +goose StatementEnd
