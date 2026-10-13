# NexoISP — Entrada em produção em sete dias

**Planejado em:** 10 de outubro de 2026  
**Data-alvo proposta:** 17 de outubro de 2026  
**Objetivo:** primeira operação real com um provedor e um grupo inicial de assinantes definido com ele.

## 1. Mudança de prioridade

O trabalho passa da expansão de funcionalidades para a preparação da primeira versão de produção. Aproveitar o código existente. Não reescrever a arquitetura ou abrir novos módulos nesta semana.

A data é uma meta condicionada a acesso ao provedor, infraestrutura, dados e integrações. Não representa certificação de prontidão. Os pontos externos devem ser resolvidos no primeiro dia para que a engenharia consiga concluir a entrega.

**Base da avaliação:** revisão do commit `314e29d` do repositório NexoISP. Tipos e build passaram na revisão local; testes completos e laboratório não foram reproduzidos pelo revisor. Conferir mudanças posteriores antes de implementar correções.

## 2. Escopo da primeira versão em produção

Liberar os processos necessários ao provedor: usuários/permissões, assinantes, planos, contratos, acesso PPPoE, cobrança pelo gateway selecionado, conciliação, consulta de faturas, importação validada, auditoria e acompanhamento do agente.

Somente habilitar as operações de rede homologadas no modelo/configuração usado pelo provedor. Restringir recursos experimentais por configuração e autorização do backend, além da interface.

OLT, CGNAT automatizado, novos fabricantes, IA, CRM avançado e grandes mudanças de layout não entram nesta semana. Recursos adicionais já existentes só serão liberados se forem necessários ao provedor e sua verificação couber na entrega sem deslocar o núcleo.

O processo fiscal precisa estar resolvido: integração necessária ao lançamento ou processo externo efetivamente utilizado pelo provedor. Não confundir exportação contábil com emissão fiscal.

## 3. Informações a fechar no primeiro dia

| Informação | Decisão concreta |
|---|---|
| Provedor | Quem recebe a primeira versão e quem acompanha a operação |
| Grupo inicial | Quais contratos e qual NAS entram primeiro; não presumir toda a base |
| Equipamento | Modelo, versão do RouterOS, configuração e acesso autorizado |
| Infraestrutura | Host central, domínio, HTTPS, host local e armazenamento dos backups |
| Financeiro | Gateway, acesso sandbox/produção e política de cobrança/suspensão |
| Migração | Exportação do MK-Auth, versão de origem e disponibilidade de credenciais |
| Operação | Responsável por incidentes, janela de corte e procedimento de retorno |
| Equipe | Pessoas disponíveis e horas efetivas durante a semana |

Um desenvolvedor implementa uma frente por vez; o proprietário/provedor resolve os acessos em paralelo. A tabela não presume uma equipe adicional disponível.

## 4. Agenda de execução

| Dia | Trabalho principal | Entrega verificável |
|---|---|---|
| 1 — 11/10 | Fechar dependências, congelar escopo e subir homologação | Ambiente acessível, configuração separada de produção, gateway e amostra de migração disponíveis |
| 2 — 12/10 | Corrigir motor de rede e verificar no ambiente do provedor | Posse vencida recusada; perfil/sessão confirmados corretamente; ciclo PPPoE comprovado |
| 3 — 13/10 | Integrar um gateway e configurar políticas | Emissão em sandbox, baixa, evento repetido e conciliação funcionando |
| 4 — 14/10 | Ensaiar migração e ajustar telas de operação | Prévia conferida, importação repetível e fluxo de atendimento utilizável |
| 5 — 15/10 | Fechar implantação e recuperação | Backup restaurado em ambiente separado, segredos configurados, agente instalado e monitoramento básico ativo |
| 6 — 16/10 | Ensaio integral e decisão de entrada | Cadastro/importação → acesso → cobrança → suspensão → pagamento → reativação; plano de retorno conferido |
| 7 — 17/10 | Entrada com grupo autorizado e acompanhamento | Operação real observada, pagamentos e autenticação conferidos, incidentes registrados |

Ajustar a agenda à capacidade real assim que a equipe for conhecida. Se uma dependência impedir a data, reduzir o escopo operacional explicitamente ou mudar a data do fluxo dependente; não substituir a integração por uma simulação escondida.

