# Arquitetura do NexoISP

Referência consolidada em 17/10/2026. Substitui o planejamento inicial e os registros contraditórios de implementação. Os identificadores ADR foram preservados porque também são usados nos comentários do código.

## Componentes e responsabilidades

O NexoISP é um ERP SaaS para provedores de internet. O tráfego dos assinantes permanece nos equipamentos do provedor; o sistema administra cadastro, contratos, financeiro e intenção de serviço.

| Componente | Implementação e responsabilidade |
|---|---|
| Painel e portal | `apps/web`: React/TypeScript, Vite, CSS próprio e fontes empacotadas; arquivos estáticos servidos pelo Caddy |
| API | `apps/api-go/cmd/api`: Go, Chi/Huma, regras de negócio, autorização, consultas e executor RADIUS integrado |
| Banco e tarefas | PostgreSQL, pgx, SQL explícito, migrations goose e jobs River; sem backend Node |
| Administração | `apps/api-go/cmd/nexo-db`: preparação do banco, migrations, operador, rotação de segredos e preflight |
| VPN | `apps/api-go/cmd/nexo-vpn`: sincronização WireGuard, L2TP/IPsec e relay de desconexão |
| RADIUS integrado | FreeRADIUS em `infra/radius`, lendo o PostgreSQL com papel próprio; compartilha a rede do serviço VPN |
| Agente opcional no site | `services/network-agent`: Python, SQLite durável, drivers MikroTik e OLT; conexão de saída mTLS |
| RADIUS local do site | FreeRADIUS com dados locais sincronizados pelo agente; opção para autenticar durante indisponibilidade do SaaS |
| Gerência TR-069 | GenieACS e MongoDB, perfil opcional `acs`; a interface de operação é o painel do NexoISP |
| Implantação | Docker Compose: desenvolvimento em `infra/compose`, produção em `infra/prod`, agente no provedor em `infra/site` |

Node é usado na compilação do frontend e no teste de navegador. As imagens da API e VPN executam binários Go. GenieACS é um serviço externo ao backend da aplicação e possui seu próprio runtime.

## Decisões técnicas vigentes

| Decisão | Regra |
|---|---|
| ADR-001 — Monólito modular | Módulos de negócio no backend Go, com painel compartilhado; não criar microserviços por tabela nem um segundo backend sem necessidade concreta |
| ADR-002 — Persistência e tarefas | Intenção e tarefa correspondente são persistidas atomicamente; River atende jobs/outbox; reserva de rede usa transações curtas, sem manter locks durante comandos ao equipamento |
| ADR-003 — Isolamento | `tenant_id`, vínculos consistentes e RLS; contexto autorizado por transação; API/VPN usam `nexo_go`, sem propriedade de tabelas, superusuário ou `BYPASSRLS` |
| ADR-004 — RADIUS local | O site pode autenticar com a última política sincronizada enquanto a nuvem ou o agente estiverem indisponíveis; isso não incorpora pagamentos ou cancelamentos ainda não recebidos |
| ADR-005 — Motor RADIUS | FreeRADIUS é o motor utilizado e exercitado em laboratório; ToughRADIUS não foi homologado. A forma de distribuição a terceiros continua pendente de validação |
| ADR-006 — Identidade do agente | Listener dedicado mTLS + token, identidade `agent:<id>`, vínculo a provedor/equipamentos e impressão digital do certificado fixada; rotação e revogação são explícitas |
| ADR-007 — Operações estruturadas | Catálogo fechado de operações, envelope Ed25519 com versão e validade; sem shell arbitrário. Segredo PPPoE é entregue separadamente no início autorizado da tentativa |
| ADR-008 — Persistência local | SQLite guarda tentativas, etapas e resultados; não iniciar escrita sem persistir a tentativa. O RADIUS local pode usar senha em claro para CHAP ou hash NT para MS-CHAPv2; criptografia de disco é responsabilidade da instalação |
| ADR-009 — Atualização do agente | Imagem e manifesto assinados, cópia antes de migrar SQLite e verificação de compatibilidade; rollback não pode descartar resultados ainda não entregues |
| ADR-010 — Financeiro | Fatura, pagamento e evento separados; deduplicação de recorrência/eventos e conciliação. O único gateway implementado é o demonstrativo; pagamentos reais exigem adaptador homologado |
| ADR-011 — Migração de dados | Formato conhecido, prévia sem gravação, erros por registro, origem + identificador externo e reimportação segura; corte por grupo e reversão preservando eventos posteriores |
| ADR-012 — Equipamentos | MikroTik RouterOS v7 validado em CHR; repetir no equipamento e versão do piloto. Driver Huawei OLT só exercitado contra emulador próprio; não declarar homologação física |
| ADR-013 — Segredos e auditoria | AES-256-GCM para segredos PPPoE/MFA, chaves preservadas fora do backup do banco, rotação explícita e auditoria sem credenciais; acesso administrativo separado da conexão da aplicação |
| ADR-014 — Recuperação | Intenção versionada, revalidação antes de executar e consulta antes de repetir efeito incerto; divergência externa é reportada, sem correção silenciosa |
| ADR-016 — RADIUS e túnel integrados | Padrão central configurado pelo painel, com identidade do NAS pelo endereço de origem, pares WireGuard individuais e L2TP/IPsec opcional; a opção de site local permanece disponível |

