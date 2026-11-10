# Auditoria das subações do menu (2026-11-10)

## Por que existe

Dos 420 itens do menu, 324 são subações: ações dentro de uma página, como
"Suspender" ou "Trocar senha PPPoE". O teste `legacy-route-parity` as dava por
cobertas só porque a página-mãe existe, sem conferir se a ação estava na tela.
A matriz funcional também não as listava.

## Resultado

Cada subação foi conferida no código do frontend operacional (`apps/web/features`)
e na rota correspondente do backend Go. A evidência linha a linha, com
arquivo:linha da tela e da API, está em `auditoria-subacoes-2026-11-10.tsv`.

| Situação | Itens |
|---|---|
| Implementado | 294 |
| Agrupador (título de seção; a seção existe) | 30 |
| Parcial ou ausente | 0 |

Três lacunas apareceram e foram corrigidas no mesmo dia:

- Atendimento: não havia botão para marcar "aguardando o assinante" (só existia como filtro).
- Contrato: o consumo por mês, hora, dia, semana e ano não podia ser exportado (só as sessões).
- Contrato: aditivos não tinham impressão.

## Demonstração

`/demonstracao/...` usa o renderizador do v0 com dados fictícios. Nele, 399 das
420 páginas mostram "Implementação funcional pendente", porque o v0 só desenhou
20 telas. Isso descreve a demonstração, não o sistema logado.