## 5. Correções técnicas prioritárias

### 5.1 Validar posse no momento de iniciar

Na revisão do commit de referência, `begin()` autorizou uma reserva com `lease_until` vencido em uma reprodução isolada com banco simulado. A validade da reserva deve ser conferida dentro da própria transação que inicia a tentativa, independentemente da rotina de limpeza.

Aceite: reserva vencida não inicia escrita; uma reserva vigente e elegível continua funcionando. Revalidar no código atual antes de alterar.

### 5.2 Confirmar o tratamento da sessão também para acesso ativo

Na revisão, a confirmação final de PPPoE só impedia sucesso por desconexão pendente quando a política era de suspensão. Corrigir para não considerar concluída uma alteração de perfil/IP quando a sessão ainda exige tratamento.

Distinguir sessão ausente de sessão desconhecida. A autorização pode estar aplicada mesmo quando não é possível verificar o NAS; registrar a etapa parcial sem afirmar que toda a operação foi comprovada.

Aceite: autorização e sessão coerentes concluem; sessão comprovadamente antiga ou resultado desconhecido não geram sucesso indevido.

### 5.3 Integrações e ambiente

Implementar um gateway real. Remover dados e acessos de demonstração da configuração de produção; exigir os controles administrativos previstos no projeto. Conferir instalação, credenciais e transporte do agente no ambiente real.

Não aproveitar a semana para refatorar todos os módulos, atualizar todas as dependências indiscriminadamente ou escrever uma nova infraestrutura de testes.

## 6. Design nesta entrega

Preservar identidade visual e componentes. Concentrar o acabamento nas telas que o usuário precisa para operar:

- **Ficha do assinante/contrato:** identificar plano, situação financeira, autorização, sessão conhecida e próxima ação; diferenciar dados desatualizados.
- **Financeiro:** destacar vencidas, pagas e em conciliação; indicar claramente operação pendente e falha.
- **Listas:** busca, filtros úteis, estados vazios e navegação previsível.
- **Login:** hierarquia do botão principal, mostrar/ocultar senha e orientação de acesso coerente com o mecanismo realmente disponível.
- **Menu:** ocultar módulos não liberados para aquele papel/provedor, com a mesma restrição no backend.

Não adicionar dashboards decorativos ou novos gráficos como requisito de lançamento. Fazer uma sessão curta de uso com um atendente do provedor e corrigir os obstáculos que impedirem tarefas reais.

## 7. Verificação mínima para entrada

Executar verificações dirigidas, sem meta de cobertura:

1. Um tenant não lê nem altera dados de outro; assinante vê somente seus dados.
2. Cobrança recorrente e webhook repetidos não duplicam efeito financeiro.
3. Suspensão obsoleta não executa após atualização conhecida; perda de confirmação não causa repetição cega.
4. PPPoE autentica, suspende e reativa no ambiente homologado; RADIUS continua com a nuvem indisponível.
5. Importação confere os dados e valores acordados; backup pode ser restaurado.

Reutilizar os testes existentes, acrescentando apenas regressões para as correções. Conferir build e tipos da versão a implantar. Registrar versão, ambiente e resultado, sem produzir relatório extenso.

## 8. Condições para entrar em produção

- Grupo, NAS, responsáveis e janela definidos.
- Nenhuma falha conhecida de isolamento, duplicação financeira ou execução indevida de suspensão no fluxo liberado.
- Gateway real pronto, se o NexoISP assumir cobrança nessa entrada.
- Dados de migração conferidos, incluindo credenciais necessárias ao acesso.
- Políticas comerciais aprovadas/configuradas e processo fiscal definido.
- Backup fora do domínio de falha principal e restauração exercitada.
- Ambiente sem contas/chaves de demonstração e controles administrativos habilitados.
- Observação de agente offline, tarefas incertas e falhas financeiras disponível para quem acompanha o corte.
- Retorno ao sistema anterior planejado sem perder pagamentos e alterações posteriores.

Se o gateway não estiver pronto, pode-se propor uma entrada operacional limitada mantendo a cobrança no sistema anterior. Isso exige definir explicitamente a fonte de verdade e a comunicação de pagamentos; a suspensão financeira automática do NexoISP permanece desativada até haver dados confiáveis. Não operar dois financeiros independentes sobre os mesmos títulos.

