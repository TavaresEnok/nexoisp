# NexoISP — Especificação do MVP

Versão 1.0 · 9 de outubro de 2026

## 1. Entrega esperada

Um operador deve conseguir cadastrar um assinante, associar plano e contrato, provisionar acesso PPPoE, acompanhar o resultado, gerar cobrança, confirmar pagamento e controlar suspensão/reativação. O provedor deve importar sua base disponível e o assinante consultar suas faturas.

Esta especificação cobre o MVP. Novos módulos entram pelo plano de evolução, sem aumentar silenciosamente a entrega inicial.

## 2. Usuários e permissões

| Papel | Acesso inicial |
|---|---|
| Operador do SaaS | Gestão de provedores e suporte autorizado, com auditoria |
| Administrador do provedor | Usuários, configuração e operação do próprio tenant |
| Atendimento | Assinantes e contratos; ações comerciais permitidas |
| Financeiro | Faturas, pagamentos e conciliação |
| Técnico/NOC | Equipamentos, sessões, operações e diagnóstico |
| Assinante | Seus próprios contratos e faturas |

Permissões devem ser verificadas no backend. Não basta esconder botões. O acesso de suporte a um tenant deve ser explícito e auditado. Não usar uma conexão comum da aplicação com privilégios de superusuário para facilitar administração.

## 3. Requisitos por módulo

| ID | Requisito | Aceite objetivo |
|---|---|---|
| MVP-01 | Provedores, login e papéis | Dois tenants não acessam dados um do outro; usuário sem permissão recebe negação |
| MVP-02 | Assinantes | Criar, consultar, editar e pesquisar cadastro com validações básicas |
| MVP-03 | Planos e contratos | Associar preço, perfil de velocidade e vigência; preservar histórico relevante |
| MVP-04 | Equipamentos | Registrar NAS, integração protegida e resultado de conectividade |
| MVP-05 | Provisionamento PPPoE | Criar autorização local conforme contrato e confirmar configuração |
| MVP-06 | Sessões e serviço | Exibir sessão conhecida, perfil, estado desejado e data da observação |
| MVP-07 | Suspensão e reativação | Alterar política de acesso, tratar sessão existente e verificar as etapas |
| MVP-08 | Financeiro | Gerar fatura recorrente sem duplicação para contrato/competência/tipo |
| MVP-09 | Gateway | Emitir meios de pagamento suportados e processar eventos autenticados |
| MVP-10 | Conciliação | Recuperar evento perdido; encaminhar divergência sem inventar baixa |
| MVP-11 | Portal | Assinante vê somente suas faturas, situação e meios de pagamento |
| MVP-12 | Migração | Simular e importar formato conhecido; reimportação não duplica registros |
| MVP-13 | Operação | Mostrar agente offline, atraso de sincronização e operações com problema |
| MVP-14 | Recuperação | Reinício, mensagem repetida e perda de confirmação não causam repetição cega |
| MVP-15 | Auditoria | Identificar autor, tenant, entidade, ação, horário e resultado, sem segredos |

MFA para contas administrativas, backup restaurável e atualização autenticada do agente são requisitos antes do piloto com dados reais. Podem entrar depois da primeira demonstração local.

## 4. Dados mínimos

Criar o modelo de forma incremental, com migrations versionadas. Esta lista define entidades e vínculos, não obriga uma tabela para cada termo.

| Domínio | Entidades e informações |
|---|---|
| Identidade | Tenant, usuário, vínculo, papel e sessão |
| Cadastro | Assinante, documento, contatos e endereço |
| Comercial | Plano, versão/preço, contrato, vencimento e situação comercial |
| Rede | Equipamento, referência de credencial, conta PPPoE e perfil |
| Estado do serviço | Recurso, versão desejada, política desejada, observação e data |
| Agente | Identidade, tenant, versão, equipamento autorizado e última comunicação |
| Operações | Solicitação, tentativas, posse, progresso, resultado e evidências |
| Financeiro | Fatura, itens, pagamentos e eventos do gateway |
| Migração | Origem, identificador externo, lote e inconsistências |
| Auditoria | Eventos atribuídos a usuário, agente ou rotina |

Usar `tenant_id` nas entidades do provedor e nos vínculos que precisam impedir referências cruzadas. Definir unicidade por tenant, inclusive para identificadores externos. Não confiar apenas em filtros de listagem.

Valores monetários devem usar centavos inteiros ou decimal exato com escala definida. Armazenar instantes com referência temporal inequívoca e definir o fuso usado para vencimentos. Não usar ponto flutuante em cálculos financeiros.

## 5. Cinco informações separadas

1. **Comercial:** contrato vigente, encerrado ou em outra situação aprovada.
2. **Financeira:** títulos abertos, pagos ou em conciliação.
3. **Desejada:** autorização e perfil que deveriam estar aplicados.
4. **Observada:** resultado lido no RADIUS/NAS, com horário.
5. **Operação:** andamento da tentativa de mudar o serviço.

Pagamento confirmado pode aparecer junto de “reativação pendente”. Assinante sem sessão não significa assinante suspenso. Dados antigos devem aparecer como desatualizados.

## 6. Contratos das operações iniciais

As operações usam um envelope comum: `operation_id`, `tenant_id`, `resource_id`, `device_id`, `agent_id`, `action`, `schema_version`, `desired_version`, `parameters`, `idempotency_key`, `valid_until` e referência de autorização. Cada tentativa tem identidade, posse e evidências próprias.

Não enviar credenciais em logs. Preferir referências protegidas a segredos. O schema exato deve ficar no código compartilhado/documentação gerada, evitando cópias inconsistentes.

