export const navigationRequirements = `ACESSO
├── Login
│   └── Verificação em duas etapas, quando configurada
└── Minha conta
    ├── Alterar senha
    ├── Configurar/ativar autenticação em duas etapas
    └── Desativar autenticação em duas etapas

INÍCIO
├── Painel inicial
│   ├── Pendências e próximos trabalhos
│   ├── Indicadores de assinantes, contratos e financeiro
│   ├── Resumos de rede, conexões e sinal
│   └── Últimas operações
└── Busca global
    └── Resultados com acesso às fichas correspondentes

ASSINANTES
├── Consultar
│   ├── Buscar e listar
│   ├── Exportar CSV
│   ├── Novo assinante
│   └── Abrir assinante → [nome do assinante]
│       ├── Cadastro e dados pessoais
│       │   └── Editar cadastro
│       ├── Criar/redefinir acesso ao portal
│       ├── Contratos
│       │   ├── Novo contrato
│       │   └── Abrir contrato → detalhamento abaixo
│       ├── Campos personalizados
│       │   └── Editar valores
│       ├── Anotações
│       │   ├── Nova anotação
│       │   └── Arquivar anotação
│       ├── Contatos
│       │   ├── Adicionar
│       │   ├── Editar
│       │   └── Remover
│       ├── Documentos
│       │   ├── Enviar documento
│       │   ├── Baixar
│       │   └── Excluir
│       ├── Linha do tempo
│       ├── Atendimentos
│       │   ├── Novo atendimento
│       │   └── Abrir atendimento
│       ├── Ordens de serviço
│       │   ├── Nova OS
│       │   └── Abrir OS
│       └── Privacidade/LGPD
│           ├── Baixar cópia dos dados
│           └── Anonimizar titular
├── Contratos
│   ├── Buscar
│   ├── Filtrar vigentes/encerrados
│   ├── Exportar CSV
│   └── Abrir contrato
│       ├── Trocar plano ou vencimento
│       ├── Registrar/retirar restrição de crédito
│       ├── Encerrar contrato
│       │   ├── Motivo e observação
│       │   └── Cobrar/dispensar multa, quando aplicável
│       ├── Aba Acesso
│       │   ├── Infraestrutura
│       │   │   ├── IP fixo e prefixo IPv6 reservado
│       │   │   ├── Caixa óptica e porta vinculada
│       │   │   └── Diagnosticar acesso
│       │   ├── Configuração do acesso
│       │   │   ├── Equipamento/concentrador
│       │   │   ├── PPPoE, IPoE ou hotspot, conforme integração
│       │   │   └── Usuário, senha ou identidade MAC
│       │   ├── Provisionar/reaplicar configuração
│       │   ├── Suspender
│       │   ├── Reativar
│       │   ├── Desconectar sessão
│       │   ├── Trocar senha PPPoE
│       │   ├── Vínculo de MAC
│       │   ├── Situação financeira e faturas
│       │   ├── Consumo
│       │   │   ├── Consulta por períodos
│       │   │   └── Exportação
│       │   ├── Roteador do cliente — TR-069
│       │   │   ├── Procurar e vincular equipamento
│       │   │   ├── Desvincular
│       │   │   ├── Reler informações
│       │   │   ├── Reiniciar
│       │   │   └── Alterar nome/senha do Wi-Fi
│       │   ├── Tentativas de autenticação — logs RADIUS
│       │   ├── Disponibilidade
│       │   ├── Sessões e consumo
│       │   │   └── IP, MAC, duração, tráfego e motivo de término
│       │   └── ONU vinculada
│       │       ├── Serial, OLT e porta PON
│       │       ├── Perfis e VLAN
│       │       ├── Estado desejado e observado
│       │       ├── Online/offline
│       │       ├── Sinal óptico RX/TX
│       │       ├── Autorizar
│       │       ├── Reaplicar autorização
│       │       ├── Desautorizar
│       │       ├── Vincular outra ONU após remoção
│       │       └── Histórico de operações e evidências
│       ├── Aba Contrato
│       │   ├── Dados comerciais
│       │   ├── Campos personalizados
│       │   ├── Etiquetas
│       │   ├── POP
│       │   ├── Empresa que fatura
│       │   ├── Produtos adicionais
│       │   │   ├── Adicionar produto
│       │   │   └── Encerrar adicional
│       │   ├── Área para coleta ANATEL
│       │   └── Equipamentos instalados
│       ├── Aba Condições
│       │   ├── Fidelidade
│       │   ├── Descontos
│       │   │   ├── Novo desconto
│       │   │   └── Cancelar desconto
│       │   ├── Mudanças agendadas
│       │   │   ├── Agendar
│       │   │   └── Cancelar agendamento
│       │   ├── Aditivos
│       │   │   ├── Novo aditivo
│       │   │   └── Imprimir
│       │   └── Aceite eletrônico
│       │       ├── Solicitar aceite pelo portal
│       │       └── Consultar comprovante
│       ├── Aba Ordens de serviço
│       │   ├── Listar OS do contrato
│       │   ├── Nova OS
│       │   └── Abrir OS
│       └── Aba Histórico
│           └── Eventos, alterações, datas e responsáveis
├── Planos
│   ├── Novo plano
│   ├── Ativar/desativar
│   ├── Alterar preço/velocidade → nova versão
│   ├── Histórico de versões
│   ├── Parâmetros de rede
│   │   └── Reaplicar configuração
│   ├── Fidelidade
│   └── Degraus de cobrança
└── Produtos adicionais
    ├── Cadastrar produto
    ├── Alterar preço
    └── Ativar/desativar

ATENDIMENTO
├── Atendimentos
│   ├── Buscar e filtrar
│   ├── Novo atendimento
│   └── Abrir atendimento
│       ├── Dados, prioridade e responsável
│       ├── Conversa/histórico
│       ├── Responder ao assinante
│       ├── Registrar nota interna
│       ├── Alterar situação
│       ├── Encerrar/reabrir
│       └── Abrir OS vinculada
├── Prospectos
│   ├── Buscar e filtrar por etapa
│   ├── Novo prospecto
│   └── Abrir prospecto
│       ├── Editar dados
│       ├── Alterar etapa da negociação
│       ├── Registrar contato/anotação
│       ├── Marcar perdido
│       ├── Converter em assinante
│       └── Histórico de contato
├── Meu trabalho
│   ├── OS atribuídas ao técnico
│   ├── Acesso ao telefone/endereço/mapa
│   └── Abrir/executar OS
├── Ordens de serviço
│   ├── Buscar, filtrar e exportar CSV
│   ├── Nova OS
│   └── Abrir OS
│       ├── Assinante, contrato, endereço e descrição
│       ├── Definir responsável
│       ├── Agendar/reagendar
│       ├── Adicionar/remover auxiliares
│       ├── Em análise
│       ├── Aguardando agendamento
│       ├── Saí para o local
│       ├── Iniciar execução
│       ├── Devolver para a fila
│       ├── Concluir
│       ├── Cancelar
│       ├── Checklist
│       ├── Material utilizado e devolução
│       ├── Aplicar kit de instalação
│       ├── Instalar equipamento com número de série
│       ├── Anotações
│       └── Histórico
├── Agenda
│   ├── Agenda de OS por dia/técnico
│   ├── Horários livres
│   └── Abrir OS para consultar/alterar
├── Estoque
│   ├── Novo item
│   ├── Editar item
│   ├── Ativar/desativar
│   ├── Saldo e estoque mínimo
│   ├── Movimentos
│   │   ├── Entrada
│   │   ├── Saída
│   │   └── Ajuste
│   └── Unidades com número de série
│       ├── Dar entrada
│       ├── Transferir entre almoxarifado e técnico
│       ├── Registrar retirada do assinante
│       ├── Marcar defeito
│       ├── Marcar consertada
│       ├── Dar baixa
│       └── Histórico da unidade
└── Relatórios de atendimento
    ├── Filtro por período
    ├── Prospectos por origem
    ├── Atendimentos por categoria
    └── OS por tipo

FINANCEIRO
├── Faturas
│   ├── Buscar, filtrar e exportar
│   ├── Gerar mensalidades por competência
│   ├── Resumo de recebimentos
│   ├── Exportação para contabilidade
│   └── Abrir fatura
│       ├── Valores, vencimento e situação
│       ├── Valor devido, multa, juros e descontos
│       ├── Itens
│       ├── Meios de pagamento disponíveis
│       ├── Pagamentos e estornos
│       ├── Eventos do gateway
│       ├── Baixa manual
│       ├── Estornar baixa manual
│       ├── Cancelar fatura
│       └── Resolver conciliação
├── Conciliação
│   ├── Faturas que exigem decisão
│   ├── Eventos recebidos do gateway
│   └── Consultar gateway agora
├── Política de cobrança
│   ├── Seleção de gateway: nenhum ou demonstração
│   ├── Geração automática de mensalidades
│   ├── Suspensão por inadimplência
│   ├── Reativação após pagamento
│   ├── Perfil de bloqueio
│   ├── Liberação por confiança
│   ├── Multa e juros
│   ├── Primeiro mês proporcional
│   ├── Executar verificação de inadimplência
│   └── Configurar página de aviso ao bloqueado
├── Pela ficha financeira do contrato
│   ├── Consultar/abrir faturas
│   ├── Criar acordo de pagamento
│   └── Liberar acesso por confiança
└── Relatórios de cobrança
    ├── Carteira por atraso
    ├── Recebido → por plano e forma de pagamento
    ├── Clientes sem fatura
    ├── Candidatos a cancelamento por atraso
    └── Exportar CSV

REDE / FTTX
├── Agentes e equipamentos
│   ├── Concentradores
│   │   ├── Novo concentrador
│   │   ├── Instruções de configuração
│   │   ├── Parâmetros RADIUS
│   │   ├── Trocar segredo
│   │   ├── Criar/refazer túnel WireGuard ou L2TP
│   │   ├── Reaplicar contas
│   │   └── Converter equipamento para autenticação integrada
│   ├── Agentes locais
│   │   ├── Novo agente
│   │   ├── Credenciais
│   │   ├── Rotacionar token
│   │   ├── Aceitar novo certificado
│   │   └── Revogar/reativar
│   └── Equipamentos e OLTs
│       ├── Novo equipamento → escolher integração/driver
│       ├── Cadastrar OLT e vincular ao agente
│       ├── Consultar conectividade e quantidade de contas/ONUs
│       ├── Entrar/sair de manutenção
│       ├── Parâmetros RADIUS, para equipamentos compatíveis
│       └── Reaplicar contas, quando disponíveis
├── Rede óptica — FTTH
│   ├── FTTx - OLT
│   ├── FTTx - PON
│   ├── FTTx - CTO
│   ├── FTTx - ONU Tipo
│   ├── FTTx - ONU Template
│   └── ACS - Template
├── Endereços IP e CGNAT
│   ├── Blocos de endereços
│   │   ├── Novo bloco
│   │   ├── Consultar endereços
│   │   ├── Alocar/reservar endereço
│   │   ├── Liberar endereço
│   │   ├── Delegar/liberar prefixo IPv6
│   │   └── Excluir bloco
│   ├── Planos de CGNAT
│   │   ├── Novo plano
│   │   ├── Conferir capacidade
│   │   ├── Mapa de endereços/portas
│   │   ├── Baixar script RouterOS
│   │   └── Encerrar plano
│   └── Rastrear conexão por IP público, porta e instante
├── Operações
│   ├── Todas/em andamento/com problema
│   ├── Divergências entre intenção e estado observado
│   └── Evidências da operação
│       └── Tentativas, resultados e recuperação
└── Manutenções
    ├── Novo aviso
    ├── Definir período e equipamento afetado
    ├── Avisar afetados
    ├── Avisar normalização
    └── Cancelar

RELATÓRIO
├── Mapa
├── Consultar ONU
├── Online agora
│   ├── Buscar sessões
│   ├── IP, MAC, tempo conectado, NAS e POP
│   └── Desconexão de sessões selecionadas
└── Consulta de IP
    ├── Informar ofício, IP, porta e período
    ├── Resultado e evidências
    ├── Consultas anteriores
    ├── Exportar CSV
    └── Imprimir relatório

ADMINISTRAÇÃO
├── Usuários
│   ├── Novo usuário
│   ├── Alterar papel
│   ├── Definir POPs permitidos
│   ├── Bloquear/desbloquear
│   └── Redefinir autenticação em duas etapas
├── Empresas
│   ├── Nova empresa
│   └── Tornar empresa padrão
├── Avisos
│   ├── Configurar destino dos alertas
│   ├── Enviar aviso de teste
│   ├── Consultar últimos avisos
│   └── Entregar pendentes
├── Avisos ao assinante
│   ├── Aba Régua → criar, ativar/desativar e excluir regras
│   ├── Aba Modelos → criar e excluir modelos
│   ├── Aba Canais de envio
│   │   ├── Criar, ativar/desativar e excluir canal
│   │   └── Enviar teste
│   ├── Aba Histórico
│   └── Rodar régua agora
├── Integrações
│   ├── Aba Tokens da API
│   │   ├── Criar token
│   │   ├── Copiar credencial
│   │   └── Revogar
│   ├── Aba Webhooks
│   │   ├── Novo endpoint
│   │   ├── Ativar/desativar
│   │   ├── Testar
│   │   ├── Trocar segredo
│   │   └── Excluir
│   └── Aba Entregas
│       ├── Consultar resultado/tentativas
│       └── Reenviar
├── Catálogos e SLA
│   ├── Aba Catálogos
│   │   ├── Tipos de ocorrência
│   │   ├── Classificações
│   │   ├── Causas-raiz
│   │   ├── Origens
│   │   ├── Motivos de OS
│   │   ├── Motivos de encerramento de contrato
│   │   └── Tipos de anotação
│   ├── Aba SLA
│   │   ├── Nova política
│   │   └── Indicadores de cumprimento
│   ├── Aba Satisfação
│   │   └── Pesquisas, notas e comentários
│   ├── Aba Campos personalizados
│   │   ├── Criar campo para assinante ou contrato
│   │   └── Ativar/desativar
│   ├── Aba Kits de instalação
│   │   ├── Criar kit e adicionar itens
│   │   └── Ativar/desativar
│   └── Aba Comissões
│       ├── Regras por OS/venda
│       └── Apuração por período e pessoa
├── Coleta ANATEL — DICI
│   ├── Competência e prévia
│   ├── Municípios sem código IBGE
│   ├── Planos sem tecnologia de acesso
│   └── Baixar arquivo
├── Importação
│   ├── Selecionar arquivo
│   ├── Mapear campos
│   ├── Tratar correspondência de planos
│   ├── Simular e revisar erros/avisos
│   ├── Aplicar importação
│   └── Consultar lotes importados
└── Auditoria
    ├── Consultar eventos
    └── Configurar retenção de dados

OPERAÇÃO DO SAAS — acesso exclusivo do operador
└── Provedores
    ├── Novo provedor e administrador inicial
    ├── Suspender/reativar provedor
    ├── Liberar módulos
    ├── Entrar em acesso de suporte com justificativa
    └── Encerrar acesso de suporte

PORTAL DO ASSINANTE — após entrar com conta de assinante
├── Resumo e próxima fatura
├── Meus planos
├── Meu consumo
├── Minhas faturas
│   └── Abrir pagamento e copiar informações disponíveis
├── Meus dados
├── Meu Wi-Fi → alterar nome/senha
├── Religar internet por confiança, quando permitido
├── Atendimento
│   ├── Abrir chamado
│   ├── Consultar conversa
│   └── Enviar resposta
├── Documentos para aceitar
│   ├── Ler documento
│   └── Registrar aceite
├── Pesquisa de satisfação
│   └── Enviar nota e comentário
└── Sair

PÁGINA PÚBLICA
└── Aviso ao assinante bloqueado, quando configurado
`;
