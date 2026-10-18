# Evidências consolidadas e limites

Este documento preserva o conhecimento relevante para o NexoISP sem exigir os espelhos do SGP. Não contém registros, valores de campos, credenciais, cookies, certificados, scripts executáveis ou assets do produto de origem.

## E01 — Acervo e método de coleta

O consolidado de origem descreveu duas coletas com 198 e 86 HTML identificados como páginas SGP. A leitura estrutural encontrou 286 HTML ao incluir auxiliares. O inventário contém 388 rotas, 480 entradas de menu e 334 operações estruturais; a coleta HTTP autenticada acrescentou 44 formulários internos. Esses números representam superfícies observáveis, com sobreposição, e não um denominador aprovado de capacidades.

Os relatórios de entrada foram README, 06 (catálogo), 12 (lacunas), 15 (especificação proposta), 16 (parecer final) e 17 (verificação HTTP). Também foram examinados inventários, fichas, entidades/regras, fluxos e arquivos originais dirigidos. São referências históricas na cópia privada, identificada pelo [recibo](retirada_fontes.json); seus hashes estão no [inventário inicial](fontes_sha256.json).

## E02 — O que não foi demonstrado

HTTP 200 confirma resposta e estrutura; 403 confirma a restrição daquele acesso naquele momento. Formulário, botão, rótulo ou atributo required não comprovam validação servidora, edição, exclusão, transação, permissão de outro perfil ou efeito entre módulos. A verificação autenticada foi por HTTP, sem ensaio visual/interativo em navegador. Não há backend original nem banco original do SGP no acervo. A especificação sugerida no relatório 15 não equivale a regra comercial aprovada para o Nexo.

O servidor offline de `sgp-backup2/servidor_sgp.py` produz sucesso simulado em POST; não foi executado nem usado para afirmar comportamento. O JavaScript de cliente mostra máscaras de entrada, não validação de calendário no servidor. O de endereço mostra busca por CEP/coordenadas e solicitação de localização, sem provar contrato dos serviços ou autorização para coletar dados. O de OLT mostra condicional de campos PON; não prova provisionamento em equipamento físico.

## E03 — Cadastro e comercial

As variantes F/J/E/EJ de cliente distinguem pessoa física, jurídica e modalidades estrangeiras. AV001/012 mostram cadastro de empresa, contatos, endereço, identidade visual e parâmetros fiscais; AV003/004 mostram composição de plano/serviço por classificação comercial/fiscal; AV023/024 mostram fidelidade e descontos por família/combo. Não é possível deduzir fórmulas, regras de duplicidade, renovação, vigência, arredondamento ou identificação estrangeira pela presença dos campos.

No Nexo há cadastro de assinante, plano versionado, contrato, adicional e condições próprias. Eles não demonstram todas as modalidades ou regras do SGP. As correspondências estruturais conferidas e os campos ainda sem destino estão registrados individualmente na [revisão de controles](campos_44_formularios.csv), sem conversão automática de dados.

## E04 — Estoque, RH e frota

AV005–AV015 distinguem categoria, fabricante, produto, fornecedor, kit, NCM, depósito e transportadora. Produto inclui dados comerciais/fiscais e relacionamentos que não cabem em simples movimento de saldo. O kit possui itens e indicações de possibilidade de alteração/remoção que precisam de regra própria. O Nexo mantém saldo/série/materiais/kit; compras, custo e depósitos ainda precisam de domínio aprovado.

AV002 contém vínculo de usuário, cadastro pessoal, admissão/remuneração, documentos e dependentes. Isso é diferente de usuário/técnico operacional. AV011/016 distinguem veículo, disponibilidade e lançamento com datas/horários, combustível, custo e quilometragem. A inclusão de RH/frota no escopo permanece uma decisão explícita, com finalidade e proteção de dados; nenhuma informação pessoal foi conservada como exemplo.

## E05 — Rede, fibra e CPE

