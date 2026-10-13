# Migração SGP → NexoISP (somente leitura)

Ferramentas para trazer **os dados do próprio provedor** do SGP para o CSV intermediário do NexoISP (`docs/importacao-csv.md`).
Roteiro completo, limites e cuidados de LGPD: `docs/10-migracao-sgp.md`.

| Arquivo | Para quê |
|---|---|
| `sgp_client.py` | Cliente da API do SGP. **Só consulta**: rotas de escrita são recusadas antes de sair da máquina. HTTPS obrigatório, sem seguir redirecionamento para outro servidor |
| `amostrar_formato.py` | Descobre as **chaves e tipos** das respostas (sem guardar valores) para preencher o mapeamento |
| `exportar_csv.py` | Gera `assinantes.csv` e `titulos.csv` a partir do mapeamento |
| `mapeamento.exemplo.json` | Modelo. Os campos "?" **não foram confirmados** contra o SGP real |
| `tests/` | Testes contra um servidor falso local com dados sintéticos |

## Uso

```bash
export SGP_URL=https://SEU-PROVEDOR.sgp.net.br     # sem barra no fim
export SGP_APP=nome-da-aplicacao-no-sgp
export SGP_TOKEN=...                                 # token com permissão apenas de leitura, de preferência criado só para isto
cd tools/sgp-migracao
python3 amostrar_formato.py                          # grava ~/nexo-sgp-saida/formato.json (sem valores)
cp mapeamento.exemplo.json meu-mapeamento.json       # preencha os "?" com os caminhos do formato.json
python3 exportar_csv.py meu-mapeamento.json          # grava ~/nexo-sgp-saida/assinantes.csv e titulos.csv
```

## Regras

- **O token nunca entra no repositório** nem em argumento de linha de comando: só variável de ambiente. Revogue-o ao terminar.
- **A saída tem dados pessoais.** O padrão é `~/nexo-sgp-saida`, com permissão 600, fora do repositório. Não envie para lugar nenhum além da prévia de importação do NexoISP.
- **Rode só com autorização do dono dos dados** (o provedor) e conforme os termos de uso do SGP.
- Os testes: `python3 -I tests/test_ferramentas.py`.
