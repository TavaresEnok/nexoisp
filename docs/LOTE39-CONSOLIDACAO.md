# Lote 39 — consolidação de provas e triagem

A reconciliação [B04](LOTE39-B04-PROVAS-CONSOLIDADAS.md) registra provas avaliadas para os 19 critérios: 13 anteriores e seis adicionais. A [matriz de aceite](B04-ACEITE-CORTE-LEITOR.json) contém o detalhe por critério, e o [recibo](evidencias/B04-GATES-B6DF0C3.json) atribui as execuções e hashes externos à gerência no host; os originais não estavam montados neste executor. A migração 65→66 foi executada em `01db028c9ad718e6c832d465585984067f4bdc76` e reutilizada com caminhos inalterados, sem nova corrida em `b6df0c3`. Em `b6df0c30913604226c6b473ddfc803a441c4fc57`, o gate de candidatura foi exercitado com drift, recusa e rollback. Isso não é corte em runtime: o gate de banco permanece `pending`, allowlists de shadow e cut vazias e corte não autorizado. As provas também não homologam dinheiro externo; falhas históricas não são reclassificadas.

No mesmo HEAD, a gerência observou PostgreSQL real com Go race: 508 ações pass, zero fail e 18 skips de outros testes; o nativo teve 26 grupos e exit 0. `TestFTTHContratoPG` passou em 0,33 s com `NEXO_FTTH_PG_REQUIRED=1`. O contrato B17 não comprova projeto físico nem benchmark. B15 interno, incluindo journal HTTP, R2 e G, foi publicado em desenvolvimento `01db028` e comprovado conforme gerência; H01 externo permanece aberto, sujeito a WABA, template, versão Graph, recursos e autorização.

A gerência confirmou o push da candidata `dev/lote38-b04-gate-ftth` no SHA `b6df0c3`. O CI `41031703591` para esse SHA foi observado em andamento, com `conclusion: null`; este executor não consultou fonte primária posterior e não afirma conclusão. Main e desenvolvimento permanecem em `01db028` conforme a gerência, até push verificado por ela. Candidata, CI, main, deploy e homologação são estados distintos; nenhum deploy ou homologação decorre destas provas.

A [triagem técnica](LOTE39-TRIAGEM-TECNICA.md) e a [lista estruturada](PENDENCIAS-INTERNAS-APROVADAS.json) não identificaram recorte interno coeso aprovado pronto para programação sem insumos. Ordem de encaminhamento proposta, sem criar implementação presumida:

1. Preservar gates B04 e obter decisão e evidências aplicáveis antes de qualquer inclusão de leitor; não repetir as provas já executadas neste lote.
2. Obter decisões de escopo para AD-17 (regras históricas e liquidação) e AD-18 (transmissão, contrato e leiaute aplicável); especificar trabalho somente se aprovado.
3. Definir especificação e critérios físicos e dados de desempenho para B17/IN-06; o contrato existente já foi executado.
4. Resolver dependências externas conforme prioridade operacional: H01/WABA B15, sandbox Efí B07, bancada ACS/OLT/NAS B09–B11, dados de piloto B13, fiscal B14 e host/cópia externa B12. B01 depende dos artefatos e SHA do CI candidato; B18 depende dos gates e recursos do piloto.

As entregas anteriores e funcionalidades já existentes apontadas na triagem não devem ser reimplementadas. Este lote é documental; não executa suítes de produto. Revisão independente cabe ao controlador.
