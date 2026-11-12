# Migração IXCSoft → NexoISP (somente leitura)

Traz **os dados do próprio provedor** do IXC para o CSV intermediário do NexoISP (`docs/importacao-csv.md`).
O IXC é relacional, então o exportador faz a **junção**: cada assinante é um `cliente_contrato` + o `cliente`
(identidade/endereço) + o `radusuarios` (login/senha/ip/mac) daquele contrato; o plano vem de `vd_contratos`.
Cada fatura é um `fn_areceber`, ligada ao assinante pelo id do contrato.

| Arquivo | Para quê |
|---|---|
| `ixc_client.py` | Cliente da API do IXC (`/webservice/v1`, Basic + `ixcsoft: listar`). **Só listagem**, só nas tabelas da lista; HTTPS obrigatório, sem redirecionar para outro host |
| `exportar_csv.py` | Gera `assinantes.csv` e `titulos.csv` juntando as tabelas |
| `tests/` | Testes com cliente falso em memória (sem rede, sem dado real) |

## Uso

```bash
export IXC_URL=https://SEU-PROVEDOR.ixc...com.br     # sem barra no fim
export IXC_TOKEN=ID:HASH                               # token de leitura (Sistema → ... → tokens de API)
cd tools/ixc-migracao
python3 exportar_csv.py --max 50                       # teste: para em 50 linhas por tipo
python3 exportar_csv.py                                 # grava ~/nexo-ixc-saida/assinantes.csv e titulos.csv
```

## Confirmado contra IXC real (Up Connect, 2026-11-12)

`cliente` (160 campos), `cliente_contrato` (147), `radusuarios` (114), `fn_areceber` (86). Mapeamento usado:
nome=`razao`, cpf_cnpj=`cnpj_cpf`, telefone=`telefone_celular`, login/senha/mac/ip=`radusuarios`, plano=`vd_contratos.nome`,
situação do contrato `A`→ativo (resto inativo), fatura `A`→aberto/`R`→pago/`C`→cancelado.

**Limites conhecidos:** `cidade`/`uf` no IXC são **id (FK)**, não nome — ficam vazios até resolver pela tabela `cidade`;
o contrato não tem **dia de vencimento** fixo (inferível do vencimento das faturas). Ambos são opcionais no importador.

## Regras

- **O token nunca entra no repositório** nem em argumento: só variável de ambiente. Revogue ao terminar.
- **A saída tem dados pessoais** (inclui senha PPPoE): padrão `~/nexo-ixc-saida`, 600, fora do repositório.
- **Só com autorização do dono dos dados.** Testes: `cd tools/ixc-migracao && python3 -m unittest tests.test_ferramentas`.
