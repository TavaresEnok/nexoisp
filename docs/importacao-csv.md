# Importação — formato CSV intermediário do NexoISP

**Este não é o formato do MK-Auth.** Sem uma exportação real autorizada, o importador trabalha com o formato abaixo.
Para migrar do MK-Auth, converta a exportação para estas colunas (ou ajuste o mapa de campos na tela). A compatibilidade
direta com o MK-Auth permanece **pendente** até existir uma amostra real da versão usada pelo piloto.

Arquivos de exemplo (dados sintéticos): `samples/assinantes.csv` e `samples/titulos.csv`.
Separador `;` ou `,` (detectado), UTF-8, primeira linha com os nomes das colunas.

## 1. Assinantes, contratos e contas PPPoE (`assinantes.csv`)

| Coluna | Obrigatória | Regra |
|---|---|---|
| `id_externo` | sim | Identificador do cliente na origem. Chave da reimportação |
| `nome` | sim | |
| `cpf_cnpj` | não | Validado; inválido rejeita a linha |
| `email`, `telefone`, `logradouro`, `numero`, `bairro`, `cidade`, `uf`, `cep`, `observacoes` | não | |
| `situacao` | não | `ativo` (padrão) ou `inativo`. Outro valor rejeita a linha |
| `plano` | não | Nome de um plano já cadastrado, ou mapeado na tela. Sem correspondência rejeita a linha |
| `vencimento_dia` | com plano | 1 a 28. Fora disso rejeita a linha (o sistema não escolhe outro dia) |
| `pppoe_usuario` | não | Cria a conta PPPoE (não provisionada) no equipamento escolhido |
| `pppoe_senha` | não | Ausente: conta fica **sem credencial** e não pode ser provisionada até alguém informar a senha |

## 2. Títulos em aberto (`titulos.csv`) — importar depois dos assinantes

| Coluna | Obrigatória | Regra |
|---|---|---|
| `id_externo` | sim | Identificador do título na origem |
| `id_externo_assinante` | sim | Deve existir na mesma origem; senão a linha é rejeitada (nunca descartada em silêncio) |
| `vencimento` | sim | `AAAA-MM-DD` ou `DD/MM/AAAA` |
| `valor` | sim | `79,90`, `1.149,90` ou `79.90`; convertido para centavos sem ponto flutuante |
| `competencia` | não | `AAAA-MM`. Marca como mensalidade e impede cobrança em dobro com a recorrência |
| `descricao` | não | |

Títulos importados entram como "em aberto" e **não geram cobrança automática no gateway**.

## Fluxo

1. **Prévia**: executa a importação inteira e desfaz. Mostra criados/atualizados/sem alteração/erros, soma dos valores e planos sem correspondência.
2. **Aplicar**: grava e registra o lote com o resultado por linha. Linhas com erro não entram; corrija e reimporte.
3. **Reimportar** o mesmo arquivo não duplica: registros são reconhecidos por origem + `id_externo`.
4. **Provisionar o lote** (ação separada e explícita): envia ao agente as contas PPPoE importadas que têm senha.

## Corte e reversão (procedimento)

Antes do corte
1. Importar assinantes e títulos; conferir na prévia e no lote: quantidade de clientes, contratos, soma dos títulos e contas sem senha.
2. Definir o **grupo inicial** (um NAS ou um conjunto de clientes) e a **fonte autoritativa** por grupo: enquanto um grupo estiver no NexoISP, o sistema antigo não altera esses assinantes (e vice-versa).
3. Backup do NexoISP (`./nexo backup`) e export/backup do sistema antigo.

Corte do grupo
4. "Provisionar o lote" e aguardar todas as operações concluídas (tela Operações).
5. Apontar o RADIUS do NAS do grupo para o RADIUS local do NexoISP. Conferir autenticação de alguns clientes.

Reversão (preserva o que aconteceu depois da migração)
6. Reapontar o RADIUS do NAS para o sistema antigo. Colocar o equipamento em **modo manutenção** no NexoISP (para o ERP não escrever mais).
7. **Não restaurar backup antigo por cima**: pagamentos e alterações feitos no NexoISP após o corte continuam nele. Exportar esses eventos
   (Faturas → pagas no período; Auditoria) e lançá-los no sistema antigo antes de retomar a operação nele.
8. Registrar o motivo e o que foi relançado.

Nenhuma migração de produção foi executada: este procedimento depende de autorização explícita e do piloto definido.
