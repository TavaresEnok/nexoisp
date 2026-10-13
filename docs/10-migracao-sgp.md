# Migração SGP → NexoISP e compatibilidade de integrações

**Criado em:** 13 de outubro de 2026
**Situação:** ferramentas escritas e testadas **contra um servidor falso com dados sintéticos**. Nada foi executado contra um SGP real.
**Não confundir:** isto migra **os dados do próprio provedor** com a credencial dele. Não é um meio de ler dados de terceiros.

## 1. O que existe e o que falta

| Peça | Estado | Observação |
|---|---|---|
| Cliente de leitura da API do SGP | pronto, testado com servidor falso | só rotas de consulta; HTTPS; token por ambiente |
| Amostrador de formato (chaves e tipos, sem valores) | pronto, testado | **é o passo que destrava tudo abaixo** |
| Exportador para o CSV intermediário | pronto, testado | **depende do mapeamento, que depende do amostrador** |
| Importação no NexoISP (prévia, aplicar, lote, provisionar) | pronta (`docs/importacao-csv.md`) | testada só com dados sintéticos |
| Camada de compatibilidade (o NexoISP atender rotas do SGP) | **não escrita**, de propósito (seção 4) | |
| Mapeamento real | **não existe** | a documentação da API do SGP não traz o formato das respostas |

**Por que o mapeamento não foi escrito já:** `docs/API-SGP-completa.txt` descreve os **parâmetros de entrada** de cada rota, mas não o formato das respostas.
Adivinhar nomes de campo geraria um importador que parece funcionar e grava errado. Por isso o exportador **se recusa a rodar** enquanto houver campo "?".

## 2. Roteiro

1. **Autorização e termos.** Dono dos dados autoriza por escrito; conferir os termos de uso do SGP sobre uso automatizado da API.
2. **Token só de leitura.** Criar no SGP (Sistema → Ferramentas → Painel Admin → Tokens) um token novo, para esta migração, e **não reutilizar** os tokens das integrações.
3. **Amostrar o formato** (`amostrar_formato.py`). Revisar o `formato.json`: não tem valores, só estrutura.
4. **Preencher o mapeamento** com os caminhos do `formato.json` e rodar uma exportação pequena (limite no mapeamento) para conferir.
5. **Exportar tudo**, importar no NexoISP em **prévia**, conferir: quantidade de clientes, contratos, soma dos títulos, contas sem senha.
6. **Revogar o token** da migração.
7. Seguir o procedimento de corte e reversão de `docs/importacao-csv.md`.

## 3. Perguntas que a primeira amostra responde

- A resposta traz a **senha PPPoE** do serviço? Se não, o corte exige trocar a senha dos assinantes ou obtê-la por outro meio.
- Quantos clientes têm **mais de um contrato ou serviço**? O CSV intermediário trata um contrato por cliente; o exportador avisa a contagem.
- Como o SGP representa **situação do contrato** (1 ativo, 2 inativo, 3 cancelado, 4 suspenso, 5 inviabilidade, 6 novo, 7 ativo com velocidade reduzida)? O exemplo mapeia 1 e 7 para "ativo" e o resto para "inativo": **confirmar com o provedor**, em especial suspensos.
- **Títulos**: o filtro `abertos` devolve também os parcialmente pagos e os de acordo? Isso muda o saldo importado.
- Como o SGP guarda o **IP fixo**, o **MAC** e a **etiqueta** de cada serviço? O NexoISP tem esses três (IP fixo, vínculo de MAC, etiquetas), mas o CSV intermediário ainda não os traz.

## 4. Camada de compatibilidade: por que ainda não, e como será

O objetivo é que as integrações já existentes em volta do SGP (atendimento por chat, automações, sistema de OS, monitor) continuem funcionando depois da
migração, apontando para o NexoISP. Por isso o desenho é **somente leitura primeiro**, e só das rotas que o provedor **realmente usa**.

Passos, nesta ordem:

1. **Descobrir quais rotas as integrações chamam.** No SGP: log de acesso da API, ou o fluxo de cada automação.
2. **Amostrar o formato dessas rotas** (o mesmo `amostrar_formato.py`, com a lista de rotas). Sem isso não há como responder igual.
3. **Escrever só essas rotas**, com autenticação `token + app` própria do NexoISP (tokens por provedor, guardados com hash, com escopo de leitura, limite de taxa e
   auditoria), e atrás de módulo liberado por provedor, desligado por padrão.
4. **Teste de contrato**: gravar uma resposta real (sem dados pessoais) de cada rota e comparar a do NexoISP campo a campo.
5. Só depois, rotas de escrita (criar chamado, baixar título), uma a uma, com a mesma garantia de operação assinada que o resto do sistema.

**Limites declarados:** não é compatibilidade total; é compatibilidade **das rotas usadas por este provedor**. Material comercial não deve dizer "compatível com o SGP".

## 5. Roteiro de conferência de comportamento (na instância do próprio provedor)

O espelho e a API mostram **o que existe**, não **o que o SGP faz** em cada caso. Para as regras que o NexoISP precisa igualar (ou decidir diferir), usar
uma instância de **homologação** do provedor, nunca produção, e registrar o resultado. Casos mínimos:

| # | Caso | O que anotar |
|---|---|---|
| 1 | Contrato que começa no dia 17: primeira mensalidade | Valor, base de cálculo (30 dias ou dias do mês), arredondamento |
| 2 | Pagamento parcial de um título | Situação do título, saldo, o que o cliente vê |
| 3 | Título vencido há 10 dias com multa e juros configurados | Fórmula (pro rata? composto?), arredondamento, base |
| 4 | Promessa de pagamento de 3 dias | Efeito na rede, o que acontece no vencimento da promessa, limite de repetição |
| 5 | Acordo em 3 parcelas com entrada | O que vira de cada título original, status do contrato, data de cada parcela |
| 6 | Fidelidade de 12 meses, cancelamento no mês 5 | Multa, base, quando é cobrada |
| 7 | Cliente com 2 contratos e 1 título | Como "contratos unificados" aparece |
| 8 | Suspensão com os três degraus (avisar, reduzir, bloquear) | Dias de cada degrau, o que muda na rede em cada um |
| 9 | Troca de plano no meio do mês | Proporcional? Quando entra o valor novo? |
| 10 | Cancelamento e reativação | Títulos futuros, equipamento, histórico |

Cada linha preenchida vira um **teste automático do NexoISP** (financeiro) ou uma decisão registrada de "fazemos diferente, e por quê".
