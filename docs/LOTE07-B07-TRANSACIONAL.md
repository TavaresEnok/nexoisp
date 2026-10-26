# B07 — reserva transacional e vínculo da cobrança

Este incremento fecha a janela entre validação da fatura e envio ao adapter. B07 completo permanece parcial e desativado para fornecedores reais.

## Reserva e concorrência

A migração 69 acrescenta `invoices.provider_issuance_id`. A criação do journal valida e bloqueia a fatura; o vínculo de reserva é gravado na mesma transação. A reserva sobrevive a processo interrompido e não depende de lease em memória.

Enquanto não há resposta vinculada, triggers recusam alteração de valor, vencimento, encargos, desconto, empresa, contrato, acordo, cancelamento, quitação e inserção de pagamento. A consulta de cobrança demo também exclui títulos reservados. Observações de acompanhamento continuam permitidas.

`Prepare`, claim e confirmação tomam locks na ordem fatura → journal, acompanhando recebimentos. Duas preparações da mesma intenção convergem na mesma reserva. Se um pagamento obtém o lock primeiro, a preparação posterior é recusada sem deixar journal. Se a reserva vence, o pagamento é recusado sem deixar pagamento ou intenção B02 parcial.

Conflitos de reserva usam SQLSTATE `N6901`, traduzido em HTTP 409. A UI existente conserva a intenção de baixa nesse caso. Após resultado confirmado, a mesma intenção pode ser repetida e gerar somente um recebimento.

## Confirmação e recuperação

A transição do journal para `issued` vincula fornecedor/conexão/charge ID à fatura no mesmo commit, por trigger. Não muda status financeiro nem cria pagamento. Se a vinculação falhar, o journal continua incerto e a fatura permanece sem vínculo parcial; a retomada consulta a intenção original, sem outra criação.

Após vínculo confirmado, baixa manual é novamente possível e idempotente. Operadores de POP autorizados podem receber a fatura sem ganhar acesso ao journal ou à conta. Valor nominal, vencimento, empresa e identidade da cobrança continuam protegidos; cancelamento requer o fluxo de cancelamento remoto ainda pendente.

Testes matam um processo de teste por SIGKILL ao entrar no adapter sintético depois do commit de incerteza. Antes de efeito simulado, 404 mantém incerteza e bloqueio; depois de efeito, consulta recupera o vínculo. Isso prova recuperação do serviço/journal com adapter sintético, não homologação Efí ou reinício de infraestrutura bancária.

## Migração e retorno

Preflight da migração 69 valida intenções existentes contra fatura/conta. Divergência interrompe e reverte a migração, mantendo a versão 68 e os dados, para conciliação explícita. Intenções prepared/uncertain válidas recebem reserva; issued válido recebe vínculo, sem mudar dinheiro ou estado financeiro.

Down destrutivo é bloqueado. Retorno de código conserva reserva/journal e requer conciliar resultados antes de futura evolução. Não retomar emissão automaticamente com o build da versão 68: o Prepare antigo usava INSERT/ON CONFLICT antes da validação da reserva e a ordem de locks também mudou. A tag é base recuperável de código; retorno operacional exige build compatível com a versão 69 ou correção adiante, sem remover proteções/dados. O teste 68→69 cobre preflight, prepared/uncertain/issued, vínculo atômico, preservação financeira e dump/restauração lógica. O teste anterior foi fixado explicitamente em 67→68 para continuar verificando seu contrato histórico; as assertivas financeiras não foram removidas.

## Reprodução isolada

- `python3 tests/contrato/nativo.py`: inclui `issuance_conflicts.py`, duas APIs, dados sintéticos, autorização e baixa/cancelamento concorrentes.
- Com DB descartável em `NEXO_GO_TEST_DATABASE_URL`: `go test -race -count=1 ./...`.
- `NEXO_PAYMENT_LAB=1 python3 tests/contrato/provider_issuance_reservation_migration.py`.
- Jornadas de navegador de finanças/acesso financeiro e intenção B02 continuam com os componentes e referências oficiais.

Os testes de RLS criam POPs próprios e revertem a transação, evitando depender da ordem aleatória dos tenants ou de POPs do seed. A verificação inclui acesso permitido e negado.

## Continuidade

Próximo incremento B07: autorização/entrada operacional e consumidor com cofre de credenciais; receiver Efí com mTLS/inbox/consulta; cancelamento/devolução e revisão explícita. Pix CobV e boleto/Bolix continuam no escopo confirmado pelo usuário, com contratos específicos ainda pendentes. Nenhum registry/flag de ativação real foi aberto neste incremento.

Demais PSPs/alternativas e frentes de rede/ACS/RADIUS, atendimento/OS/estoque, WhatsApp, topologia, fiscal/CNAB, migração, restauração e piloto continuam no backlog. Ver relatório externo 21 para commits e resultados exatos.
