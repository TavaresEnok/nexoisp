# Robustez operacional e limites de aceite

Entrega de 24/10/2026 sobre os riscos identificados na revisão do sistema. Por orientação do usuário, integração bancária está fora deste trabalho. Equipamentos e infraestrutura definitiva ainda não foram informados. Nenhum equipamento ou banco operacional foi usado nos ensaios.

## Correções implementadas

- Rotinas de cobrança, conciliação, avisos, alterações agendadas, SLA, limpeza de accounting, confiança, suspensão e entregas usam jobs River por provedor. Cada provedor tem retentativa própria e trava de execução entre réplicas. Uma trava ocupada reagenda a tarefa sem manter um trabalhador esperando. As rotinas globais e os comandos de rede mantêm suas filas próprias.
- Quatro trabalhadores processam a fila `tenant`; tarefas do mesmo provedor são serializadas. Isso limita a concorrência inicial, mas não substitui um ensaio de capacidade no destino. Jobs esgotados ficam visíveis como `discarded`; um novo ciclo periódico pode tentar novamente, respeitando a idempotência dos comandos.
- O limite de requisições de cada sessão é atualizado atomicamente no PostgreSQL, compartilhado pelas réplicas e preservado no reinício da API. O contador fica em tabela privada com RLS, sem acesso direto da aplicação. Uma falha no contador não seleciona um limite local mais permissivo. A proteção de login existente é preservada.
- Backups novos incluem `.dump`, `.manifest.json` e `.sha256`. Dump e manifesto são obtidos no mesmo snapshot de leitura, sem comparar o backup com dados que continuaram mudando no banco vivo. O manifesto contém contagens de todas as tabelas públicas, políticas RLS, permissões, versões de migrations e totais de faturas e pagamentos por provedor.
- `restore-check` usa banco temporário exclusivo, confere o manifesto e exercita RLS com o papel `nexo_go`, incluindo isolamento entre provedores e portal. O banco temporário é removido também em falha. Em produção, a conferência adicional valida segredos AES e RADIUS com as chaves da instalação, sem imprimir o conteúdo nem alterar credenciais.
- Métricas de fila, atraso, tarefas descartadas, falhas por provedor e última execução bem-sucedida são expostas na porta interna `/metrics`. O frontend v0 e seus estilos não foram alterados.

## Reproduzir as provas

Requisitos: Docker, Python 3, OpenSSL e Go conforme `apps/api-go/go.mod` (ou a imagem de ferramentas já prevista no projeto).

```bash
python3 -m unittest discover -s tests/operacao
python3 tests/contrato/resilience.py
```

O contrato usa exclusivamente um container `nexo-resilience-*`, porta de laboratório e dados sintéticos. Ele testa falha de um provedor com o outro saudável, recuperação da retentativa após reinício, geração sem duplicação, contador compartilhado entre duas APIs, reinício da API, sessão independente, monitor HTTP, amostra de capacidade, restauração após escrita posterior no banco vivo, login real na cópia restaurada e rejeição de chaves AES/RADIUS e manifesto incorretos. O relatório é `tests/contrato/relatorios/resilience.json`. A CI executa esses testes junto aos contratos já existentes.

O teste usa configuração inválida de fuso para provocar uma falha real na rotina de cobrança; não injeta respostas de sucesso. Isso prova o comportamento no laboratório, não pagamentos ou hardware reais.

## Atualização coordenada

1. Fazer backup e preservar as chaves fora do host.
2. Interromper as réplicas antigas da API de maneira coordenada e aguardar o encerramento de tarefas. Não misturar workers antigos com novos durante esta mudança de organização das filas.
3. Aplicar `prepare` pelo procedimento normal. A migration `00061` acrescenta o contador privado; não altera pagamentos ou contratos existentes.
4. Subir todas as réplicas da versão nova, conferir preflight, saúde, filas e logs.
5. Fazer backup novo e uma prova de restauração. Backups antigos continuam restauráveis, mas não possuem o manifesto exigido pela nova prova completa.

O código suporta banco operacional `c1`; não cadastrar outra célula como se houvesse roteamento de pools implementado. Instalações dedicadas usam o mesmo código em stacks separadas. Distribuir tenants entre células continua uma evolução específica.

## Backup externo e recuperação

```bash
./nexo prod backup
./nexo prod restore-check /caminho/nexo-....dump
```

Python 3 passa a ser requisito do host de backup. `NEXO_BACKUP_COPY` recebe **três argumentos**, nesta ordem: dump, checksum, manifesto. Atualizar o script de cópia para transportar os três arquivos. Os hashes cobrem dump e manifesto. Esse hash detecta corrupção; não é assinatura contra um invasor que possa substituir todo o conjunto.

A prova de produção usa a imagem `migrate` da versão atual e as chaves configuradas na instalação. Um segredo indecifrável reprova a recuperação. Não imprime o segredo. Conservar `.env`, certificados, estado WireGuard, SQLite dos sites e demais volumes fora do backup PostgreSQL, com controle de acesso. Não copiar chaves para o relatório de evidências.

