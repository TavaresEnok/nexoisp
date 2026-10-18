# Diagnóstico do NexoISP e confronto das evidências

## Base e método

Foram lidos os relatórios de entrada  README, 16, 17, 06, 12 e 15 do consolidado, os inventários de rotas/menus/operações/campos, as fichas AV001–AV044 e fichas dirigidas de páginas. O confronto não se limita aos relatórios: o parser lê diretamente os 286 HTML das duas pastas originais, registra estrutura de controles e iframes, e a revisão dirigida examinou os scripts originais de cliente, endereço, OLT e o servidor offline.

Referências independentes dos originais: [evidências e limites consolidados](evidencias.md), [registro estrutural por ID](evidencias_sanitizadas.json), [especificação proposta dos 44 formulários](formularios_revisados.json) e [inventário histórico de hashes](fontes_sha256.json). Os caminhos originais são referências históricas dentro da cópia privada, sem dependência de arquivos em `docs/SGP/`.

Os 286 HTML incluem arquivos auxiliares: não contradizem os 198 HTML do SGP da primeira coleta e 86 da segunda identificados pelo consolidado. Eles foram lidos estruturalmente; a revisão semântica foi dirigida, sem alegar leitura humana linha a linha de todos os assets. O servidor offline de `sgp-backup2/servidor_sgp.py` responde sucesso simulado a qualquer POST; não foi executado nem usado como oráculo de comportamento.

Na coleta do SGP, HTTP 200 comprova resposta/estrutura; 403 comprova a restrição daquele perfil naquele momento. Os 44 formulários novos recuperam campos, mas não validação servidora, edição, exclusão, concorrência ou efeitos financeiros. Não foram feitas novas consultas ao SGP nem usado qualquer segredo coletado.

## NexoISP real

| Camada | Evidência no código | Conclusão e limite |
|---|---|---|
| Backend | `cmd/api`, Chi/Huma, handlers `modules/identity`, `modules/leitura` e `modules/escrita` | API nativa Go, não uma fachada para Fastify. Os manifests de rotas não substituem execução de fluxos |
| Persistência | pgx/SQL explícito, migrations goose, constraints e RLS; `DB.WithScope` por transação | Domínio transacional real; credencial comum não é dona do schema; cenários de tenant/papel foram exercitados nos fluxos alterados |
| Autorização | `auth/permissions.go`, `auth/auth.go`, `user_pops`, módulos por tenant | Backend aplica papel/POP/módulo/portal; seis papéis fixos não equivalem a grupos arbitrários do SGP |
| Rotinas e operações | River/outbox, `operations`, tentativas, intenção/posse/versão e auditoria | Processamento durável próprio; execução incerta exige verificação, não sucesso artificial |
| Frontend | React, formulários reais, `usePaged`/`useLoad`, `api.ts` | Telas ligadas à API; havia concorrência de respostas nos hooks compartilhados, corrigida e testada em Chromium |
| Financeiro | `finance/`, faturas/pagamentos/acordos/eventos e travas | Baixa e regras próprias existem; apenas gateway demo emite meios fictícios. Caixa completo e emissão fiscal permanecem ausentes |
| Rede | executor RADIUS central, VPN Go, agente Python, FreeRADIUS, GenieACS | São componentes reais, com fronteiras distintas. FreeRADIUS não é Go e GenieACS tem runtime próprio. Equipamento físico não foi homologado nesta auditoria |
| Operação | scripts de produção/backup, preflight e testes sintéticos | Preparação existe; domínio/HTTPS real, backup externo e corte exigem implantação e evidência do ambiente definitivo |

## Diferenças relevantes recuperadas dos originais

