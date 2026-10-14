-- Mapa geográfico: coordenadas do local de instalação do contrato e do POP (as caixas ópticas já tinham).
-- Informadas à mão ou clicando no mapa; o sistema não consulta serviço externo para achar endereço.
alter table contracts
  add column latitude numeric(9,6) check (latitude between -90 and 90),
  add column longitude numeric(9,6) check (longitude between -180 and 180),
  add constraint contracts_location_pair check ((latitude is null) = (longitude is null));
alter table pops
  add column latitude numeric(9,6) check (latitude between -90 and 90),
  add column longitude numeric(9,6) check (longitude between -180 and 180),
  add constraint pops_location_pair check ((latitude is null) = (longitude is null));
-- A consulta do mapa filtra por retângulo visível: índice só nos contratos com coordenada.
create index contracts_location on contracts (tenant_id, latitude, longitude) where latitude is not null;