## 9. Corte e ampliação

Iniciar com um grupo pequeno, definido pelo provedor, dentro da capacidade de suporte da equipe. Conferir autenticação, alteração de serviço e títulos desse grupo antes de ampliar.

Interromper a ampliação diante de bloqueio indevido, autenticação inconsistente, duplicação de título/pagamento ou divergência de migração. Investigar e corrigir ou executar retorno conforme impacto; não restaurar cegamente um banco antigo sobre dados financeiros novos.

Não deixar alterações em equipamentos continuarem por dois executores durante a troca. Definir um sistema autoritativo por grupo de assinantes.

## 10. Prompt para a IA de desenvolvimento

```text
Prepare o NexoISP para a primeira entrada em produção em sete dias, seguindo docs/06-plano-entrada-producao-7-dias.md e os documentos 01 a 04.

O objetivo agora é fechar o núcleo operacional existente. Não ampliar módulos nem reescrever a arquitetura. Inspecione o estado atual e os commits posteriores à avaliação de referência antes de aplicar correções já possivelmente resolvidas.

Comece pelas lacunas do motor de rede: validação de lease_until em begin() e confirmação correta das sessões na alteração de perfil/IP. Acrescente somente regressões pequenas para esses comportamentos.

Em seguida avance nas dependências disponíveis: um gateway real em sandbox, migração com amostra autorizada, ambiente de homologação, configuração de produção, backup/restauração, instalação do agente e ensaio integral.

Refine apenas as telas essenciais de assinante/contrato, financeiro e navegação. Preserve a identidade atual. Recursos experimentais devem ficar indisponíveis no backend e na interface da versão liberada.

Não pare para pedir confirmação de alterações locais reversíveis. Tome decisões técnicas rotineiras. Quando faltar acesso ou regra comercial, descreva a necessidade concreta e conclua o trabalho independente. Não invente credenciais, não apresente simulação como integração real e não ative suspensão automática sem a política configurada.

Reutilize as verificações existentes. Não persiga cobertura, não crie testes triviais e não amplie a suíte sem um risco concreto. Registre de forma curta o que foi implementado, verificado e ainda depende de homologação externa.

A meta da semana não autoriza escrita em equipamentos, cobranças ou migração de produção fora do ambiente e grupo explicitamente autorizados. Prepare a versão e o procedimento de corte; execute a entrada apenas com o destino e escopo definidos pelo proprietário.

Entregue código funcional e avance pelo trabalho autorizado. Ao encerrar, informe se a versão está pronta para homologação, pronta para corte ou já implantada, junto dos bloqueios concretos. Não declare a produção concluída apenas porque o build passou.
```

## 11. Acompanhamento curto

Atualizar ao final de cada dia: entrega concluída, impedimento externo, responsável, próxima ação e decisão sobre a data-alvo. Evitar percentuais genéricos de prontidão.

**Situação inicial:** plano elaborado; equipe, acessos, grupo piloto e destino de produção ainda precisam ser informados nesta conversa. Nenhuma implantação foi executada por este plano.

### 10/10/2026 — véspera do dia 1

**Concluído (verificado localmente e em laboratório virtual; nada no ambiente do provedor):**

- 5.1 e 5.2 corrigidos no commit `a7da726`, cada um com regressão que falha no código anterior; troca de plano repetida no laboratório com cliente PPPoE online.
- Módulos por provedor: provedor novo nasce só com o núcleo do item 2; OLT, CGNAT/IP, OS/estoque, rede óptica, CRM, NOC e avisos só com liberação do operador,
  recusados pelo servidor (`module_disabled`) e ocultos no menu.
- Conferência de entrada em produção (`cli.js preflight`) e homologação local com a configuração de produção (`./nexo homolog up`): sem contas, drivers ou gateway de
  demonstração; MFA obrigatório; backup e `restore-check` feitos nela; conferência sem falhas.
- Telas do item 6: “Próxima ação” no acesso do contrato, sessão desconhecida diferenciada de sem sessão, login com mostrar/ocultar senha e orientação de recuperação,
  menu só com o que está liberado.
