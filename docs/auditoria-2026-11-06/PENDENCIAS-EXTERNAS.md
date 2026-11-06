# Pendências externas — lista de ações

Fonte única das ações externas desta auditoria, em 06/11/2026. A cobrança permanece na origem, fiscal inativo, suspensão/reativação manuais e nenhum aviso automático. Homologações de fases futuras não bloqueiam por si só a fase 1.

| ID | Gate | Ação exata e evidência necessária | Responsável a designar |
|---|---|---|---|
| E01 | Esclarecer divergência do CI | Fornecer acesso autenticado aos logs completos e artefatos dos runs 41547653818 e 41547651078; comparar erro original, versões, setup, portas e limpeza. API pública confirma SHA/workflow e etapa, mas logs retornam 403. Não substituir essa análise por rerun verde | Administrador GitHub |
| E02 | Piloto | Definir provedor, grupo reversível, fonte de verdade por domínio, janela, responsáveis, condições de interrupção e retorno | Dono + operador do provedor |
| E03 | Migração real | Obter exportação autorizada SGP/IXC legível, mapear tipos, conferir amostras/saldos/vínculos e ensaiar corte/reversão em ambiente isolado. Importação implementada não substitui esse aceite | Operador + responsável pelos dados |
| E04 | Publicação | Definir host/projeto/volumes exclusivos, segredos/MFA/certificados, DNS/NAT e virtual host; revisar a configuração em PUBLICACAO.md, testar de fora da LAN e executar preflight. Nenhum proxy foi alterado | Administrador da infraestrutura |
| E05 | Recuperação operacional | Configurar cópia fora do host e cofre separado de chaves/.env/certificados e SQLite dos sites; testar perda do host e restaurar com o operador, reconciliando filas e registros posteriores. Aceitar/medir metas RPO 24 h e RTO 4 h, sem inferi-las do teste local | Operador + infraestrutura |
| E06 | Acesso do piloto | Disponibilizar NAS físico/modelo/firmware; homologar PPPoE, perfil, suspensão/reativação manuais, desconexão e resultado incerto. UDP/CHR/simulador não homologam hardware | Operador de rede |
| E07 | Operação assistida | Executar jornadas com atendente/técnico, inclusive tela estreita e acessibilidade; definir alertas para responsáveis e monitor externo sem avisos automáticos ao assinante | Operação + suporte |
| E08 | Ampliação/publicação de confiança | Executar CI e SBOM do SHA final após autorização futura de push; revisão independente de segurança e capacidade no volume previsto. Validar distribuição/licenciamento FreeRADIUS antes de entregar pacote a terceiros | Mantenedor + revisão independente |
| E09 | Fases futuras | Homologar conta sandbox Efí e depois real antes de cobrança integrada; canal autorizado com consentimento e deduplicação antes de avisos; homologar OLT/CPE/TR-069/IPv6/CGNAT e redundância em hosts distintos somente se incluídos no piloto | Dono + fornecedores |

Nenhuma dessas ações autoriza escrita em equipamento real, migração de clientes, ativação automática ou mudança no proxy nesta missão. As limitações internas/funcionais mais amplas continuam em `docs/pendencias.md`; esta lista concentra os recursos e aceites externos.
