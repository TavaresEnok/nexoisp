# Lote 42 — inventário passivo

Cadastro de postes, torres e condomínios por POP na interface oficial, com consulta, edição, filtro, arquivo e reativação. C42 permanece parcial: não implementa topologia completa, GIS ou comandos físicos.

O CRUD foi reconciliado como validado na matriz funcional com endpoints `GET /api/network/sites`, `GET /api/network/sites/:id`, `POST /api/network/sites` e `PATCH /api/network/sites/:id`:
- PostgreSQL/race `REQUIRED=1` e helper HTTP passaram em `19eb8bb`.
- O cenário de navegador (`frontend-v0-network-sites.mjs`) passou com sucesso real na validação do lote 43 em `5111ce3` e seu rastreio histórico autossuficiente (`30/10/2026 15:08:41.215Z`, SHA256 `3b94444ebd5b002ae379008aa87c1eecaa430077d622d54e00765902a53ccaf7`) foi incorporado fielmente em `docs/integracao-v0/evidencias/rastreio/frontend-v0-network-sites.json` e `docs/integracao-v0/evidencias/por-unidade.json`.
- Novas exportações CSV adicionadas no lote 44 constituem recorte separado e permanecem pendentes de verificação própria, sem homologação externa, publicação ou conclusão integral. Chatwoot fora do escopo.
