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

## Trabalho de campo na OS (09/11/2026)

| Tema | Decisão | Motivo |
|---|---|---|
| Quem registra presença e assinatura | Técnico atribuído (responsável ou auxiliar) ou quem tem `os:write`; as rotas abrem com `os:read` e a regra fica no handler Go | A regra pedida admite técnico só com leitura; os perfis atuais com `os:read` também têm `os:write`, então nada muda para eles |
| Check-in e fluxo da OS | Check-in em OS aberta, em análise, agendada ou em deslocamento passa a OS para "em execução" pela mesma transição de "Iniciar execução"; recusado em OS aguardando agendamento ou encerrada. Concluir ou cancelar fecha presenças abertas (`os_finished`) | Integra a chegada ao fluxo existente sem criar estado novo e impede tempo em atendimento crescendo após o encerramento |
| Tempo em atendimento | União dos intervalos de presença (sobreposição de técnicos conta uma vez) | Mede a duração da visita na OS, não horas-homem |
| Coordenadas | Distância calculada no servidor (haversine) até a coordenada do contrato da OS; a consulta devolve distância e precisão, não as coordenadas do aparelho | Minimiza exposição da posição do técnico; a anonimização do titular apaga coordenadas, quem assinou e legendas |
| Assinatura | Uma por OS, PNG de 100×50 a 4096 px e até 1 MiB, documento `kind = 'signature'` fora da lista e da exclusão de anexos | Assinatura é evidência: não pode ser trocada nem apagada pelo fluxo de anexos |
| Idempotência | Chave opcional nas rotas de check-in/check-out, anotação e checklist; recibo por provedor, usuário e chave com hash do pedido (inclui OS e ação) | Repetição devolve a resposta gravada; mesma chave com outro conteúdo recebe 409. Sem chave, as rotas se comportam como antes |
| Fila offline | `localStorage` por sessão, coordenada por Web Locks; ação confirmada sai da fila; recusa definitiva fica com motivo até o técnico descartar; falha de rede, 5xx, 429 e troca de sessão mantêm pendente | Mesmo padrão da intenção de material; nenhuma regra de negócio no navegador |
| Foto pela câmera | `accept="image/*"` e `capture="environment"`, reduzida para lado maior de 1920 px em JPEG no navegador; o servidor continua validando tipo e tamanho. `Permissions-Policy` do servidor de desenvolvimento alinhada à de produção (`geolocation=(self)`) | A captura pelo seletor de arquivos não depende de `camera`; a geolocalização precisa estar liberada para a própria origem |