- **Clientes:** R030–R033 e R368–R371 distinguem F/J/E/EJ. O Nexo valida CPF/CNPJ opcional, mas não modela explicitamente estrangeiro/PJ estrangeira. Nome social, complemento, referência e identificação internacional não devem ser declarados cobertos pelo cadastro genérico. O JS original aplica máscara de datas; não demonstra validação no servidor. O Nexo agora recusa datas impossíveis na API.
- **Empresa/serviço:** AV001/012 têm contatos, endereço, marca, certificado e muitos parâmetros fiscais; AV003/004 têm composição de plano/serviço e classificação fiscal. Empresa com nome/CNPJ e produto adicional no Nexo cobrem apenas parte comercial, não emissão ou parametrização tributária.
- **Estoque:** AV005–AV015 mostram categoria, fabricante, produto fiscal/comercial, relação de fornecedor, kit, NCM, depósito/empresa/usuários e transportadora. Estoque por razão/série e kit do Nexo não substituem compras, depósitos e transportadoras. Nesta entrega foi conferida a transação material/devolução/kit, sem inventar custo ou tratamento fiscal.
- **Equipe:** AV002 traz admissão, remuneração e documentos. Usuários operacionais e técnicos do Nexo não constituem módulo RH. AV011/016 representam frota/combustível; aprovação desse escopo continua pendente.
- **Rede:** AV017 contém interface de saída, redes e faixas de portas para CGNAT; AV018 é VLAN/QinQ; AV019/022 expõem comandos e regex para templates de switch/ONU. O Nexo preserva catálogo de operações assinado, e não adota console livre. Inventário VLAN/QinQ e templates multivendor continuam lacunas distintas do provisionamento Huawei existente.
- **Comunicação:** AV026/038/039/040/044 mostram canais, SMTP, TLS/SSL/OAuth, janelas, feriados, prioridades e anexos. Canal HTTP do Nexo não equivale a SMTP nativo, feriados ou PDF de boleto por e-mail. Consentimento e histórico do Nexo devem ser preservados ao integrar um serviço.
- **Integrações:** AV028/029/030/032/035/036/041 distinguem assinatura externa, bureau, benefícios, telefonia, multimídia, mapa e gerência CPE. Aceite simples, restrição interna de crédito, item adicional e mapa próprio não demonstram essas integrações. Dependem de serviço/contrato e sandbox escolhidos.
- **Personalização:** AV042/043 mostram dashboards por grupo e imagens configuráveis. O Nexo tem painel/tema próprios, sem equivalência demonstrada ao construtor de widgets/branding.

## Fluxos percorridos nesta entrega

| Fluxo | Entrada/validação | Persistência e consulta | Estados/erros/efeitos |
|---|---|---|---|
| Assinante → contrato → fatura | Criação e datas válidas/inválidas | PostgreSQL sintético e consulta após edição | `PATCH` parcial preserva dados/inatividade; vencimento inválido retorna 400 |
| Campo personalizado → anonimização | Data, texto obrigatório, papel e tenant | Gravação, consulta e titular anonimizado | 400 para inválido, 403 sem papel, 404 outro tenant, 409 após anonimização |
| OS → auxiliar → responsável → encerramento | Papéis autorizados e vínculo da pessoa | Auxiliares/histórico lidos após cada ação | Repetição idempotente; promoção remove auxiliar; estado final bloqueia alteração |
| Alteração concorrente de equipe | Atribuição e inclusão simultâneas | Mesma OS travada no banco | Sem pessoa como responsável e auxiliar ao mesmo tempo |
| Entrada → kit/material → devolução | Quantidade/saldo e vínculo da OS | Saldo consultado após consumo/devolução | Falta de saldo não lança kit; devolução excessiva recusada; kit válido desconta |
| Busca/filtro/página e detalhe | Mudanças rápidas com respostas HTTP controladas | Hooks reais em navegador, HTTP sintético | Resposta antiga não substitui filtro; offset reinicia; dado anterior não fica sob novo objeto |

Esses cenários verificam capacidades próprias do Nexo. Não reproduzem o backend ou as regras desconhecidas do SGP. A revisão estática dos outros módulos e o inventário individual não encerram seus respectivos testes ponta a ponta.

## O que preservar, mesmo sem evidência equivalente no SGP

RLS no banco e escopo por POP; intenção comercial separada do estado observado; envelope assinado e versionado; recusa de suspensão obsoleta; consulta após efeito incerto; auditoria; preview de importação; API com idempotência; certificado do agente fixado; modo manutenção. O acervo do SGP não permite afirmar que o produto original não possua mecanismos semelhantes.

## Conclusão de escopo

O Nexo já tem domínio e persistência próprios, mas existem lacunas de produto substanciais além de aparência. Esta entrega fecha inconsistências concretas e estabelece rastreabilidade do inventário disponível. Na consolidação posterior, os 101 títulos e os 956 controles receberam revisão documental de destinação; propostas e regras desconhecidas continuam explícitas. Aprovação das regras e homologação dos cenários completos não foram encerradas. Não há denominador aprovado para calcular uma porcentagem de paridade.