### subscriber.provision

- Entrada: contrato, identidade PPPoE, referência de segredo, NAS e perfil homologado.
- Precondições: tenant e executor autorizados; contrato elegível; dados completos; identidade sem conflito.
- Efeito: configurar a autorização local conforme a versão desejada.
- Confirmação: ler a configuração local aplicada. A prova de conexão PPPoE pertence à homologação e ao diagnóstico, pois o equipamento do assinante pode estar desligado.

### subscriber.suspend

- Entrada: recurso, versão e política de suspensão aprovada.
- Precondições: intenção ainda vigente, posse válida e executor autorizado.
- Efeito: alterar a autorização local e tratar sessões existentes conforme política.
- Confirmação: verificar a política e o resultado sobre as sessões. Registrar cada etapa; derrubar uma sessão sozinho não comprova suspensão.

### subscriber.resume

- Entrada: recurso, versão e perfil de acesso permitido.
- Precondições: intenção de liberação vigente e contrato elegível.
- Efeito: restaurar autorização e ajustar sessão existente quando necessário e suportado.
- Confirmação: política liberada e etapas técnicas verificadas. Não exigir sessão online se não existir cliente tentando conectar.

Para qualquer operação: registrar efeito parcial; consultar antes de repetir após timeout; não concluir só porque o comando respondeu sucesso.

## 7. Estados e regras do motor

Estados de referência: `PENDING`, `RESERVED`, `EXECUTING`, `VERIFYING`, `UNCERTAIN`, `SUCCEEDED`, `SUPERSEDED`, `CANCELED`, `EXPIRED`, `FAILED`.

Nova tentativa pode usar `PENDING` com `next_attempt_at`, evitando um estado extra. Reconciliação é um procedimento. A representação pode ser ajustada sem perder os comportamentos abaixo.

- Persistir intenção e tarefa de forma consistente.
- Reservar a tarefa com transação curta. Não manter transação SQL aberta durante acesso ao equipamento.
- Antes da escrita, validar identidade, integridade, prazo, versão desejada e precondições.
- Serializar alterações conflitantes. Começar com um executor de escrita por equipamento.
- Se a intenção mudou antes de começar, marcar `SUPERSEDED` sem aplicar a mudança antiga.
- Se o efeito pode ter ocorrido, consultar antes de repetir, inclusive após expiração da posse.
- Uma entrega legítima repetida pode devolver o resultado já registrado.
- Cancelamento ou expiração não desfaz efeitos enviados: manter evidência e reconciliar com a intenção atual.
- Resultado antigo não pode substituir o estado desejado atual.
- Reconexão exige sincronização completa/versionada antes de novas escritas. Snapshot parcial não significa exclusão.
- Alteração manual externa deve ser reportada. Correção automática só dentro da recuperação de operação autorizada e quando for seguro distinguir seu efeito.
- Offline, manter políticas conhecidas no RADIUS. Novas escritas comerciais ficam suspensas por padrão.

Uma mudança comercial pode ocorrer entre a validação e o efeito no dispositivo. Nessa situação, detectar e convergir para a intenção atual; não prometer atomicidade entre nuvem e equipamento.

## 8. Financeiro e políticas pendentes

Implementar um gateway real por vez. Validar assinatura ou mecanismo equivalente do provedor, identificar a cobrança, deduplicar eventos e suportar conciliação. Uma notificação isolada ou valor coincidente não basta para atribuir um pagamento a um contrato.

Não habilitar automação de suspensão em produção sem política configurada. Definir antes de seu uso: vencimento, proporcionalidade, troca de plano, tolerância, modalidade de suspensão, descontos, juros/multa, pagamento parcial, estorno e renegociação.

Usar parâmetros de demonstração apenas em desenvolvimento, identificados como tais. Não transformar exemplos em regras comerciais universais. Desbloqueio por confiança pode ser adiado se não for requisito do piloto.

## 9. Migração e lançamento

O importador inicial trabalha com exportação autorizada e formato conhecido. Deve oferecer simulação, mapa de campos, erros por registro, vínculo com origem e reimportação segura. Não inventar o schema de uma versão desconhecida do MK-Auth.

Antes da virada: conferir clientes, contratos, valores em aberto e disponibilidade das credenciais PPPoE. Definir fonte autoritativa e grupo inicial. Não deixar dois sistemas alterarem o mesmo conjunto de assinantes sem coordenação.

A reversão deve preservar pagamentos e mudanças posteriores à migração. Restaurar um backup antigo sozinho não atende a esse requisito.

## 10. Verificação enxuta

Não há meta de cobertura. Manter cinco grupos pequenos de regressão, adicionando casos apenas quando o comportamento correspondente existir:

| Grupo | Proteção necessária |
|---|---|
| Isolamento | Tenant A não lê nem altera dados de B usando API e papel real do banco |
| Financeiro | Reexecução da cobrança e repetição de webhook não duplicam efeito |
| Intenção atual | Suspensão antiga não executa após atualização conhecida; mudança concorrente é reconciliada |
| Recuperação | Comando aplicado sem confirmação e reinício não geram repetição cega |
| Acesso real | PPPoE autentica, suspensão/reativação funcionam e RADIUS continua com nuvem indisponível |

Os quatro primeiros podem ser automatizados com escopo pequeno. O último pode começar como roteiro reproduzível de laboratório e exige infraestrutura de rede real ou virtual adequada. Um mock não comprova autenticação real.

Para telas e alterações simples: tipos/build e uma verificação manual do fluxo, sem testes que apenas reproduzam a implementação.
