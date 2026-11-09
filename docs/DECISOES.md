# Decisões técnicas

Registro das decisões tomadas sem consulta ao dono durante a rodada de conclusão iniciada em 09/11/2026. Cada item diz o que foi decidido e por quê, para revisão posterior. Decisões anteriores do piloto continuam em [ESTADO](ESTADO.md).

## Escopo da rodada de conclusão (09/11/2026)

| Tema | Decisão | Motivo |
|---|---|---|
| Itens construíveis sem terceiros | Implementar e validar: template ACS, projeto físico FTTH (cabos, fusões, OTDR, importação KML), campo (check-in/check-out, assinatura, fotos, fila offline), liquidação de comissões, custo médio e contas a pagar, viabilidade pública, conformidade do arquivo DICI, troca obrigatória de senha, multa/juros na cobrança Efí, painel de acompanhamento operacional e assistente | São lacunas internas: dependem só de código e testes |
| Fiscal integrado (NFCom/NFS-e) | **Não implementado** | Exige certificado A1 do provedor, credenciamento na SEFAZ/município e ambiente de homologação fiscal. Um emissor sem homologação não pode ser validado e emitiria documento fiscal inválido. Mantida a decisão da fase 1 (fiscal inativo) |
| Gateway em produção | Implementar o que falta no adaptador (multa/juros), validado contra servidor simulado | Conta Efí real ou sandbox autenticado não está disponível; o adaptador continua restrito a sandbox até homologação |
| Transmissão DICI à ANATEL | Gerar o arquivo no leiaute da coleta e manter o envio manual | A ANATEL recebe o DICI pelo sistema de coleta com login gov.br; não há API pública para envio automático |
| OLT de outros fabricantes | Não escrever drivers sem equipamento | Driver sem equipamento repetiria a situação do Huawei (não homologado); o valor real vem da homologação |
| Multicélulas | Manter célula única `c1` | Capacidade de 100 mil assinantes já medida em uma célula; distribuir dados aumenta o risco sem demanda |
| Interface legada (`apps/web-legacy`) | Mantida | Regra do `AGENTS.md`; continua sendo consulta de contratos HTTP |
| Assistente | Assistente determinístico sobre busca, diagnóstico e pendências existentes, sem modelo de linguagem externo | Uso de IA externa exige decisão sobre envio de dados pessoais a terceiros; a versão determinística resolve a navegação assistida sem esse risco |
| Branches antigas | Apagadas as 20 branches remotas e 4 locais já contidas em `main` | Nenhum commit é perdido: todos estão em `main`; reduz confusão para quem acompanha o repositório |
| Stacks abandonadas | Removidos os containers das stacks `nexoisp` e `nexoisp-go` (sem API nem banco ativos); volumes mantidos | Eram a origem do loop da VPN e de agentes tentando falar com API inexistente; volumes guardam bancos antigos e apagá-los seria irreversível. O laboratório `radlab-*`, o cenário `nexo-trio`, o painel e o ChatISP não foram tocados |
| Deduplicação de alertas | Persistida no banco (`platform_alert_state`, migração 00094), lida e gravada só por funções `security definer` | Em memória, cada reinício ou réplica reenviava o mesmo alerta. Instalação nova sem alertas registra o estado sem enviar "normalizados" |
| Limite de taxa do painel | Sem mudança | Já é compartilhado no PostgreSQL (migração 00061) e o login usa contadores no banco; a pendência "limites em memória por réplica" estava desatualizada |
| Referências visuais operacionais | Regravadas as seis capturas de assinantes depois de conferência individual | A auditoria de 06/11 compactou cabeçalho, indicadores e rótulos da fila de assinantes, mas não regravou as referências; a suíte de navegador falhava por isso, não por defeito |
| Suíte de navegador neste servidor | `e2e.py` sobe o próprio banco, aceita porta própria (`NEXO_E2E_WEB_PORT`), imagem pré-montada (`NEXO_E2E_PREBUILT=1`) e opções de Docker (`NEXO_E2E_DOCKER_OPTS`) | O Docker 20.10 deste host barra threads no `docker build` e a porta 18380 é do painel ativo; o CI continua com o comportamento padrão |