- Backup: gancho `NEXO_BACKUP_COPY` para cópia fora do host.
- Verificação do item 7: 61 testes de API e 31 do agente passando; tipos e build sem erros. Itens 1 a 3 cobertos pelos testes; 4 só no laboratório virtual; 5 com dados sintéticos.

**Situação: pronta para homologação. Não está pronta para corte.**

**Impedimentos externos (item 3, todos em aberto; responsável: proprietário):**

| Falta | Bloqueia | Primeira ação |
|---|---|---|
| Provedor, responsáveis e grupo inicial (contratos e NAS) | Dias 2, 6 e 7 | Indicar o provedor e a lista do grupo |
| Modelo e versão do RouterOS, com acesso autorizado | Dia 2 | Informar o equipamento e liberar o acesso para repetir `docs/lab-pppoe.md` |
| Gateway de pagamento e credenciais de sandbox | Dia 3 | Dizer qual gateway e fornecer a chave de sandbox |
| Exportação do MK-Auth, com a versão | Dia 4 | Enviar um arquivo de amostra autorizado |
| Host central, domínio e destino dos backups | Dia 5 | Informar o servidor e o domínio |
| Política de cobrança e suspensão; processo fiscal | Dias 3 e 6 | Decisão do provedor |

**Decisão sobre a data-alvo:** 17/10 mantida como meta, condicionada a o gateway, a amostra do MK-Auth e o acesso ao equipamento chegarem até 12/10.
Se o gateway não chegar, a alternativa do item 8 (entrada só operacional, cobrança no sistema anterior, suspensão automática desligada) mantém a data.

### 10/10/2026 — correções de engenharia da revisão interna

- **Integração contínua** (`.github/workflows/ci.yml`): a cada envio roda auditoria de dependências, tipos, build, 62 testes da API com o papel real do banco,
  31 testes do agente e a fumaça da interface em navegador sobre banco vazio.
- **Fumaça da interface versionada** (`e2e/smoke.mjs`): login, assinantes, contrato, faturas, confirmação do sistema, NOC, tema, perfil sem acesso à rede e portal no celular.
- **Dependências:** `@fastify/static` 8 → 10 e `react-router-dom` 6 → 7 (quatro avisos altos e dois moderados); `npm audit --omit=dev` sem vulnerabilidades.
- **Limite de login no banco**, por e-mail e por endereço de origem, com teste que simula outra réplica.

### 10/10/2026 — cenário do PNETLab, etapa 1 (levantamento, só leitura)

- **Estado conferido no servidor novo (10.10.0.26):** 4 containers no ar, 62 testes da API e 31 do agente passando. O usuário `enok` não está no grupo `docker`:
  `./nexo` só funciona com `sudo docker` (pendência de ambiente, decisão do proprietário).
- **Cenário `Trio_ISP_FoxNet_WorldFibra_AlphaNet.unl`:** 13 nós, todos MikroTik CHR **7.17 (stable)**, licença gratuita, todos ligados. Três concentradores PPPoE
  (um por provedor), cada um com um nó cliente (CHR com `pppoe-client`) já conectado por usuário local; RADIUS desligado (`use-radius=no`) nos três.
- **Não há OLT de fabricante:** os três nós “OLT” são CHR em bridge de duas portas. O driver `olt_huawei` não tem com quem falar neste cenário; a homologação de OLT
  continua pendente (item 1.1 do doc 05). Nenhum driver novo será escrito sem decisão do proprietário.
- **Gerência:** só console telnet local (portas 30115–30127) e Winbox de um nó; **não existe caminho IP** entre o servidor e os nós (a rede de gerência foi retirada
  do cenário). RADIUS e `api-ssl` exigem criar esse caminho: entra na proposta da etapa 2.
- **Cuidado:** os concentradores carregam configuração derivada de backups reais dos provedores, com contas PPPoE. Nada disso entra no repositório (público).
- **Nada foi alterado** em equipamento, no PNETLab nem no Docker. Situação inalterada: pronta para homologação, não para corte; nada homologado em equipamento físico.
- **Próxima ação:** proposta da etapa 2 e ok do proprietário antes de qualquer escrita em nó do cenário.

