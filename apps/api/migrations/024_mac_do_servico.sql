-- MAC do assinante vinculado à conta PPPoE (agente 0.4.0+): o RADIUS local só autentica a conta a partir desse equipamento.
-- Vazio = sem vínculo (comportamento anterior). Formato canônico: maiúsculas separadas por dois-pontos, como o RouterOS envia.
alter table service_resources add column mac text check (mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$');
