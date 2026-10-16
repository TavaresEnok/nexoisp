# Ferramentas do inventário

Scripts de documentação (não são código de produção). Regeram o `INVENTARIO_ROTAS.md` a partir do código do Fastify:

```bash
python3 docs/migracao-go/ferramentas/extrair_rotas.py . > /tmp/rotas.json
python3 docs/migracao-go/ferramentas/gerar_inventario_md.py /tmp/rotas.json > docs/migracao-go/INVENTARIO_ROTAS.md
```

A extração é estática e aproximada (ver os limites no topo do inventário). Rode da raiz do repositório.
