# Pendências do NexoISP

Consolidado em 17/10/2026 a partir do código e dos planos anteriores. Esta lista mantém trabalho ainda necessário, sem repetir entregas concluídas nem transformar ensaio sintético em homologação de produção.

## Entrada em produção

| Prioridade | Falta | Condição de conclusão |
|---|---|---|
| P0 | Provedor, responsáveis e grupo inicial | Definir contratos/NAS do piloto, janela, responsável por incidentes e fonte autoritativa por grupo |
| P0 | Ambiente definitivo | Domínio/DNS, HTTPS, roteamento/firewall, segredos e certificados exclusivos, MFA administrativo e ausência de dados demo; executar `./nexo prod db preflight` |
| P0 | Gateway de pagamento | Escolher provedor, implementar adaptador e homologar emissão, evento repetido/perdido, baixa, cancelamento e conciliação em sandbox antes de credenciais de produção |
| P0 | Política comercial e fiscal | Definir suspensão, redução, reativação, proporcionalidade e processo fiscal; exportação contábil não emite nota |
| P0 | Homologação PPPoE no provedor | Repetir [o roteiro](lab-pppoe.md) no equipamento/firmware físico, com VPN/RADIUS e vários clientes; conferir também o ciclo financeiro completo |
| P0 | Dados reais e ensaio de corte | Exportação autorizada da origem, mapeamento, prévia e conferência de clientes, contratos, credenciais e saldos; reversão preservando alterações posteriores |
| P0 | Backup e recuperação definitivos | Configurar destino externo, habilitar o agendamento já disponível, executar cópia real e `restore-check`, guardar chaves/certificados em cofre; definir perda de dados e tempo de recuperação aceitáveis |
| P0 | Monitoramento real | Monitor externo de `/api/health`, alertas no canal do responsável, acompanhamento de agentes, operações incertas, erros financeiros e capacidade de disco |
| P0 para distribuição do site | Distribuição do FreeRADIUS | Validar a forma de entrega e as obrigações da licença antes de distribuir o pacote a terceiros |

Se a primeira entrada mantiver a cobrança no sistema anterior, definir essa fonte de verdade explicitamente e manter a suspensão financeira automática do NexoISP desligada até haver integração confiável. Não operar dois financeiros independentes sobre os mesmos títulos.

O código inclui configuração de produção, preflight, backup/restauração e unidades systemd para backup diário. Esses artefatos precisam ser configurados e exercitados no destino real; sua existência não conclui a implantação.

## Homologações ainda necessárias

| Área | O que falta comprovar |
|---|---|
| OLT Huawei | Saídas, sintaxe, login, paginação e recuperação no modelo/firmware real; seguir [OLT/ONU](expansao-olt-onu.md) |
| RADIUS e acesso | Huawei/Cisco, IPoE/hotspot e demais combinações precisam de prova no equipamento utilizado; laboratório CHR não homologa fabricantes diferentes |
| Suspensão e perfis | Perfil de bloqueio/redução, pool por plano, limite simultâneo e redirecionamento da página de aviso no NAS real |
| CGNAT | Revisão/importação do `.rsc`, interface de saída, escala, tráfego real e comportamento com jogos/VoIP; não há aplicação automática pelo agente |
| IPv6 | O RADIUS integrado entrega o prefixo reservado (Delegated-IPv6-Prefix, desde 20/10/2026); falta laboratório com DHCPv6-PD no concentrador real e entrega para concentradores por agente |
| TR-069 | Certificado HTTPS, autenticação CWMP por dispositivo e rejeição de CPE sem credenciais; modelos reais de roteadores e mudanças de Wi-Fi. GenieACS integrado não homologa todos os CPEs |
| NOC | Limiares ópticos e detecção coletiva ajustados com leituras e incidentes reais |
| Comunicação | Canal HTTP de avisos e webhooks no serviço real, com consentimento e confirmação dos resultados |
| Recuperação do site | Atualização que efetivamente altere o schema local, rollback e falhas de disco no ambiente do provedor |
| Continuidade | RADIUS e banco em hosts distintos, promoção/retorno, falha de enlace e de servidor; duas instâncias locais cobrem apenas parte das falhas |
| Capacidade | Medir o volume do piloto; benchmarks sintéticos não estabelecem SLA |
| Uso e segurança | Sessão de uso com atendentes/técnicos, leitor de tela e revisão de segurança independente; limites de taxa em memória são por réplica |

## Migração e integrações por origem

- SGP: ferramentas de leitura e exportação existem, mas faltam amostra real e mapeamento confirmado. O backup cifrado analisado não foi aberto; obter exportação legível ou procedimento oficial, sem presumir compatibilidade.
- IXC: faltam formato de exportação/backup e respostas da API necessárias ao mapeamento.
- Importação CSV: ainda não transfere todo o inventário de rede, IP fixo, documentos, usuários/permissões nem múltiplos serviços por assinante. MAC, etiquetas e histórico de atendimentos/OS/anotações já têm formato documentado.
- API nativa e webhooks já existem. Compatibilidade com rotas de SGP/IXC é outra entrega: identificar integrações realmente usadas e contratos de resposta antes de escrever adaptadores.

Consulte [Migração SGP](10-migracao-sgp.md) e [Importação CSV](importacao-csv.md) para procedimentos e limites.

## Evolução por demanda

Não bloqueia automaticamente o primeiro piloto; priorizar conforme o uso real:

- Fiscal integrado: emissor, documento e regras do provedor; emissão por empresa e certificados quando aplicável.
- Gateway: juros/multa na cobrança emitida e estorno pelo gateway; segundo gateway somente depois do primeiro homologado.
- Campo: trabalho sem conexão, fotos/assinatura na OS e check-in/check-out; armazenamento e acesso precisam de definição.
- SLA: calendário de expediente e feriados feito em 20/10/2026; falta validar com a operação real (feriados municipais, plantões).
- Estoque: depósitos, transferências, fornecedores e pedidos de compra feitos em 20/10/2026; faltam cotação, contas a pagar e custo médio.
- Comercial: viabilidade pública, regras adicionais de comissão e identidade visual opcional do provedor no portal (lote 41 em integração; provas combinadas pendentes).
- OLT: perfis/VLANs automatizados e fabricantes adicionais, um equipamento homologado por vez. O catálogo de modelos/templates de ONU e a consulta de portas PON existem desde 20/10/2026 como documentação e consulta; não aplicam nada na OLT.
- IA assistiva e novos canais: decisão de produto, serviço externo e regras de uso dos dados; sem escrita irrestrita em rede.

Não reabrir como pendência busca global, linha do tempo, avisos de saída, degraus de cobrança, API pública, SLA básico, agenda, campos personalizados, combos ou migração Go: esses recursos já possuem implementação. As pendências acima tratam das lacunas e validações restantes.


Lote 40 (30/10/2026): anexos privados de OS e cotação com conversão manual em pedido rascunho estão DONE 5/5; HTTP real exit 0 em 8461e61. A execução Go/PostgreSQL da gerência ainda aguarda recibo. A adaptação funcional não constitui homologação. Assinatura, operação offline, fiscal, pagamentos e custo contábil não integram este recorte. Por decisão do usuário, Chatwoot está fora do escopo NexoISP; outro projeto trata do chat.
