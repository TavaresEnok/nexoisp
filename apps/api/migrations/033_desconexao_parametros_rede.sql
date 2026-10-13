-- Agente 0.5.0: desconexão pedida (D10), parâmetros de rede por plano (R1) e do NAS (R2).
alter table operations drop constraint operations_action_check;
alter table operations add constraint operations_action_check check (action in
  ('subscriber.provision','subscriber.suspend','subscriber.resume','subscriber.disconnect','onu.authorize','onu.deauthorize'));

-- R1: além do perfil do NAS, o plano pode mandar velocidade (com rajada) e pool pelo RADIUS. Vazio = vale o perfil do NAS.
-- Não versionado (como os degraus de cobrança): é política de rede, não preço.
alter table plans
  add column rate_limit text check (rate_limit ~ '^\d{1,7}[kKmM]?/\d{1,7}[kKmM]?( \d{1,7}[kKmM]?/\d{1,7}[kKmM]?){0,3}( [1-8]( \d{1,7}[kKmM]?/\d{1,7}[kKmM]?)?)?$'),
  add column address_pool text check (address_pool ~ '^[A-Za-z0-9_.-]{1,60}$');

-- R2: por equipamento. Uso simultâneo por login e intervalo de accounting (segundos).
alter table devices
  add column simultaneous_use integer check (simultaneous_use between 1 and 10),
  add column acct_interim_seconds integer check (acct_interim_seconds between 60 and 3600);
