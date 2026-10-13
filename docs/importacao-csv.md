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

### Colunas opcionais do modelo v2 (assinantes)

Só atuam quando a coluna existe no arquivo. **Um arquivo sem elas nunca apaga o que já está no sistema.** Reimportar não duplica contato, etiqueta, fidelidade nem indicação,
e nunca troca POP, fidelidade ou indicador que já estejam preenchidos (isso é decisão de quem opera, pelo painel).

| Coluna | Regra |
|---|---|
| `nascimento` | `AAAA-MM-DD` ou `DD/MM/AAAA`; inválida rejeita a linha |
| `rg`, `nome_mae`, `nome_fantasia` | Texto; `rg` de 3 a 20 caracteres (letras, números, `.`, `-`, `/`) |
| `celular`, `whatsapp` | Cria contato do tipo celular/WhatsApp. **Sem consentimento por padrão** |
| `aceita_avisos` | `sim` ou `não`. Só `sim` marca o contato como autorizado a receber avisos de saída (cobrança, manutenção, OS). Informe `sim` apenas se o consentimento existir na origem |
| `inicio_contrato` | Data de início do contrato (padrão: hoje). Importante para o primeiro mês proporcional |
| `mac` | MAC do equipamento do assinante (`AA:BB:CC:DD:EE:FF`, aceita `-` e sem separador); vincula à conta PPPoE |
| `etiquetas` | Lista separada por `|` (ex.: `vip|fibra`); cria as que não existem |
| `pop` | Nome de um POP já cadastrado. Inexistente vira **aviso** (a linha entra); cadastre o POP e reimporte |
| `fidelidade_ate`, `multa_valor`, `multa_modelo` | Fim da carência, valor da multa e `fixo` (padrão) ou `mensal` (por mês restante). `multa_valor` é obrigatório com `fidelidade_ate` |
| `indicado_por` | `id_externo` do assinante que indicou (da mesma origem; importe-o antes) |

**Não entram no CSV:** IP fixo (depende de pool no IPAM), documentos anexos, mais de um serviço por assinante e histórico de sessões.

## 2. Títulos em aberto (`titulos.csv`) — importar depois dos assinantes

| Coluna | Obrigatória | Regra |
|---|---|---|
| `id_externo` | sim | Identificador do título na origem |
| `id_externo_assinante` | sim | Deve existir na mesma origem; senão a linha é rejeitada (nunca descartada em silêncio) |
| `vencimento` | sim | `AAAA-MM-DD` ou `DD/MM/AAAA` |
| `valor` | sim | `79,90`, `1.149,90` ou `79.90`; convertido para centavos sem ponto flutuante |
| `competencia` | não | `AAAA-MM`. Marca como mensalidade e impede cobrança em dobro com a recorrência |
| `descricao` | não | |

### Histórico financeiro (colunas opcionais)

| Coluna | Regra |
|---|---|
| `situacao` | `aberto` (padrão), `pago` ou `cancelado`. Outro valor rejeita a linha |
| `pago_em` | Obrigatória para `pago` |
| `valor_pago` | Padrão: o valor do título. **Menor que o valor** deixa o título em aberto com o saldo (pagamento parcial) e avisa na linha |
| `forma_pagamento` | Texto livre (pix, boleto…) |

Título `pago` entra como pago com a baixa registrada (origem "manual", observação com a origem e o id); `cancelado` entra cancelado. Nenhum deles vai ao gateway.
Com `competencia`, o título histórico também impede que a recorrência gere a mensalidade do mesmo mês em dobro.

Títulos em aberto importados entram como "em aberto" e **não geram cobrança automática no gateway**.

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
