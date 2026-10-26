# Roteiro do primeiro piloto

Este roteiro organiza as decisões e evidências necessárias para operar o NexoISP com um primeiro provedor. A conclusão de uma etapa exige evidência registrada e responsável definido. Ele complementa as [pendências de produção](pendencias.md) e não substitui a homologação de equipamentos.

## 1. Delimitar o piloto

- [ ] Definir provedor, grupo de contratos, responsáveis técnicos e janela de mudança.
- [ ] Definir qual sistema é a fonte de verdade para cadastro, cobrança e acesso durante cada etapa.
- [ ] Escolher contas de teste e contratos que possam ser ativados, suspensos e revertidos sem impacto a clientes.
- [ ] Registrar condições de interrupção e quem pode autorizar retorno ao sistema anterior.

## 2. Preparar o ambiente

- [ ] Configurar domínio, DNS, HTTPS, firewall, certificados e segredos exclusivos do host.
- [ ] Ativar MFA de todos os administradores e confirmar ausência de usuários, equipamentos e gateway de demonstração.
- [ ] Executar `./nexo prod db preflight` e guardar a saída.
- [ ] Se o TR-069 for usado, seguir a configuração segura em [operação](operacao.md), incluindo TLS e autenticação CWMP antes de abrir a porta aos CPEs.
- [ ] Definir capacidade esperada e monitoramento externo para saúde, disco, agentes e operações incertas.

## 3. Ensaiar dados e reversão

- [ ] Usar exportação autorizada e registrar origem, data e responsável.
- [ ] Fazer prévia de importação; conferir amostras de assinantes, contratos, credenciais, saldos, endereços e vínculos de rede.
- [ ] Registrar divergências aceitas e rejeitadas antes de aplicar os dados.
- [ ] Executar um ensaio de corte e um de reversão em ambiente isolado, incluindo alterações feitas depois do corte.
- [ ] Definir quem reconcilia registros e qual fonte prevalece em cada conflito.

## 4. Homologar serviços reais

- [ ] Validar PPPoE/RADIUS em equipamento e firmware usados pelo provedor, com mais de uma conta e perfis de acesso.
- [ ] Confirmar provisionamento, alteração, suspensão, reativação e desconexão, distinguindo comando enfileirado de resultado confirmado.
- [ ] Validar OLT/ONU e TR-069 apenas nos modelos e firmwares efetivamente disponíveis no piloto.
- [ ] Confirmar que uma falha de enlace ou reinício não provoca repetição insegura de operações.
- [ ] Manter automações financeiras e suspensão automática desligadas até gateway, conciliação e política comercial estarem homologados.

## 5. Recuperação e corte controlado

- [ ] Configurar cópia de backup fora do host e restaurar uma cópia em ambiente isolado.
- [ ] Preservar `.env`, certificados, chaves e SQLite dos sites fora do backup do banco, com acesso restrito.
- [ ] Definir objetivos de perda de dados e tempo de recuperação com o provedor.
- [ ] Começar com um grupo pequeno e manter uma única fonte de verdade para cada domínio operacional.
- [ ] Ter roteiro, responsável e janela para reverter o grupo sem descartar alterações posteriores ao corte.

## 6. Acompanhar e encerrar o piloto

- [ ] Registrar incidentes, operações incertas, falhas de autenticação, erros de cobrança e intervenções manuais.
- [ ] Fazer revisão diária com os responsáveis do provedor durante a janela acordada.
- [ ] Encerrar o piloto somente após os critérios definidos antes do início serem atendidos e as pendências aceitas terem responsáveis e prazo.
- [ ] Decidir com evidência se amplia o grupo, corrige o ambiente ou retorna ao sistema anterior.

## Registro de evidências

Guardar, sem incluir segredos ou dados pessoais desnecessários:

- responsável, data, ambiente e versão implantada;
- saída do preflight, prova de backup/restauração e resumo da migração;
- modelos/firmwares homologados e resultados dos cenários de rede;
- incidentes, decisões, exceções aceitas e decisão final do piloto.
