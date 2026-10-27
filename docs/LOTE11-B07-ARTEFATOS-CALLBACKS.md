# B07 — artefatos e notificações

Schema 74 preservado; sem migração ou dependência nova. Continuação da base `32d9d59` na branch local de desenvolvimento.

## Funcionalidades

- Cob/CobV obtêm `pixCopiaECola` e, quando há loc.id, consultam GET `/v2/loc/{id}/qrcode` no cliente autenticado existente. Falha dessa consulta opcional não impede recebimento/lookup financeiro. Imagem e código divergentes não são combinados.
- Bolix lê linha digitável, URL e Pix disponíveis na cobrança consultada. Nunca fabrica códigos a partir do ID. Identidade/conta/valor/vencimento continuam validados antes da apresentação.
- `providers.PaymentArtifacts` aceita somente imagem data PNG ou SVG com geometria inerte e tamanho limitado; rejeita scripts, eventos, referências/recursos externos e URLs de boleto fora dos hosts HTTPS de visualização Efí. O campo existente `invoices.payment_methods` é atualizado no vínculo transacional da emissão e nas consultas. Cobrança inativa limpa os artefatos; não se altera caixa por causa de apresentação.
- A ficha exibe QR como imagem, copia o código/linha com ação explícita e oferece link seguro. A imagem não é despejada como texto base64. O grid operacional foi limitado à largura disponível; o recorte horizontal da ficha observado no lote 10 não se reproduziu no teste de 390 px. Referência v0/componentes não alterados.
- Novo POST público `/api/callbacks/efi/charges/{id}`, exclusivamente sandbox habilitado, recebe formulário `notification=<token>` limitado a 4 KiB. Corpo não aceita valor/status/tenant. Persistência ocorre antes do 200. Não reutiliza mTLS/Pix nem considera o POST autenticado pelo fornecedor.
- Cada entrega ganha ID durável: a Efí reutiliza o token em mudanças de status. Agrupar um lote por conta/token reduz consultas, mas só os IDs capturados antes do HTTP são reconhecidos; entrega durante consulta permanece para outra passagem. Limite de 1000 avisos unmatched por conta responde 429 sem perda silenciosa.
- Consumidor PSP_RECEIPTS consulta GET `/v1/notification/{token}` usando credenciais da própria conta, confere charge_id/custom_id e agenda o GET autoritativo da cobrança. Históricos fora da conta não associam faturas. O corpo do aviso e o status do histórico não postam caixa; o motor de recebimentos existente permanece responsável pela idempotência.
- Novo GET/POST `/api/financial-connections/{id}/callback`, settings:manage e escopo completo. GET mostra configuração/contadores, sem token/segredo/payload. POST registra callback Pix com GET prévio, PUT e GET de confirmação. Outra URL existente exige `replace_existing=true` explícito e justificativa; uma chave Pix aceita uma URL. Auditoria de tentativa é gravada antes do HTTP; resultado sem confirmação permanece assim registrado. Rotação de credenciais é serializada com a configuração pela trava da conta, sob prazo máximo de 40 segundos.
- Painel de callbacks fica junto ao cofre na interface administrativa. Bolix novo recebe URL server-owned na emissão; configuração é congelada para replay. Emissões antigas sem URL não são atualizadas silenciosamente. Configuração Pix não significa homologação do mTLS público.

## Configuração (não aplicada em produção)

Novos gates, default **0**: `NEXO_GO_EFI_CHARGES_CALLBACK_ENABLED`, `NEXO_GO_EFI_CALLBACK_REGISTRATION`. Origens opcionais `NEXO_GO_EFI_CHARGES_CALLBACK_ORIGIN`, `NEXO_GO_EFI_PIX_CALLBACK_ORIGIN` exigem origem HTTPS sem porta, caminho, credenciais, query ou IP. A URL nunca é aceita do formulário de emissão. Sem registro automático durante abertura de tela ou inicialização.

Pix mantém listener/certificado/chave/pins próprios em `NEXO_GO_EFI_WEBHOOK_*`; configuração inválida impede iniciar o listener. Registro só é ofertado com configuração e gate explícitos. Rotas externas precisam de TLS/encaminhamento reais na homologação; nenhum certificado/chave/configuração produtiva foi usado neste avanço.

Cobranças não autentica o POST; o aviso é uma pista não verificada e só a consulta OAuth determina sua origem. Avisos não correspondidos/temporariamente indisponíveis permanecem no inbox; conflito/rejeição exige revisão. Retenção/arquivamento e resolução administrativa de pendências continuam itens explícitos; não foi adicionada exclusão automática de histórico.

## Verificação e limites

Dois pacotes Go de contrato/transporte afetados aprovados (incluem artefatos, SVG/URL, notificações e registro por readback). Um teste PostgreSQL dirigido aprovou entregas com mesmo token, chegada durante consulta, ausência de caixa por aviso e persistência/limpeza dos artefatos. API real de laboratório aprovou callback antes do 200, repetição, formato/tamanho, diagnóstico e isolamento. Um roteiro de navegador aprovou emissão/intenção anterior, QR/cópia, consulta/operações/perfis e limite de largura a 390 px. Build web e Go aprovados. Sem suíte global, instalação, teste de migração, deploy ou CI hospedado.

Evidências em `implementacao-codex/lote11-b07-artefatos-callbacks-2026-10-27/`. QR em navegador e estados issued/review são fixtures sintéticas; testes de transporte usam HTTPS/mTLS loopback. Não houve acesso autenticado Efí, envio real ou homologação financeira. C/T locais, H/P não executados.

Fontes primárias: https://dev.efipay.com.br/docs/api-pix/payload-locations/ ; https://dev.efipay.com.br/docs/api-pix/webhooks/ ; https://dev.efipay.com.br/docs/api-cobrancas/notificacoes/ ; https://dev.efipay.com.br/docs/api-cobrancas/boleto/ . Referência local de tipos/QR inspecionada em `estudo de pagamentos/pix-e-gateways/pagamentos/src/provider/efi/` antes da consulta às fontes. Nenhuma instrução desses repositórios foi executada como autorização.
