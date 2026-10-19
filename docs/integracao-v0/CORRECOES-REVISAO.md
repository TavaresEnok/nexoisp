# Correções da revisão arquitetural

Os **seis achados R01–R06 foram resolvidos e validados** em 19/10/2026. A solução mantém o frontend v0 como interface oficial, utiliza exclusivamente o backend Go existente e preserva as limitações reais desse backend. O [relatório original](REVISAO-ARQUITETURA-E-CHECKUP.md) continua disponível como registro do checkpoint anterior.

| Achado | Correção | Evidência |
|---|---|---|
| R01 — destinos do catálogo | Submenus de concentradores e OLT chegam ao equipamento operacional; contratos financeiros usam o destino existente. Mensagem de planejamento não atribui ausência ao backend sem fundamento | Teste de rotas por AST e caso R01 em [regressao.json](evidencias/correcoes/regressao.json) |
| R02 — alertas da ficha | Anotações marcadas para alertar aparecem acima das abas ao abrir a ficha pela lista ou URL. Arquivamento atualiza a mesma consulta compartilhada | Casos R02 e captura [ficha com alerta](evidencias/correcoes/ficha-alerta-multiplos-contratos.png) |
| R03 — módulos desabilitados | Equipamentos de contrato exigem estoque e módulo de campo; SLA depende de CRM ou campo; edição OLT respeita seu módulo | Matriz sem módulos / CRM / campo, com ausência de requisições proibidas e controles positivos |
| R04 — capacidades comerciais | Indicações, conversão para assinante existente, classificação de atendimento, filtros/exportação, edição de equipamento e exclusão global de etiqueta integrados; itens já cobertos receberam associação correta de evidência | [Triagem individual](CAPACIDADES-BACKEND.md), matriz e regressão Go real |
| R05 — regressão insuficiente | Paridade extrai rotas reais do código, além dos rótulos; testes cobrem permissões, provedor, módulos e seis referências visuais operacionais; CI executa e preserva evidências | 153 testes locais; 26 cenários de fumaça; 13 verificações compostas novas |
| R06 — legibilidade | Formatação dos módulos operacionais, Prettier com versão fixa e verificação na CI, em commit separado | `4ac798f`; [verificação de estilo](evidencias/correcoes/format.log) |

Commits: `4ac798f` (formatação) e `10e1a5f` (correções funcionais e regressões).

## Verificação e alcance

- TypeScript, **153 testes locais**, build Vite/Node 22 e imagem Caddy aprovados.
- Os **26 cenários operacionais** foram cobertos em dois segmentos sequenciais no Go/PostgreSQL descartável: os 14 primeiros passaram; o teste CGNAT exigiu corrigir a serialização de segundos zero no preenchimento de `datetime-local`, e a continuação cobriu os 12 restantes até a nova regressão. Não foi uma única execução ininterrupta. Os logs dos segmentos foram preservados.
- A imagem final `nexo-v0-frontend:corrections`, ID `sha256:21028f2bd4b6a5a5a54063ef1ea7a48f48455a53722929f03907b57a4b9c0fdd`, passou também pela regressão dirigida no navegador do mesmo contêiner Playwright usado pela CI. Foram **13 verificações compostas**, incluindo persistência relida no Go, autoindicação recusada, perfil financeiro sem escrita e tentativa de alteração entre provedores recusada.
- **Seis comparações operacionais** cobrem lista clara/escura/celular, ficha com nome longo/alerta/múltiplos contratos, vazio e erro 503. As capturas usam dados sintéticos criados pela API real. Datas variáveis são normalizadas somente na consulta da captura; UUIDs são mascarados. Nenhuma resposta visual simulada fundamenta as verificações de persistência.
- **Três comparações novas da demonstração são idênticas** ao v0 original: início claro, início escuro e assinantes no celular. Os 231 arquivos originais, componentes básicos, CSS e fontes continuam preservados.
- Contraprova: o novo teste executado contra a imagem anterior falhou no primeiro caso R01, pois o submenu ainda apresentava a página planejada. Isso demonstra que a regressão detecta o defeito anterior; não significa uma contraprova individual de cada achado.
- O ambiente do usuário em `18081` não recebeu escritas de teste. A prova final usou Caddy `18394`, Go `18887` e PostgreSQL `15455`, com jobs desabilitados. Não houve alteração do código ou das regras do Go. Os processos e bancos temporários desta correção foram encerrados após a coleta.

As referências operacionais foram fixadas no ambiente canônico `mcr.microsoft.com/playwright:v1.55.1-jammy`, após inspeção. A primeira comparação com PNGs produzidos no host detectou diferenças localizadas no glifo de atalho do teclado (`⌘`) do sistema. O celular foi idêntico. As capturas canônicas foram revisadas e comparadas novamente sem habilitar atualização de referência. A execução normal nunca substitui automaticamente um PNG esperado.

A formatação cobre 125 arquivos de funcionalidades. Permanecem duas linhas extensas em strings HTML de impressão, mantidas como templates para não alterar o documento gerado; as expressões JSX comprimidas foram expandidas. A CI verifica o estilo com a versão de Prettier fixada no lockfile.

## Fechamento reconciliado

A matriz passou de 139 para **149 unidades integradas e validadas**. As **20 restantes** são 14 serviços internos, dois contratos HTTP externos e quatro limitações reais, descritos individualmente. Não há unidade de integração pendente ou parcial. O estado original de capacidades parciais, demonstrativas ou de laboratório permanece registrado: a conclusão da integração não as torna recursos de produção completos.

As sete etapas estão concluídas no escopo de integração às capacidades disponíveis do Go. Isso não representa publicação externa, execução da CI remota ou homologação física de OLT, NAS, gateway e demais serviços. Permanecem os limites de gateway financeiro, importação universal, IPv6, laboratório CGNAT, hardware e célula `c1` documentados no plano. Os três tipos de catálogo visual sem CRUD correspondente continuam identificados como planejados.

A exclusão preexistente de `docs/pilha-tecnologica.md` foi preservada e não participa dos commits desta correção.
