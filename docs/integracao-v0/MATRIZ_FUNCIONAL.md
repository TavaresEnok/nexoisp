# Matriz de cobertura funcional

Origem: `docs/INVENTARIO_FUNCIONAL_GO.md`. As 169 unidades incluem capacidades parciais, demonstrativas e internas; os estados do backend são preservados. O JSON correspondente mantém endpoints, restrições e evidências. A situação de cada unidade é independente da presença de uma página ou de um menu.

| ID | Estado no backend | Funcionalidade | Integração |
|---|---|---|---|
| AC-01 | Implementada | Autenticar e encerrar sessão | Integrada e validada |
| AC-02 | Demonstrativa | Preenchimento com contas de demonstração | Pendente |
| AC-03 | Implementada | Busca unificada e abertura de fichas | Parcial |
| AC-04 | Implementada | Menu, tema, navegação móvel e suporte visível | Parcial |
| AC-05 | Implementada | Visão inicial e prioridades pessoais | Parcial |
| AC-06 | Implementada | Painéis de operação e caixa | Pendente |
| AC-07 | Implementada | Trocar senha própria | Integrada e validada |
| AC-08 | Implementada | Gerenciar TOTP | Integrada e validada |
| AS-01 | Implementada | Listar, buscar e exportar cadastro | Integrada e validada |
| AS-02 | Implementada | Cadastrar/editar/inativar assinante | Integrada e validada |
| AS-03 | Implementada | Ficha e contratos do titular | Parcial |
| AS-04 | Implementada | Criar/redefinir acesso de portal | Integrada e validada |
| AS-05 | Implementada | Manter contatos e consentimento | Integrada e validada |
| AS-06 | Implementada | Anotações estruturadas | Integrada e validada |
| AS-07 | Implementada | Anexar, baixar e excluir documentos | Integrada e validada |
| AS-08 | Implementada | Linha do tempo consolidada | Integrada e validada |
| AS-09 | Implementada | Exportar dados pessoais | Integrada e validada |
| AS-10 | Implementada | Anonimizar titular | Integrada e validada |
| CO-01 | Implementada | Catálogo e versão comercial | Integrada e validada |
| CO-02 | Implementada | Degraus de inadimplência | Integrada e validada |
| CO-03 | Implementada | Fidelidade padrão | Integrada e validada |
| CO-04 | Implementada | Parâmetros de rede e reaplicação por plano | Integrada e validada |
| CO-05 | Implementada | Catálogo de adicionais recorrentes | Integrada e validada |
| CO-06 | Implementada | Pesquisar, listar e exportar contratos | Integrada e validada |
| CO-07 | Implementada | Criar vínculo comercial | Integrada e validada |
| CO-08 | Implementada | Ficha e alteração de plano/vencimento | Integrada e validada |
| CO-09 | Implementada | Encerrar contrato com decisão sobre multa | Integrada e validada |
| CO-10 | Implementada | Marcar/liberar restrição comercial | Integrada e validada |
| CO-11 | Implementada | Separar comercial, acesso e velocidade | Integrada e validada |
| CO-12 | Implementada | Etiquetas | Integrada e validada |
| CO-13 | Implementada | Vincular POP | Integrada e validada |
| CO-14 | Implementada | Empresa faturadora e área | Integrada e validada |
| CO-15 | Implementada | Contratar/encerrar adicionais | Integrada e validada |
| CO-16 | Implementada | Equipamentos e recolhimento | Parcial |
| CO-17 | Implementada | Fidelidade e cotação de rescisão | Integrada e validada |
| CO-18 | Implementada | Desconto recorrente | Integrada e validada |
| CO-19 | Implementada | Mudança agendada | Integrada e validada |
| CO-20 | Implementada | Registrar aditivo | Integrada e validada |
| CO-21 | Implementada | Solicitar e comprovar aceite simples | Parcial |
| CO-22 | Implementada | Histórico comercial | Integrada e validada |
| CO-23 | Implementada | Valores de campos personalizados | Integrada e validada |
| CR-01 | Implementada | Funil, listagem e ficha de prospecto | Integrada e validada |
| CR-02 | Implementada | Manter dados do prospecto | Integrada e validada |
| CR-03 | Implementada | Etapas e contatos | Integrada e validada |
| CR-04 | Implementada | Converter em assinante | Integrada e validada |
| CR-05 | Implementada | Listar e abrir chamados | Integrada e validada |
| CR-06 | Implementada | Abrir protocolo | Integrada e validada |
| CR-07 | Implementada | Responsável, conversa, notas e estado | Integrada e validada |
| CR-08 | Implementada | Criar OS vinculada ao atendimento | Integrada e validada |
| CR-09 | Implementada | Relatório CRM por período | Integrada e validada |
| OS-01 | Implementada | Listagem de OS | Integrada e validada |
| OS-02 | Implementada | Cadastrar OS e endereço de atendimento | Integrada e validada |
| OS-03 | Implementada | Atribuir responsável e agendamento | Integrada e validada |
| OS-04 | Implementada | Fluxo de execução e conclusão | Integrada e validada |
| OS-05 | Implementada | Auxiliares, kit e checklist | Integrada e validada |
| OS-06 | Implementada | Lançar e devolver material | Integrada e validada |
| OS-07 | Implementada | Instalar equipamento por série | Integrada e validada |
| OS-08 | Implementada | Anotações e eventos | Integrada e validada |
| OS-09 | Implementada | Operação móvel do técnico | Integrada e validada |
| OS-10 | Implementada | Agenda por técnico, conflitos e janelas | Integrada e validada |
| OS-11 | Implementada | Catálogo de materiais | Pendente |
| OS-12 | Implementada | Entradas, saídas, ajustes e consulta | Pendente |
| OS-13 | Implementada | Receber lote e distribuir unidades | Pendente |
| OS-14 | Implementada | Retirada, defeito, conserto, baixa e histórico | Pendente |
| FI-01 | Implementada | Listagem, filtros e visão financeira | Integrada e validada |
| FI-02 | Implementada | Geração idempotente por competência | Integrada e validada |
| FI-03 | Implementada | Consulta detalhada e saldo devido | Integrada e validada |
| FI-04 | Implementada | Recebimento integral/parcial, taxas e desconto | Integrada e validada |
| FI-05 | Implementada | Estorno de baixa manual | Integrada e validada |
| FI-06 | Implementada | Cancelamento de título com motivo | Integrada e validada |
| FI-07 | Implementada | Decisão manual de divergência | Integrada e validada |
| FI-08 | Implementada | Extrato financeiro do contrato | Integrada e validada |
| FI-09 | Implementada | Renegociar títulos | Integrada e validada |
| FI-10 | Implementada | Conceder prazo e consultar histórico | Parcial |
| FI-11 | Implementada | Configurar regras de cobrança | Parcial |
| FI-12 | Implementada | Configurar página pública de bloqueio/redução | Integrada e validada |
| FI-13 | Implementada | Exportar CSV contábil | Integrada e validada |
| FI-14 | Implementada | Quatro relatórios e CSV | Integrada e validada |
| FI-15 | Demonstrativa | Conciliação automática com gateway demo | Integrada e validada |
| FI-16 | Demonstrativa | Simulação de pagamento e cobrança | Integrada e validada |
| FI-17 | Não confirmado | Cobrança bancária real, Pix/boleto pagável | Limitação preservada |
| RE-01 | Implementada | Indicadores e inventário de agentes/equipamentos | Pendente |
| RE-02 | Implementada | Cadastrar e administrar agente | Pendente |
| RE-03 | Implementada | Cadastrar equipamento conectado a agente | Pendente |
| RE-04 | Implementada | Adicionar NAS RADIUS integrado | Pendente |
| RE-05 | Implementada | Parâmetros, segredo, túnel e reaplicação | Pendente |
| RE-06 | Implementada | Converter concentrador legado ao integrado | Pendente |
| RE-07 | Implementada | Criar acesso e manter credenciais | Pendente |
| RE-08 | Implementada | Provisionar, suspender, reativar e desconectar | Pendente |
| RE-09 | Implementada | Inspecionar fila e evidências de operações | Pendente |
| RE-10 | Implementada | Consultar sessões e solicitar desconexão | Pendente |
| RE-11 | Implementada | Consultar sessões, tráfego e tentativas | Pendente |
| RE-12 | Implementada | Vincular equipamento e administrar Wi-Fi | Pendente |
| RE-13 | Demonstrativa | Equipamentos e observações simuladas | Pendente |
| RE-14 | Implementada | Visualizar uso e disponibilidade estimada | Pendente |
| IN-01 | Implementada | Descobrir e vincular ONU ao contrato | Pendente |
| IN-02 | Implementada | Enviar comandos e acompanhar execução | Pendente |
| IN-03 | Parcial | Cobertura de equipamentos OLT | Pendente |
| IN-04 | Implementada | Cadastrar e manter CTO/CEO | Pendente |
| IN-05 | Implementada | Reservar e liberar porta | Pendente |
| IN-06 | Parcial | Projeto físico completo da rede óptica | Pendente |
| IN-07 | Implementada | Visão operacional e configurações | Pendente |
| IN-08 | Implementada | Diagnóstico baseado em regras e evidências | Pendente |
| IN-09 | Implementada | Mapa de contratos, POPs e caixas | Pendente |
| IN-10 | Implementada | Manter pools e reservas IPv4/IPv6 individuais | Pendente |
| IN-11 | Parcial | Reservar prefixo para contrato | Pendente |
| IN-12 | Implementada | Planejar blocos de portas e gerar script | Pendente |
| IN-13 | Parcial | Encontrar o responsável em um instante | Pendente |
| IN-14 | Implementada | Pesquisa legal por IP e período | Pendente |
| IN-15 | Parcial | Identificar titular IPv6 anterior | Pendente |
| IN-16 | Implementada | Comunicar manutenção programada | Pendente |
| IN-17 | Implementada | Consultar endereços, prefixos e caixa | Pendente |
| AD-01 | Implementada | Cadastro e gestão da equipe | Pendente |
| AD-02 | Parcial | Redefinição de senha de outro usuário | Pendente |
| AD-03 | Implementada | Provedores e módulos de produto | Pendente |
| AD-04 | Implementada | Empresas de faturamento | Pendente |
| AD-05 | Implementada | Cadastrar e administrar POPs | Pendente |
| AD-06 | Implementada | Notificações do provedor via webhook | Pendente |
| AD-07 | Implementada | Cadastrar e testar canais de mensagem | Pendente |
| AD-08 | Implementada | Criar e excluir textos com variáveis | Pendente |
| AD-09 | Implementada | Disparar mensagens de cobrança | Pendente |
| AD-10 | Implementada | Credenciais para API pública | Pendente |
| AD-11 | Implementada | Destinos, assinatura e entregas | Pendente |
| AD-12 | Implementada | Tipos, classificações, causas e motivos | Pendente |
| AD-13 | Implementada | Políticas e acompanhamento de prazo | Pendente |
| AD-14 | Implementada | Consultar pesquisas de OS | Pendente |
| AD-15 | Implementada | Definir e usar campos de assinante/contrato | Pendente |
| AD-16 | Implementada | Criar kits de materiais | Pendente |
| AD-17 | Parcial | Regras e relatório de comissões | Pendente |
| AD-18 | Parcial | Dados DICI por competência | Pendente |
| AD-19 | Implementada | Importar CSV em lotes e conferir erros | Pendente |
| AD-20 | Parcial | Migração automatizada de qualquer instalação SGP | Pendente |
| AD-21 | Implementada | Consultar eventos e retenção | Pendente |
| PO-01 | Implementada | Situação dos planos e acesso | Pendente |
| PO-02 | Implementada | Consultar títulos e abrir meios de pagamento | Pendente |
| PO-03 | Implementada | Liberação temporária por confiança | Pendente |
| PO-04 | Implementada | Resumo e série temporal de uso | Pendente |
| PO-05 | Implementada | Alterar Wi-Fi do próprio CPE | Pendente |
| PO-06 | Implementada | Abrir chamado e responder | Pendente |
| PO-07 | Implementada | Responder sobre OS concluída | Pendente |
| PO-08 | Implementada | Ler e aceitar solicitação | Pendente |
| PO-09 | Parcial | Quitar fatura em instituição financeira | Pendente |
| BE-01 | Somente backend | Catálogo e consultas externas autorizadas | Backend preservado |
| BE-02 | Somente backend | Criar atendimento e OS por integração | Backend preservado |
| BE-03 | Somente backend | Endereço de instalação específico | Backend preservado |
| BE-04 | Somente backend | Indicação de outro contrato | Backend preservado |
| BE-05 | Somente backend | Campos adicionais de atendimento e conversão de lead | Backend preservado |
| BE-06 | Somente backend | Atualização de senha de usuário, dados de POP/empresa e parâmetros de qualidade | Backend preservado |
| BE-07 | Somente backend | Editar propriedades além dos controles visuais | Backend preservado |
| BE-08 | Somente backend | Consultar bloco por IP privado e titulares históricos | Backend preservado |
| BE-09 | Somente backend | Filtros adicionais de relatório/exportação | Backend preservado |
| BE-10 | Somente backend | Autenticar, sincronizar e despachar operações | Backend preservado |
| BE-11 | Somente backend | Fila, assinatura e recuperação de operações | Backend preservado |
| BE-12 | Somente backend | Autorização, accounting e desconexão | Backend preservado |
| BE-13 | Somente backend | Executar comandos e relatar observações | Backend preservado |
| BE-14 | Somente backend | Gerir configuração e túneis dos NAS | Backend preservado |
| BE-15 | Somente backend | Integrar CPE TR-069 via HTTP | Backend preservado |
| BE-16 | Somente backend | Cobrança, suspensão, confiança e reconciliação | Backend preservado |
| BE-17 | Somente backend | Avisos, webhooks, SLA, alertas e limpeza | Backend preservado |
| BE-18 | Somente backend | Sincronização e agregação de RADIUS | Backend preservado |
| BE-19 | Somente backend | Preparação, migrações e diagnóstico operacional | Backend preservado |
| BE-20 | Somente backend | Sessão, CSRF, MFA, escopo e auditoria | Backend preservado |
| BE-21 | Somente backend | Saúde, métricas e especificação interna | Backend preservado |
| BE-22 | Somente backend | Backup, cópia e restauração | Backend preservado |
| BE-23 | Parcial | Distribuição em múltiplas células de dados | Pendente |
| BE-24 | Somente backend | Consultar indicações | Backend preservado |
| BE-25 | Somente backend | Consultar origens de NAS autorizadas | Backend preservado |
| BE-26 | Somente backend | Criar cobrança avulsa | Backend preservado |
| BE-27 | Somente backend | Excluir etiqueta do catálogo | Backend preservado |
