# Consolidação e retirada dos espelhos SGP

A retirada de `docs/SGP/` foi autorizada depois de consolidar o conhecimento e os itens pendentes. Não depende de concluir todos os módulos nem declara paridade com o produto de origem.

## O que ficou no projeto

- Os **101 títulos sem rota** foram revisados individualmente em [revisao_101_menus.csv](revisao_101_menus.csv): tema associado, destinação e limite. São agrupadores; copiar sua hierarquia não é requisito funcional. Nomes insuficientes continuam com escopo a definir.
- Os **956 controles dos 44 formulários** têm revisão documental em [campos_44_formularios.csv](campos_44_formularios.csv): nome normalizado, domínio, destinação, destino parcial ou lacuna, evidência do código quando existente, proposta/questão, aceite e limite. Nenhuma regra desconhecida foi marcada aprovada.
- O [resumo de destinações](resumo_revisao_campos.json) distingue 25 correspondências parciais nativas; 52 metadados técnicos dispensáveis; 83 controles de editor genérico substituíveis por configuração tipada; 31 controles de comando/template livre substituíveis por operação tipada; e 765 controles com regras/escopo/acesso/integração a especificar. São ocorrências, com repetições e subformulários.
- As [evidências consolidadas](evidencias.md), [referências estruturadas](evidencias_sanitizadas.json), matrizes, hashes e propostas por formulário preservam o conhecimento necessário ao backlog sem registros ou valores das fontes.

O script `scripts/consolidar-sgp.py` registra as regras dessa revisão pontual sobre o inventário sanitizado; recusa sobrescrever sua proveniência. O verificador permanente é `scripts/auditoria-sgp.py`, que não lê a pasta retirada e não precisa abrir o backup.

## Cópia privada fora do projeto

Os originais foram reunidos em arquivo `.tar.gz` sob `/home/enok/Documentos/arquivos-restritos/NexoISP/`. O [recibo de retirada](retirada_fontes.json) informa nome completo, tamanho, SHA-256, permissões e estado da remoção. O arquivo foi lido integralmente e os hashes de **cada um dos 1.207 arquivos** coincidiram com o inventário inicial, antes de remover a pasta local.

O diretório tem permissão **0700** e o arquivo **0600**. É cópia local com acesso restrito, sem criptografia e sem redundância remota; fica fora do Git e dos contextos de build por estar fora do projeto. Não extrair em diretório público, reutilizar credenciais/cookies, executar os originais ou importar seus registros como fixtures. A consulta ao arquivo é excepcional, para história da coleta, sem dependência para desenvolvimento normal.

## Verificação e manutenção

```bash
python3 scripts/auditoria-sgp.py --check
```

O comando confere cardinalidades, IDs, referências, destinos, códigos citados pelos campos, links locais e hashes do dossiê. Depois de uma alteração documental legítima revisada:

```bash
python3 scripts/auditoria-sgp.py --atualizar-manifesto
```

Para conferir opcionalmente a cópia privada, sem extrair nem executar arquivos, use `--check-backup` seguido do caminho informado no recibo. Essa verificação compara o hash do arquivo e todos os seus membros ao inventário inicial.

O processo de retirada não altera código do produto, banco, containers, ambiente de produção ou resultados dos ensaios anteriores. O [backlog](backlog.md) continua registrando decisões de produto e homologações pendentes.
