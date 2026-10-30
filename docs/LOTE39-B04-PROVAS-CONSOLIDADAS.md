# B04: reconciliação documental do lote 39

A matriz `docs/B04-ACEITE-CORTE-LEITOR.json` conserva as 13 provas anteriores e registra seis provas completas adicionais. Os textos de pendência da execução `6963214` foram preservados como histórico, sem reclassificar a falha `7cde1e6` ou CIs anteriores. As execuções e hashes externos são relatos da gerência no host, materializados integralmente em `docs/evidencias/B04-GATES-B6DF0C3.json`; seus originais não estavam montados nem foram lidos pelo trabalhador.

| Critério | Prova atribuída e limite |
|---|---|
| acordo não comprovado | Migração 65→66 em `01db028c9ad718e6c832d465585984067f4bdc76`, exit 0: fontes ausentes, `source_unproven`, `matches` falso e nenhuma inferência pela nota. |
| importação | Mesma migração: abertura explícita, recebimento assinado e sombra conferidos em título importado não vazio. |
| estorno | Nativo em `75145eec65c92113166339a3c73f5ccccb001e5b` e `b6df0c30913604226c6b473ddfc803a441c4fc57`, exit 0: sinal negativo, residual restaurado e duplicata recusada sem histórico adicional. |
| excesso | Mesmas execuções: excesso positivo e residual zero, sem alterar saldo, recebimentos ou alocações de outro contrato. |
| sem fallback silencioso | Go nas duas execuções acima, exit 0: divergência preserva corpo legado inteiro; testes de log sanitizado em memória e PostgreSQL passaram, sem nota, documento, gateway, segredo ou centavos. |
| matches falso bloqueia corte | Nativo em `b6df0c30913604226c6b473ddfc803a441c4fc57`, exit 0: `verify` exercita candidatura documental com `nexo_app`, tenant próprio, baseline não vazio, drift transacional, recusa e rollback. Não é execução de corte. |

A migração é reuso explícito da execução `01db028`, não corrida nova em `b6df0c3`: ancestralidade e diff vazio dos caminhos da migração foram conferidos no Git. Os quatro hashes de scripts informados no recibo conferem com a worktree. Os resultados dos runners e os hashes dos artefatos externos são atribuídos à gerência, não a leitura direta. Na execução `b6df0c3`, Go registrou 508 ações pass, zero fail e 18 skips de outros testes; nativo teve 26 grupos. A CI candidata 41031703591 estava em andamento quando observada; não se afirma seu resultado final.

A cobertura documental dos 19 critérios não autoriza runtime ou corte, nem homologa dinheiro externo. Allowlists de shadow e cut seguem vazias, `balanceReadDatabaseGate` segue `pending`, leitores com `::int` permanecem restritos e o gate específico para futuro corte continua necessário. Não houve deploy nem homologação externa. Esta entrega não altera produto, DDL, GRANT, escritores ou configuração de runtime. A revisão independente desta reconciliação cabe ao controlador.
