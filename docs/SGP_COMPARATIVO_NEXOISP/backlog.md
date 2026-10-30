# Backlog priorizado e dependências

Os IDs Cxx apontam para [a matriz](matriz_capacidades.csv); AUD-xx apontam para [as entregas e testes](melhorias-e-validacao.md). Prioridade não equivale a autorização para tocar dados, pagamentos ou equipamentos de produção.

## Lote implementado

| ID | Capacidade | Entrega | Situação |
|---|---|---|---|
| AUD-01 | C03/C08/C10 | Datas de calendário antes da persistência | Implementado e verificado na API sintética |
| AUD-02 | C05 | Custom válido e bloqueio de escrita após anonimização | Implementado e verificado com tenant/papel distintos |
| AUD-03 | C16 | Auxiliar idempotente, promoção e imutabilidade após encerramento | Implementado e verificado em banco e histórico |
| AUD-04 | C16 | Serialização das mudanças de equipe da OS | Implementado e verificado em concorrência |
| AUD-05 | C17/C18 | Exercício do fluxo já existente de saldo, material, kit e devolução | Verificado em dados fictícios; não foi criado módulo de compras |
| AUD-06 | C34/C37 | Busca/detalhe resistentes a respostas fora de ordem e paginação por filtro | Implementado e verificado em Chromium, viewport móvel |
| AUD-07 | C03 | Edição parcial de assinante sem sobrescrever campos omitidos | Implementado e verificado por API e leitura posterior |
| AUD-08 | Ferramentas | Playwright corrigido, imagem alinhada e lockfile respeitado | Audit de dependências e navegador atualizado verificados; resultados em execucao.json |
| UX-01 | C16 | Motivo de espera/cancelamento da OS explícito e botão coerente | Implementado; tipos/build e inspeção; fluxo visual específico não homologado |

## Próximas entregas independentes de integração externa

| Prioridade | Entrega funcional | Dependência/decisão | Aceite mínimo |
|---|---|---|---|
| P1 | C03 — ampliar cadastro e instalação | Aprovar quais campos são necessários; E/EJ exigem documento/país e regras de duplicidade próprios | Cadastro/edição/consulta/importação/exportação/LGPD com os mesmos campos e sem exigir CPF de estrangeiro |
| P1 | C19 — compras e depósitos | Aprovar recebimento, reserva, transferência, custo e cancelamento; não deduzir regras fiscais pelo HTML | Compra → recebimento → local → saída/OS → devolução, com saldo, série e auditoria; rollback em falha |
| P1 | C15/C16 — expediente/SLA e campo | Definir calendário, feriados, fuso, check-in e uso de localização | Prazos reconciliados com exemplos, transições autorizadas e histórico; sem coletar geolocalização por padrão |
| P1 | C37 — relatórios por tarefa | Lote 44 integra exportações CSV operacionais de cotação e locais por página (rotas GET e contrato HTTP); provas próprias de browser/SQL pendentes | Mesma base reconcilia UI/CSV, permissões e paginação; busca/filtro atual prevalece |
| P1 | C36 — mapeamento de importação | Amostra autorizada e schema da origem; nenhum segredo dos espelhos é uma credencial autorizada | Relatório de perdas, N serviços, saldos e credenciais conferidos; ensaio idempotente |
| P2 | C24/C42 — inventário de rede | CRUD passivo de poste, torre e condomínio por POP validado na matriz (lote 42 reconciliado com rastro real de browser 43); definir VLAN, QinQ e topologia restante | CRUD/consulta com consistência e permissão; sem comandos livres nem efeito no NAS |
| P2 | C34 — marca do provedor e preferência visual | Recorte opcional de nome e logotipo em integração no lote 41 | Provas combinadas e revisão pendentes; sem assets externos ou personalização de cores |

Essas são especificações para decisão, não lacunas encerradas pela matriz. Não acrescentar somente tabelas/botões para marcar um módulo como entregue.

## Bloqueios de lançamento que dependem do provedor/serviço

| Prioridade | Capacidade | Falta | O que pode avançar antes |
|---|---|---|---|
| P0 | C11 | Gateway escolhido, contrato/documentação e sandbox | Especificar emissão, cancelamento, duplicidade, assinatura, baixa e conciliação; manter demo explícito |
| P0 | C12/C13 | Documento fiscal, emissor, certificado e regras aprovadas | Mapear estados e validações; não emitir nem cancelar para testar produção |
| P0 | C21/C22/C25/C27 | Modelos/firmwares, acesso autorizado e equipamento de laboratório | Manter drivers e roteiros; repetir com o equipamento definido, não com cookies do acervo |
| P0 | C35 | Domínio/HTTPS, destino externo de backup, RPO/RTO e responsável por alertas | Configuração existente e procedimentos prontos; ainda é necessário exercitar o destino real |
| P0 | C36 | Base e grupo piloto, saldos, credenciais e fonte autoritativa | Preview, relatório de conferência e plano de reversão preservando eventos posteriores |
| P1 | C29/C30/C31/C32/C44 | Provedores de canal/assinatura/bureau/SVA/mapa e seus contratos | Aprovar escopos, proteção de segredos, estados de erro e critérios de sandbox |

## Decisões ainda não aprovadas

RH completo/frota, grupos arbitrários de permissões, portadores/CNAB/caixa completo, integração de IA, calendário de feriados, dispositivos adicionais e ampliação do inventário. Sua presença nos menus do SGP não aprova automaticamente implementá-los no NexoISP. Falta também aprovar o inventário de referência e selecionar as rotas de integrações que realmente precisam sobreviver ao corte.

## Trabalho de auditoria ainda aberto

A revisão documental dos [101 títulos](revisao_101_menus.csv) e dos [956 controles](campos_44_formularios.csv) foi concluída para a retirada dos espelhos. Cada controle tem destinação, proposta/questão e aceite; não se trata de aprovação de todas as regras. Permanecem: decidir escopos e regras registrados por campo/formulário; completar cenários de leitura/edição/erro de cada capacidade fora do lote verificado; obter comportamentos sanitizados em homologação autorizada para o que depende do produto de origem. A cópia privada permite eventual consulta excepcional, mas não é dependência do backlog ou do verificador. Nenhum fluxo pode ser encerrado por contagem de arquivos ou HTTP 200.


Lote 40 (30/10/2026): anexos privados de OS e cotação com conversão manual em pedido rascunho estão em integração; revisão independente e provas no PostgreSQL real, navegador e CI permanecem pendentes. A adaptação funcional não constitui homologação. Assinatura, operação offline, fiscal, pagamentos e custo contábil não integram este recorte. Por decisão do usuário, Chatwoot está fora do escopo NexoISP; outro projeto trata do chat.
