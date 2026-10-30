# Lote 43 — correções de entrega

O CI 41068033843 falhou no frontend: LOTE40 estava validado na matriz sem registro por unidade. Go/build/vet/race/lint e agent passaram; as demais etapas ficaram SKIP. Os endpoints reais e os rastreios anteriores de OS/cotação e marca foram incorporados à matriz e ao registro gerado; a proveniência e os hashes estão em [lote41-proveniencia.json](integracao-v0/evidencias/lote41-proveniencia.json). A geração do registro não é uma nova execução de navegador.

No lote 42, PostgreSQL/race e HTTP passaram, mas o navegador falhou e continua pendente. CI e SBOM do candidato corrigido ainda são necessários antes da publicação; não há homologação externa.