O papel `nexo_owner` fica restrito à administração/migrations. `nexo_radius` acessa as estruturas de autenticação; `nexo_replica` é usado quando a réplica está configurada. Segredos RADIUS e da aplicação têm chaves distintas.

## Garantias de negócio e execução

Os seis papéis são operador SaaS, administrador, atendimento, financeiro, técnico/NOC e assinante. A autorização é conferida no backend, incluindo módulos por provedor, escopo por POP e portal restrito ao assinante. Suporte do operador a outro provedor é explícito e auditado.

Contrato comercial, situação financeira, política de acesso desejada, estado observado e andamento da operação são informações separadas. Pagamento confirmado pode coexistir com reativação pendente; ausência de sessão não comprova suspensão. Observações sempre precisam de data.

- Reservar e iniciar exigem posse vigente e intenção atual. Operação obsoleta ainda não aplicada é substituída.
- Timeout, perda de confirmação, reinício ou expiração da posse não provam que o comando deixou de ser aplicado: consultar antes de repetir.
- Resultado antigo não substitui intenção nova. Serializar escritas conflitantes por equipamento; transferir executor exige impedir a continuação do anterior.
- Confirmação considera autorização e tratamento das sessões, distinguindo sessão ausente de sessão desconhecida.
- Reconexão exige sincronização versionada antes de novas escritas. Snapshot parcial não significa exclusão.
- Modo manutenção suspende escritas. Alterações manuais são mostradas como divergência; não há garantia universal de execução exatamente uma vez.
- Cobrança, reentrega de eventos e envio de avisos não podem duplicar o efeito. Automação comercial fica desligada até a política ser configurada.
- Cálculo financeiro deve preservar centavos e arredondamento explícito; divergência não autoriza inventar uma baixa.

## Limites operacionais

O RADIUS central depende do banco e do caminho de rede até o sistema. Se esse caminho cair, sessões existentes podem continuar, mas novas autenticações e reconexões falham. A opção de site local tem comportamento diferente: autentica com os dados já sincronizados. Duas instâncias no mesmo host não protegem contra perda do host ou disco.

O túnel usa pares individuais, sem encaminhar tráfego entre concentradores. Chaves do servidor ficam em volume persistente; substituir esse volume não faz parte de uma atualização normal. RADIUS por IP direto exige restrição aos NAS conhecidos.

OLT usa o mesmo motor de operações do acesso. CGNAT gera script para revisão humana; o sistema não aplica regras de firewall automaticamente. NOC produz diagnóstico por regras com evidência, sem IA escrevendo na rede.

Atendimento é organizado por ocorrências e OS. Não há produto próprio de chat; conectores externos podem abrir registros pela API. Avisos aos assinantes são de saída e dependem de canal configurado e consentimento.

Backup de banco não inclui chaves, certificados nem SQLite dos sites. Recuperação e atualizações devem seguir [Operação](operacao.md); formatos e corte de dados estão em [Importação CSV](importacao-csv.md). Pendências externas e funcionalidades ainda não entregues ficam em [Pendências](pendencias.md).
