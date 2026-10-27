# B11 — accounting durável e revisão operacional — 27/10/2026

Continuação de `1d31df5`, no checkout e branch canônicos. Implementação local, sem implantação. Artefatos: `../implementacao-codex/lote15-b11-accounting-2026-10-27/`. A interface oficial e sua referência permanecem preservadas.

## Comportamento entregue

O módulo SQL do FreeRADIUS chama `radius_record_accounting(tenant,source,event)`. O tenant continua vindo do cliente cadastrado pelo servidor; o NAS é comprovado pelo endereço de origem cadastrado nesse tenant. `radius_accounting_events` registra dados permitidos, identidade, resultado, entregas e revisão. A sobrecarga de quatro argumentos é privada: o papel de transporte não pode executar uma revisão administrativa.

Duplicatas concorrentes mantêm uma sessão. Atualizações usam contadores monotônicos e não reabrem sessões fechadas. A geração combina NAS estável, usuário, sessão e início inferido de timestamp/uptime; reinício de NAS tem barreira exclusiva. Start sobreposto sem prova de encerramento/reinício vai à quarentena. Stop antigo não encerra a nova geração. Uma sessão que começa no mesmo segundo de Accounting-On pode ser legítima; repetição da mesma época não a encerra novamente. Sessão sem informação suficiente fica em quarentena, sem inferência ampla por usuário.

O identificador externo deixa de ser a chave global da sessão; o ID interno inclui tenant/NAS/geração. Trocar a origem direta por túnel no mesmo cadastro não troca a identidade do NAS. Operações e observação ao vivo usam esse cadastro, mantendo fallback por origem somente para dados legados sem identidade comprovada. O journal anterior de Disconnect permanece imutável e recuperável pelo mesmo registro congelado.

IPv6 de assinante é armazenado como endereço, prefixo e prefixo delegado separados; tráfego acumulado aceita valores acima de 32 bits. Valores que excedem bigint ou são inválidos vão à quarentena, sem truncamento silencioso. Isso não homologa NAS com transporte IPv6 nem hardware/firmware.

`changed_at` desperta o consumidor inclusive após conciliação. `seen_at` e `radius_nas.last_packet_at` não avançam por revisão administrativa ou fechamento do executor. Recência continua sendo sinal de pacote, sem equivaler a prova de política aplicada. Reinício do consumidor não duplica consumo já persistido.

## API e interface oficial

- `GET /api/radius/accounting/events?status=quarantine&before=<id>`: cursor por ID, até 100 registros; status também aceita applied/ignored. Retorna metadados, nunca permite editar pacote original.
- `POST /api/radius/accounting/events/{event}/reconcile`: justificativa de 10–500 caracteres, reprocessa dados originais somente com identidade de NAS comprovada e inalterada. Já processado retorna resultado estável.
- `POST /api/radius/accounting/events/{event}/dismiss`: arquiva a ocorrência, preserva motivo original/dados e audita a decisão. Não encerra sessão, não muda autorização e não resolve operação incerta.

As rotas exigem network:read/write, tenant integral, ausência de POP/portal/suporte e CSRF para cookie. RLS repete a restrição no banco. A seção de autenticação em `/rede` oferece conciliação, arquivamento fundamentado e navegação para registros antigos, usando os componentes oficiais. Totais são invalidados após a ação. Escopos sem autorização não recebem a seção administrativa.

## Retenção

O purge existente remove no máximo 5.000 eventos processados/ignorados por execução, após `NEXO_RADIUS_EVENT_KEEP_DAYS` (padrão 60, mínimo 35). Quarentena não é eliminada automaticamente. Arquivamento tem auditoria própria. Accounting referenciado por Disconnect ainda reservado/em execução/verificação/incerto não é purgado; a prova exata precisa sobreviver à recuperação. Histórico de uso continua no modelo existente, sem novo ledger financeiro.

## Migração e recuperação

Uma migração aditiva, `db/migrations/00076_radius_accounting_events.sql`. Os registros legados são preservados; NAS só é preenchido quando tenant/origem correspondem ao cadastro atual. Não reconstruir histórico ambíguo nem chamar o backfill de homologação. O FK preserva histórico de NAS: cadastro referenciado não deve ser eliminado fisicamente.

Antes de qualquer futura implantação autorizada: cópia verificável do banco, schema75 e versões de aplicação/configuração recuperáveis; pausar ingresso/consumidor, aplicar76, validar e só então iniciar SQL/consumidor compatíveis. A versão nova depende de76. Reversão operacional deve pausar a funcionalidade e manter os dados/colunas; Down destrutivo é recusado. Não voltar automaticamente ao SQL antigo, que reabre sessões e faz correspondência ampla. Recuperação de desastre exige restauração ensaiada separadamente; os checksums deste lote não provam restauração/PITR.

## Verificação delimitada

- Seis testes únicos no pacote radius passaram com race, incluindo os anteriores afetados; recuperação do consumidor/retenção foram acrescentadas ao cenário integrado. Reexecuções focadas não são novos testes.
- Banco descartável: duplicação concorrente, ordem, reboot/gerações, isolamento e troca de origem do NAS, IPv6/64 bits, revisão/RLS e recência preservada. Dois consumidores/reinício sem duplicar consumo; outra origem não vira observação ao vivo; purge preserva prova de resultado incerto.
- FreeRADIUS3.2.10 efetivo, SQL/configuração do produto e radclient em loopback: Start→Interim→Stop→Start repetido resulta em uma sessão encerrada, com IPv6 e 4.294.967.300 bytes. O SQL anterior, montado apenas no laboratório, reproduz a reabertura e ausência de IPv6. Imagem integrada fixada no digest efetivamente examinado.
- Navegador autenticado: conciliar, repetir, arquivar inválido, validar CSRF, persistência, escopos e atualização dos totais; tela móvel sem rolagem horizontal. Não é certificação visual completa nem homologação de equipamento.
- Go build/vet e Node22 typecheck/build aprovados. Migração final75→76 com pagamento, movimento e sessão legada não vazios preserva checksums dos campos originais; identidade do NAS é preenchida. Sem migração de produção.

C/T locais. H/P ausentes. CI hospedado, carga/SLO de pico, NAS físico, reinício real do NAS, perda de enlace, firmware/vendor e integração pelo túnel real permanecem pendências de homologação. Transporte de NAS via IPv6 e CoA43/vendor específicos não foram homologados por estes pacotes IPv4 de laboratório. Descartar pacote por decisão humana não comprova estado de sessão.
