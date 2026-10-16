-- Tipo de acesso da conta: PPPoE (usuário e senha), IPoE (DHCP autorizado pelo RADIUS, identificado pelo MAC) ou hotspot
-- (usuário e senha numa página de acesso). IPoE e hotspot só no RADIUS integrado. No IPoE o "usuário" é o MAC normalizado.
alter table service_resources add column access_type text not null default 'pppoe' check (access_type in ('pppoe','ipoe','hotspot')),
  add constraint service_resources_ipoe_mac check (access_type <> 'ipoe' or pppoe_username ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$');
