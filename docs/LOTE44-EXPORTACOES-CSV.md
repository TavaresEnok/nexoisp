# Lote 44 — exportações operacionais CSV (C37)

Implementação de exportações operacionais em CSV segundo os requisitos do backlog C37, a partir de dados e fórmulas já existentes, sem novas dependências, migrações de banco ou serviços externos.

## Escopo e rotas

1. **Cotação de estoque**:
   - Rota: `GET /api/stock/quotations/{id}/export.csv`
   - Permissão: `stock:read`, respeitando autenticação, tenant, escopo de POP e autorização do detalhe da cotação.
   - Colunas: `cotacao_id;cotacao;status;fornecedor_id;fornecedor;item_id;item;unidade;quantidade;preco_unitario_centavos;subtotal_centavos;pedido_id`.
   - Formato: cabeçalho `cotacao-<id8>.csv`, inteiros em centavos sem perda de precisão, até 300 linhas determinísticas.

2. **Inventário passivo (locais de infraestrutura)**:
   - Rota: `GET /api/network/sites/export.csv`
   - Permissão: `network:read`, mesmos filtros da consulta paginada (`q`, `kind`, `pop_id`, `status`, `limit`, `offset`).
   - Colunas: `local_id;tipo;local;pop_id;pop;cidade;endereco;latitude;longitude;ativo;observacoes`.
   - Formato: cabeçalho `locais-infraestrutura-pagina.csv`, cabeçalho `X-Total-Count` do total filtrado, exportando a página solicitada.

## Formato wire e segurança

- UTF-8 com BOM (`\xef\xbb\xbf`), delimitador `;`, quebras CRLF (`\r\n`).
- Headers HTTP: `Content-Type: text/csv; charset=utf-8`, `Cache-Control: private, no-store`.
- Sanitização contra injeção de fórmulas CSV: células de texto iniciadas por `=`, `+`, `-` ou `@` são prefixadas com `'`.
- Valores numéricos, IDs e coordenadas negativas preservados como numerais puros.

## Integração e verificação

- Lote 44 permanece DONE no marco anterior; a execução local posterior registrou sites PG FAIL e cotação PG PASS. Após as correções T1/T5, a prova real do lote 45 registrou sites PG com race PASS e ambos os cenários CSV em browser PASS. Cotação PG 44 é reuso, não nova execução; CI 41093365872 no SHA base não foi aprovado neste registro.
- As 3 raízes (backend cotação, backend sites, UI de exportação) foram unificadas.
- As duas rotas GET foram adicionadas ao inventário estático `apps/api-go/rotas.json`, garantindo `assert manifest == actual` no contrato nativo.
- Testes essenciais de contrato HTTP foram incorporados em `tests/contrato/stock_quotations_contract.py` e `tests/contrato/network_sites_contract.py` usando fixtures originais para validar status 200, Content-Type, Content-Disposition, BOM, cabeçalhos e valores.
- **Falha e correção de fixture PostgreSQL (T1)**: `TestNetworkSitesExportPG` falhava devido ao tamanho do slug do tenant na fixture; T1 limitou a parte do UUID a 30 caracteres (`[:30]`). Sites PG real passou na prova 45; cotação PG PASS é prova reutilizada do lote 44.
- **Expectativas de aspas nos testes de browser (T5)**: a execução real de browser em Lote 44 apontou expectativas que desconsideravam aspas legítimas em células de texto com caracteres especiais nos CSVs; T5 corrigiu estritamente essas asserções em `e2e/frontend-v0-network-sites.mjs` e `e2e/frontend-v0-os-quotations.mjs`, preservando BOM, cabeçalhos, IDs, valores e paginação. Ambos passaram em browser na prova 45; isso não constitui homologação ou publicação.
- [Proveniência da prova 45](integracao-v0/evidencias/lote45-proveniencia.json): UI 45 e API 44 com fontes de produção inalteradas; recibo original `passed=false` preservado por causa de dois rastreios regenerados, com verificação derivada das fontes de implementação e comandos sem falha. HTTP nativo CI 44 é reuso anterior à falha Go PG, não nova execução.
- Chatwoot permanece excluído do escopo.