### 10/10/2026 — cenário do PNETLab, etapas 2 e 3 (PPPoE)

- **Autorizado pelo proprietário:** concentrador `WORLD-MK4011` (CHR 7.17), mantendo a licença gratuita. Configuração acrescentada ao nó é marcada e reversível (`infra/lab-pnetlab/trio.sh down`).
- **Concluído:** site (agente + RADIUS) ligado ao nó; agente e equipamento cadastrados; os 12 casos de `docs/lab-pppoe.md` repetidos e aprovados, mais TLS, vários clientes e IP fixo
  (resultado por caso na seção 5 daquele documento). Nenhum nó foi parado ou reiniciado.
- **Classificação:** validado no cenário do PNETLab. **Não** é homologação em equipamento físico; o item 0.3 do doc 05 continua aberto. O proprietário informou que vai comprar um MikroTik.
- **Ficou de fora, com motivo:** OLT (o cenário não tem OLT de fabricante); medição de velocidade (licença gratuita do CHR); NAS travado sem resposta (os nós não podem ser pausados).
- **Também validado no cenário:** segunda instância do RADIUS (cliente reautentica com a principal parada) e CGNAT determinístico (19 traduções conferidas, TCP e UDP,
  com as regras colocadas antes do NAT que o nó já tinha e removidas ao final). CGNAT continua fora do escopo desta semana (item 2); o teste só atualiza o item 1.2 do doc 05.
- **Próxima ação:** repetir o roteiro no equipamento físico quando chegar; decidir `require_message_authenticator` no RADIUS conforme a versão do RouterOS do piloto.
- **Impedimentos externos:** os mesmos da tabela de 10/10 (provedor piloto, gateway, MK-Auth, servidor de produção, política de cobrança e fiscal). Data-alvo inalterada e condicionada a eles.

### 13/10/2026 — comparativo com o SGP

- **Entregue:** `docs/07-comparativo-sgp.md`, a partir da documentação de API do SGP (cópia local, não versionada). Cruzamento com o código do `main`, por área.
- **Achados que afetam o plano:** (1) dois dos três provedores do cenário são atendidos por SGP, então a origem da migração provável é o SGP, não o MK-Auth; falta confirmar com
  amostra se a senha PPPoE sai da exportação. (2) O SGP suspende por perfil de bloqueio (cliente conecta, cai em endereço de aviso), não por rejeição, que é a única modalidade nossa.
- **Próxima ação:** proprietário decide se a suspensão por perfil de bloqueio entra no núcleo desta semana (proposta: sim, é pequena) e fornece uma exportação do SGP.
- **Data-alvo e situação:** inalteradas (pronta para homologação, não para corte).

### 13/10/2026 — implementação a partir do comparativo com o SGP

- **Autorizado pelo proprietário** ("pode implementar tudo"). Implementado e testado (79 testes de API, 40 do agente): suspensão por perfil de bloqueio, vínculo de MAC,
  consumo mensal, liberação por confiança (equipe e portal), baixa parcial, desconto, estorno, multa e juros, acordo, primeiro mês proporcional, dados da pessoa,
  etiquetas, aviso de manutenção, checklist da OS e comodato. Detalhe e classificação em `docs/07-comparativo-sgp.md`, seção 7.
- **Validado no cenário do PNETLab** (CHR 7.17): suspensão por perfil (reconexão no pool de bloqueio com 1k/1k, volta ao plano e ao IP fixo), vínculo de MAC
  (MAC errado recusado) e consumo mensal conferido com o accounting. **Não** é homologação em equipamento físico.
- **Regras mantidas:** tudo novo é opt-in por provedor; com os padrões, o comportamento anterior não muda. Suspensão automática continua desligada sem política.
- **Atenção ao implantar:** agente **0.4.0** no site antes de ligar suspensão por perfil, MAC ou consumo (a API recusa emitir para agente antigo). Migrações 020 a 024.
- **Fora, e por quê:** contas a pagar/caixa (outro produto), fiscal, TR-069, IPoE/hotspot, 2º fabricante de OLT, CNAB, API pública, SMS/URA, cartão, fotos da OS.
- **Situação:** pronta para homologação, não para corte. Impedimentos externos inalterados.
