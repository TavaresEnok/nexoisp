-- +goose Up
-- +goose StatementBegin
-- Reinício da ONU pela OLT (`ont reset` na Huawei): comando pontual que não muda a intenção (versão/estado) da ONU.
alter table operations drop constraint operations_action_check;
alter table operations add constraint operations_action_check check (action in
  ('subscriber.provision','subscriber.suspend','subscriber.resume','subscriber.disconnect','onu.authorize','onu.deauthorize','onu.reboot'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
delete from operations where action = 'onu.reboot';
alter table operations drop constraint operations_action_check;
alter table operations add constraint operations_action_check check (action in
  ('subscriber.provision','subscriber.suspend','subscriber.resume','subscriber.disconnect','onu.authorize','onu.deauthorize'));
-- +goose StatementEnd
