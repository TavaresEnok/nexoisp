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

- Lote 44 permanece DONE no marco anterior; a execução local posterior registrou sites PG FAIL e cotação PG PASS. Após as correções T1/T5, sites PG e browser CSV estão NOTRUN até novos recibos; CI 41093365872 no SHA base ainda não aprovado no plano.
- As 3 raízes (backend cotação, backend sites, UI de exportação) foram unificadas.
- As duas rotas GET foram adicionadas ao inventário estático `apps/api-go/rotas.json`, garantindo `assert manifest == actual` no contrato nativo.
- Testes essenciais de contrato HTTP foram incorporados em `tests/contrato/stock_quotations_contract.py` e `tests/contrato/network_sites_contract.py` usando fixtures originais para validar status 200, Content-Type, Content-Disposition, BOM, cabeçalhos e valores.
- **Falha e correção de fixture PostgreSQL (T1)**: `TestNetworkSitesExportPG` falhava devido ao tamanho do slug do tenant na fixture; T1 limitou a parte do UUID a 30 caracteres (`[:30]`). Cotação em PG foi comprovada PASS; a validação de sites em PostgreSQL real permanece pendente de recibo formal de execução.
- **Expectativas de aspas nos testes de browser (T5)**: a execução real de browser em Lote 44 apontou expectativas que desconsideravam aspas legítimas em células de texto com caracteres especiais nos CSVs; T5 corrigiu estritamente essas asserções em `e2e/frontend-v0-network-sites.mjs` e `e2e/frontend-v0-os-quotations.mjs`, preservando BOM, cabeçalhos, IDs, valores e paginação. Prova real em navegador desses cenários permanece pendente de recibo antes de release/publicação.
- Chatwoot permanece excluído do escopo.
