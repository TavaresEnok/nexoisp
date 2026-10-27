# AAA — Disconnect identificado e recuperação — 27/10/2026

Continuação local de `8c9815d`, tag `base/pre-b11-aaa-2026-10-27`, mesma branch/checkout oficiais. Este lote não altera schema75, ledger, clientes de pagamento, dependências ou referência visual.

## Comportamento

Disconnect agora exige usuário e Acct-Session-Id delimitados; não há fallback genérico só por usuário quando falta accounting. Identidade de NAS e sessão limita busca/fechamento; uma sessão de outro concentrador não é alvo por compartilhar login/session_id. O pacote inclui Event-Timestamp e Message-Authenticator; parser verifica origem por socket UDP conectado, Response Authenticator, HMAC quando presente, tamanho/TLVs/duplicatas e semântica de Error-Cause. Contexto cancela DNS/socket/deadline. Há um único envio, sem repetição automática de datagrama após resultado desconhecido.

Referência primária: [RFC5176 §§2.1/3.4/3.5](https://www.rfc-editor.org/rfc/rfc5176.html). A causa406 é extensão não suportada; não prova ausência. NAK503 identifica sessão inexistente. ACK autenticado ou NAK503 fecha somente a linha congelada da sessão. Resposta com HMAC presente inválido é descartada; ausência de HMAC na resposta continua permitida pelo contrato de interoperabilidade do RFC, mantendo a verificação do Response Authenticator. Isso não torna UDP uma rede confiável nem homologa firmware.

Antes do envio, os `steps` de `operation_attempts` existentes congelam ID de accounting, sessão, NAS e início; não contêm shared secret/senha. Aceite/negação conhecidos e timeout são distintos. Após timeout/crash, o histórico é consultado: sessão encerrada por accounting permite concluir, sem novo pacote; dado faltante/aberto mantém UNCERTAIN e impede novo envio. Perda do próprio commit do ACK preserva marcador prévio para consulta. NAK406 não fecha sessão. Nenhum limite de tentativas converte automaticamente efeito desconhecido em FAILED/PENDING.

Pedidos de nova versão de recurso/ONU são recusados409 enquanto há RESERVED/EXECUTING/VERIFYING/UNCERTAIN. Replay da mesma chave já existente continua recuperando sua operação. Divergência legada de versão em recuperação mantém a incerteza em vez de inventar SUPERSEDED. Expiração de reserva/validade, contrato encerrado e manutenção também não apagam efeito desconhecido: o executor interno pode consultar readback após validade, sem escrever; recuperação externa que exige tratamento especial fica preservada para conferência. Código de agente antigo não é habilitado implicitamente a ignorar essas condições.

Recuperação técnica não desfaz recebimento financeiro. `RunOperation` consulta o estado resultante, mantendo job pendente para operação PENDING/UNCERTAIN. Um recurso incerto em NAS RADIUS não bloqueia outros assinantes desse NAS; drivers físicos de OLT mantêm sua exclusão por dispositivo. A varredura antiga tem cota padrão8 por tenant, configurável `NEXO_RADIUS_MAX_OPS_PER_TENANT` (1–32), além dos jobs transacionais existentes.

## Capacidades operacionais

`GET /api/radius/status` acrescenta `capabilities`: banco de autorização acessível, contas/NAS visíveis, accounting aberto/sem atualização, operações incertas e gates de Disconnect/consumidor. Contadores usam o escopo real de tenant/POP e sua célula. A configuração global do túnel continua consultada em c1; as transações são sequenciais, sem segurar conexão global enquanto espera outra.

`features/network/radius.tsx` usa esses dados nos componentes oficiais. Banco acessível, pacote recente e aplicação de perfil no NAS são conceitos separados; sessão antiga não é fechada automaticamente pela tela. A API não declara um daemon/hardware saudável só por existir chave de configuração. Os campos legados de templates de fabricante não passam a ser prova de firmware físico.

## Flags, compatibilidade e recuperação

`NEXO_RADIUS_DISCONNECT_WRITE` novo fica **0** por padrão; envios reais exigem habilitação explícita, além do executor/jobs. Desabilitar esse envio preserva a autorização armazenada para a próxima conexão. A operação que depende de desconexão fica sinalizada, sem alegar aplicação no NAS. O relay VPN existente usa envelope IPv4; configuração de relay com destino IPv6/hostname não desvia silenciosamente para acesso direto. IPv6 direto usa socket dual stack, mas H de NAS/VSAs/PD é independente. Este lote envia Disconnect (Code40), não implementa CoA arbitrário de atributos (Code43).

O formato novo exige compatibilidade do NAS com Message-Authenticator; não há downgrade automático. Setup do equipamento, clocks, segredo/rota/túnel e firmware exigem bancada própria. Sem identidade de sessão não se promete desconectar por um comando genérico. Perda de histórico de accounting não vira prova de ausência. Resolução administrativa com prova de incerteza sem accounting permanece necessária para casos irrecuperáveis.

Rollback de código não autoriza reativar o executor anterior, que ignora o journal: manter `NEXO_GO_JOB_RADIUS=0`, preservar operações/tentativas/incerteza e conferir estado externo antes de qualquer retomada. Não há down de schema ou exclusão de dados neste lote. Manter bundle/base anterior para revisão; shared secrets produtivos e serviços reais não foram usados.

## Evidências

`implementacao-codex/lote14-b11-aaa-2026-10-27/`: antes/depois por overlay do fonte anterior, testes Go dirigidos em Linux com race, PostgreSQL descartável e NAS UDP sintético; build/vet/typecheck/build web; API/browser autenticados e captura do painel móvel. Os testes confirmam perda de resposta, recuperação após validade, timeout aberto sem reenvio, recurso bloqueado, progresso de outro assinante do mesmo NAS, 406, ACK restrito e manutenção dos totais de payments/invoice_movements. Falha inicial dos contadores revelou escopo global inadequado e foi corrigida; não se tornou SELECT global com bypass RLS.

C/T locais; H/P ausentes. Accounting duplicado/fora de ordem/restart, persistência IPv6, reconciliação de órfãos e demais quotas/saúde ainda são parte pendente de B11, com implementação própria a seguir. Não se afirma AAA completo, bancada de NAS ou projeto finalizado. Suíte global e CI hospedado não foram repetidos.