Um backup local bem restaurado não comprova a existência da cópia externa. Antes do corte, baixar um conjunto do armazenamento externo e repetir a prova em outro host com as chaves recuperadas do cofre. Medir duração e perda máxima aceitável (RTO/RPO). A réplica e o segundo RADIUS do Compose estão no mesmo domínio de falha: para tolerar perda do host, a implantação precisa de infraestrutura independente e ensaio de promoção/retorno.

## Monitoramento

Usar `infra/monitoring/prometheus.yml` e `alerts.yml` em um Prometheus conectado pela rede privada à API. Configurar Alertmanager, destino e responsável conforme o ambiente. Os arquivos não publicam métricas nem enviam mensagens automaticamente.

- Não expor a porta 9090 à Internet. Na mesma rede Compose, o destino é `api:9090`; em outro host, usar rota privada/VPN e firewall.
- Regras incluem API indisponível, falha na coleta da fila, atraso, tarefas descartadas e falhas por provedor. Verificar entrega e recuperação do alerta no canal escolhido antes do aceite.
- Executar de fora do host da aplicação, com agendamento/alerta pelo monitor escolhido:

```bash
python3 scripts/monitor.py --url https://painel.exemplo.com.br/api/health
```

Para idade de backups completos e espaço em disco, executar também no host ou volume que os guarda:

```bash
python3 scripts/monitor.py --url https://painel.exemplo.com.br/api/health \
  --backup-dir /var/lib/nexoisp/backups --max-backup-age-hours 26 --min-free-percent 10
```

O programa retorna JSON e código diferente de zero em falha. A presença recente dos arquivos não verifica novamente seus hashes nem comprova cópia externa; `restore-check` faz a verificação do conteúdo. O monitor externo e a inspeção de armazenamento são provas complementares.

## Capacidade e migração

Amostra de consulta paginada em laboratório explícito, com uma sessão autorizada já obtida. Colocar o token no ambiente protegido `NEXO_CAPACITY_TOKEN`, sem gravá-lo no histórico ou no relatório:

```bash
python3 scripts/capacity.py --base http://127.0.0.1:18080 --laboratory \
  --requests 100 --concurrency 4 --max-p95-ms 1000
```

A ferramenta limita concorrência/volume, mede respostas e p95 e reprova erros ou limite excedido. Um 429 continua uma reprovação da carga escolhida: não desabilitar a proteção para ocultá-lo. O limiar é um critério de ensaio, não SLA. Medir separadamente autenticações RADIUS, relatórios, importação e tarefas com o volume e hardware do piloto.

Para conferir dois exports **já normalizados e autorizados**, sem importar ou alterar dados:

```bash
python3 scripts/migration-check.py --source origem.csv --target destino.csv
```

Formato UTF-8 CSV com colunas `source,entity,external_id,parent_external_id,amount_cents,status`. `source` identifica o sistema de origem e deve ser preservado nos dois exports; `external_id` é a identidade original. Centavos são inteiros (ou vazios quando não há valor). A ferramenta rejeita identidades duplicadas, aponta ausentes/extras/divergentes e compara quantidades/totais por entidade. Vínculos e estados também são comparados; somatórios iguais não escondem mudança de contrato.

Esse formato de conferência não é um novo importador nem um adaptador universal SGP/IXC. A normalização e os campos precisam de mapeamento confirmado com a origem. Credenciais, documentos e inventário ainda exigem conferência específica; o programa não verifica dados que não recebeu.

## Evidências locais desta entrega

- `go vet ./...` e `go test -race ./...`: aprovados. Testes que exigem URL de integração são exercitados separadamente na base descartável.
- Contrato nativo existente: 12 verificações aprovadas, incluindo concorrência financeira, outbox e rotação de segredos.
- Contrato de resiliência final, executado sequencialmente em base nova: 12 verificações aprovadas; relatório em `tests/contrato/relatorios/resilience.json`.
- Testes de trava por provedor com PostgreSQL real e pool de uma conexão: aprovados.
- Dois testes das ferramentas operacionais: aprovados, cobrindo alterações de vínculo/saldo, duplicação de identidade e exigência de conjunto completo de backup.
- Sintaxe Bash/Python e `git diff --check`: aprovados. A configuração de Prometheus foi preparada, mas sua ativação/entrega de alertas no destino não foi exercitada.

## Pontos que continuam sem aceite externo

| Ponto | Evidência necessária |
|---|---|
| Equipamentos | Fabricante/modelo/firmware, credenciais autorizadas e execução dos roteiros existentes de PPPoE, OLT/ONU, IPv6 e TR-069 |
| Infraestrutura | Domínio/HTTPS, firewall, hosts independentes quando exigidos, segredos/certificados exclusivos e preflight no destino |
| Recuperação definitiva | Cópia externa recuperada, chaves/volumes preservados, restauração em outro host e RPO/RTO acordados |
| Monitoramento definitivo | Agendamento externo, canal/responsável e prova de entrega e normalização de alertas |
| Corte de dados | Exportação real autorizada, mapeamento, reconciliação e ensaio de reversão preservando eventos posteriores |
| Capacidade | Volume e perfil de carga do piloto medidos no destino |
| Banco/PSP | Fora do escopo por solicitação do usuário; nenhuma cobrança bancária real foi acrescentada |

Esses pontos não são encerrados pela aprovação dos testes sintéticos. O [roteiro do piloto](PILOTO.md) e as [pendências](pendencias.md) continuam aplicáveis.
