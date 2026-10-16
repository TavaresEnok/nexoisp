# Mutações da fase 1

`./nexo contrato mutacoes` primeiro exige testes normais aprovados e depois compila cada variante separadamente. Erros de compilação e de infraestrutura não contam como detecção; é preciso uma asserção funcional identificada.

| Mutação | Caso que deve falhar |
|---|---|
| tenant_do_cabecalho | TestTenantFromSession |
| sem_set_config | TestPortalRLS |
| set_config_de_sessao | TestScopeIsolationAndRollback |
| sem_pop | TestPopRLS |
| sem_assinante | TestPortalRLS |
| sem_csrf | TestTokenPrecedenceAndCSRF |
| sem_mfa | TestControlOrder |
| sem_modulo | TestControlOrder |
| cache_sem_invalidacao | TestCacheInvalidationAndDisconnect |
| sem_auditoria_negativa | TestControlOrder |
| limite_desligado | TestRate |
| numeric_numero | TestFastifyGolden |
| data_sem_ms | TestFastifyGolden |
| omitempty | TestFastifyGolden |
| zod_mensagem | TestZodGolden |
| dono_do_banco | recusa de partida, sem requisição funcional privilegiada |
| bypassrls | recusa de partida, sem requisição funcional privilegiada |

`auditoria_fora_da_tx` não se aplica nesta fase: `export.csv` e `access.denied` já usam transações próprias no Fastify. O harness compara suas linhas reais em `audit_events`, inclusive suporte.
