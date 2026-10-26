# B06 — contrato PSP e simulador adverso

Implementação local sobre B05, sem migração nova ou alteração da interface oficial.

## Fronteiras

`internal/finance/providers/contract.go` define criação/consulta, escopo de tenant/conexão/conta/ambiente, intenção estável e BRL em centavos inteiros (limite atual int32 do banco). Respostas devem corresponder ao escopo e à intenção. O adapter não lança pagamentos nem pede operações técnicas.

`internal/finance/demo_adapter.go` adapta emissão e consulta demonstrativas existentes. A intenção `invoice:<UUID>` deriva da fatura persistida; criação demonstrativa e vinculação são transacionais no mesmo banco. Reutilizar intenção com outro valor retorna conflito. RLS e autorização continuam nas transações e rotas existentes. Apenas demo, sandbox e modo demonstrativo explícito são executáveis. Cadastro de fornecedor não ativa implementação.

O transporte HTTP adverso existe exclusivamente em `providers/lab_test.go`. Não há configuração para ativá-lo no binário operacional. O teste persiste a intenção, recria o cliente e consulta antes de repetir a mesma intenção. Timeout antes/depois do efeito, 429, 5xx após commit, resposta truncada, conta/ambiente incorretos e concorrência são sintéticos.

**Limite:** a idempotência forte do simulador não é garantia de PSP real. Uma consulta 404 pode ser eventualmente consistente; não autoriza nova intenção nem reemissão cega. Antes do primeiro adapter externo, persistir estado de emissão incerta e implementar recuperação, limites de retry/Retry-After, transporte, assinatura e semântica específicos do produto contratado. O contrato atual não implementa cancelamento/devolução externa.

## Recebimento

O handler demo autentica HMAC sobre os bytes originais e verifica timestamp/conexão antes de decodificar o evento tipado. Frações, números entre aspas, valores fora do intervalo, moeda incompatível e data inválida são rejeitados. Moeda ausente continua BRL apenas no protocolo demonstrativo legado.

Inbox continua durável e isolada por conexão; evento antecipado fica unmatched e pode ser reapresentado após vinculação. IDs repetidos com payload diferente conflitam; duplicata de pagamento compara fatura, centavos, instante e método. Payload não escolhe tenant/conta/ambiente autenticados.

Aviso divergente de estorno/chargeback impede confirmação ou consulta posterior de quitar automaticamente a fatura: recebimento é preservado, status reconciling, sem novo efeito técnico B05. A decisão manual existente permanece necessária. Não há devolução bancária nem estorno contábil automático implementado neste lote; avisos históricos divergentes não são apagados automaticamente.

## Verificação e recuperação

- `go test -race ./internal/finance/providers` cobre transporte sintético e invariantes.
- `tests/contrato/nativo.py` inclui `provider_contract.py`: callbacks assinados, duas APIs, PostgreSQL descartável, recebimentos e efeitos persistidos, conciliação e shadow B04.
- `tests/contrato/payment_effects.py` verifica regressão B05 com banco próprio, consumidor, falhas e reinício.
- Suíte Go com PostgreSQL de teste e jornadas frontend de finanças/conexões complementam a integração local. Resultados exatos no relatório externo 19 e logs do lote.

Base recuperável: tag `base/pre-b06-2026-10-26`. Sem migração nova, rollback de código não exige remover tabelas/dados. Antes de eventual rollback operacional futuro, parar consumidores, preservar snapshot e reconciliar eventos/recebimentos pendentes; retornar ao código anterior também perde as novas proteções de validação e disputa. Nenhum rollback produtivo executado.

## Continuidade

B07: Efí (sejaefi é alias), produto e conta sandbox definidos; persistência de emissão incerta, mTLS/rotação e contrato específico antes de homologação. Manter Asaas, Inter, Sicredi, Mercado Pago, PagBank/PagSeguro e Stripe no planejamento; Kobana, Shipay e Tuna são alternativas de integração, sem contratação/ativação implícitas.

Rede B10 em lote separado: drivers/fixtures, resultado desconhecido, readback e recuperação; depois B09 ACS. B11 depende de B05/B10. Fiscal/CNAB, atendimento/OS/estoque, WhatsApp, topologia, migração, restauração e piloto permanecem no backlog integral.