AV017 descreve interfaces, endereços/redes, faixas de portas e protocolos de CGNAT; AV018 descreve VLAN/QinQ. AV019/022 possuem campos para comandos, argumentos e regex de templates de switch/ONU. AV020 distingue parâmetros de RADIUS e conexão; AV021 tipos/portas de ONU; AV041 gerência CPE e ações da central. Esses formulários não comprovam driver, firmware, segurança, efeito físico ou recuperação de erro.

O Nexo tem operações estruturadas, assinadas e versionadas, estado desejado/observado, RADIUS, VPN Go, agente Python, FreeRADIUS e integração GenieACS. Essa arquitetura é preservada. Campos de comandos livres não serão copiados como console arbitrário; as capacidades necessárias devem ser especificadas por driver homologado. Inventário genérico não demonstra VLAN/QinQ, multivendor, cabos/fusões ou integração de rede neutra.

## E06 — Financeiro e fiscal

Menus/rotas distinguem títulos, recebimentos, remessas, carnês, caixas, contas a pagar/receber e documentos fiscais. AV001/004/007/010/012 detalham parâmetros e classificações fiscais; não fornecem legislação aplicável, fórmulas ou contrato de emissor. O Nexo possui financeiro transacional próprio, mas o gateway demo não gera meios pagáveis e não existe emissor fiscal homologado. Cadastro de empresa, exportação ou campo NCM não equivalem a emissão/conciliação externa.

Cada campo fiscal conserva seu nome/tipo/rótulo estrutural e uma questão de especificação. A decisão depende de documento, emissor, vigência, empresa e exemplos aprovados; o material não autoriza emitir, cancelar ou testar cobranças reais.

## E07 — Comunicação e conectores

AV026/038/039/040/044 distinguem canais, réguas, janelas, feriados, prioridade, tags, reenvio, validação de contato, anexos/PDF, SMTP, TLS e OAuth. Réguas HTTP nativas não demonstram SMTP completo, feriados ou os mesmos filtros. AV027–AV037 e AV041 distinguem TV, assinatura, bureau, benefícios, atendimento, telefonia, multimídia, mapa externo e gerenciadores CPE. Cada um exige fornecedor, contrato, estados e tratamento de falha próprios.

Grades de parâmetros chave/valor são representação de configuração, não justificativa para aceitar entradas arbitrárias ou credenciais do acervo. Preservam-se as necessidades por conector e propostas tipadas; valores e opções reais não foram copiados. Aceite simples, restrição interna de crédito, adicional faturável e mapa nativo não serão declarados equivalentes às integrações externas.

## E08 — Sistema e navegação

AV025 mostra configuração genérica; AV042/043 mostram personalização de dashboard/grupo/imagem. O Nexo mantém configuração tipada, painel próprio e assets próprios; ampliar personalização depende de precedência por usuário/provedor e validação de acesso/upload/contraste. Os 101 itens sem rota são títulos de navegação; cada um está na [revisão de menus](revisao_101_menus.csv), com decisão e ressalva de escopo quando o nome é insuficiente, como TSMX e rede neutra.

Metadados de popup, contagens de formset e estados iniciais de formulário não são campos de negócio a portar. IDs, vínculos e cardinalidades precisam ser preservados na API nativa; dispensar um controle técnico não elimina a necessidade de domínio que ele representava.

## E09 — Consulta e rastreabilidade sem originais

Cada linha da matriz de superfícies aponta para um registro pelo mesmo ID em [evidencias_sanitizadas.json](evidencias_sanitizadas.json). O registro conserva tipo, descrição, rota observada, grau de confiança e referência histórica na cópia privada. Os campos AV conservam ID estável, formulário, nome, rótulo, tipo e required observado, além da revisão de destinação. [formularios_revisados.json](formularios_revisados.json) reúne os campos de cada formulário e a especificação proposta. [originais_inspecionados.json](originais_inspecionados.json) conserva somente estrutura de controles, contagens e hashes dos HTML.

Esses registros preservam a evidência estrutural disponível, sem reproduzir screenshots, valores ou código proprietário. Não permitem reconstruir comportamentos nunca observados. Quando faltar uma regra, a fonte necessária é uma especificação ou homologação autorizada, não uma suposição baseada no espelho.
