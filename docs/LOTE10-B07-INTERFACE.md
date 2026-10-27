# B07 — operação financeira na interface oficial

Continuação no checkout NexoISP, branch `dev/lote01-consolidado-2026-10-26`. Base recuperável `base/pre-b07-interface-2026-10-27` (`e1085e1`). Schema continua **74**; nenhuma migração, alteração de dependências ou implantação neste lote.

Na ficha operacional da fatura, a seção **Cobrança no provedor** permite:

- Preparar Pix imediato (validade em segundos), Pix com vencimento (pagador/endereço/validade após vencimento) e Bolix (pagador/endereço/e-mail), usando as APIs e consumidores já existentes. Valor e vencimento são determinados pelo servidor a partir da fatura.
- Consultar intenção, produto, conta, estado da emissão, identificador remoto, última consulta de recebimentos, revisões e operações. Atualização manual e a cada 15 segundos enquanto a ficha está montada.
- Preparar remoção de cobrança emitida sem recebimento; não cancelar automaticamente a obrigação no ERP. A ação antiga de cancelar fatura é ocultada quando existe reserva de emissão, coerente com a proteção existente no banco.
- Preparar devolução parcial Pix de um recebimento não manual. O limite consultado desconta devoluções confirmadas e operações prepared/uncertain/review. A validação definitiva continua transacional no backend. Não há devolução Bolix.
- Reagendar somente consulta de emissão/operação incerta ou em revisão, com justificativa. Isso não reenvia mutações, não libera reservas e não substitui decisão administrativa.

## Contrato e autorização

Novo `GET /api/invoices/{id}/provider-billing`, `finance:read`, escopo financeiro completo (sem portal ou POP limitado). RLS permanece ativo. Outra empresa não entra no seletor; outro tenant recebe 404. O perfil financeiro obtém somente a projeção necessária, sem ganhar `settings:manage` ou acesso ao cofre.

Resposta: flags de sandbox/envio, `accounts` (id/nome/produtos), `issuances`, `operations` e `refund_payments` (recebimento original/limite). Contas selecionáveis são Efí sandbox ativas com credencial atual compatível e, para Pix, certificado não expirado. Emissões históricas continuam consultáveis mesmo com a conta desabilitada. Nenhuma consulta seleciona secret_enc, client_id, client_secret, chave Pix, PEM, opções de pagador ou corpo de retorno do PSP.

Comandos continuam nos endpoints existentes, usando cliente HTTP oficial, cookie HttpOnly/CSRF, permissões finance:write e auditoria. A tela não cria transporte bancário no navegador nem executa diretamente workers. Flags existentes continuam desligados por padrão. Preparada não significa enviada, emitida ou devolvida. O estado mostrado vem do journal; a UI não o promove por conta própria.

## Persistência da intenção

Chaves `nexo:provider-billing:v1:<tenant>:<ator>:<fatura>:issue|operation`. Web Locks serializa a preparação entre abas. O corpo e destino são persistidos **antes** do POST e congelados para replay. Falha de armazenamento ou intenção inválida impede envio. 400/422 permitem correção; 409, falha de rede e 5xx conservam intenção.

Resposta de preparação aceita não limpa a intenção. Consulta do journal reconhece preparação já persistida após perda de resposta, dispensando novo POST. Apenas emissão issued ou operação confirmed/rejected libera automaticamente a intenção local correspondente. Uma nova devolução legítima usa outro UUID e continua sujeita ao saldo disponível no backend. Não existe botão de apagar resultado incerto para reenviar.

Dados de pagador de CobV/Bolix permanecem no corpo local da intenção enquanto não terminal; não há credenciais bancárias nele. Essa retenção é limitada por estado, não por relógio: uma pendência não resolvida conserva os dados para recuperação. O journal do servidor é a fonte de verdade. Limpeza manual do navegador não apaga a reserva no servidor. A política administrativa para pendências duradouras permanece no backlog B07.

## Verificação focada

`apps/web/tests/provider-billing.test.ts`: quatro testes de replay/persistência, falha de armazenamento/escopo, contratos distintos por produto e limite/terminal de devolução. Não se repetiu a suíte web completa ou Go/race, instalação de dependências, auditoria ou testes de migração/restauração.

`e2e/frontend-v0-provider-billing.mjs`: jornada de laboratório com API e PostgreSQL descartáveis, cookie/CSRF e dados sintéticos. Três preparações de produto, resposta perdida após commit, recarga sem duplicar, devolução reservada, cancelamento sem apagar dívida, revisão por lookup e perfil de leitura sem comandos. Fixture issued/review é inserida pelo owner do laboratório; não comprova confirmação bancária. Harness/evidências externos em `implementacao-codex/lote10-b07-interface-2026-10-27/`.

Typecheck/build web e build Go aprovados. Componentes oficiais, estilos, fonte de referência v0 e snapshots não alterados. Capturas desktop/mobile são registros de execução, não aprovação visual completa. A captura de 390 px mostra recorte horizontal na ficha; origem não isolada neste lote, sem alegar homologação responsiva.

## Continuação delimitada

Falta integrar notificações próprias da API Cobranças, registro/configuração/diagnóstico de callbacks e resolução administrativa com prova/política de reemissão. A UI de revisão entregue permite **consulta**, sem fingir que resolve pendências bancárias. Também faltam visualização/obtenção dos artefatos efetivamente emitidos pelo PSP (QR/copia e cola/boleto) na pipeline Efí; o widget de meios de pagamento existente só mostra os dados já presentes na fatura.

Rede continua B10 → B09 ACS → B11 AAA; demais PSPs, atendimento/OS/estoque, WhatsApp, topologia, fiscal/CNAB, migração/restauração e piloto permanecem no backlog integral. Homologação financeira requer conta sandbox, escopos/certificados e callback próprios. Nenhum acesso real foi feito. C/T locais não equivalem a H/P, CI hospedado ou implantação.
