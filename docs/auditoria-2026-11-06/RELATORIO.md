# Auditoria e estabilização local — 06/11/2026

**Parecer: apto à avaliação local sintética no recorte executado; publicação e piloto ainda bloqueados.** Não houve push, deploy, migração de clientes, chamadas a gateways/canais/equipamentos reais, alteração do proxy/ChatISP ou retomada do Paseo. Não foram acrescentados módulos de negócio. A ausência dos dois pareceres completos limita o confronto às alegações transcritas na missão.

[Versões do runtime e condições da prova](runtime.json).

Fonte operacional vigente: `docs/ESTADO.md`. Este relatório registra a evidência da auditoria; `PLANO` e matriz preservam recibos históricos da integração, sem renovar a cobertura integral da etapa 7. Pendências externas têm uma [lista única com ações exatas](PENDENCIAS-EXTERNAS.md).

## Versão e preservação

Início: branch `dev/lote01-consolidado-2026-10-26`, HEAD `9119c57e67561b3bc28ace64440785f6e0a3842c`, diretório limpo. Não havia trabalho local ou commits posteriores à baseline a preservar. Implementação/harness: commit local `cbbb751`. A documentação/evidências forma o commit seguinte no histórico desta branch; o HEAD final identifica ambos. O estado final do diretório é registrado na entrega após esse commit. `source-sha256.json` vincula o conteúdo dos arquivos de implementação/harness desta entrega; os recibos de execução identificam a baseline mais as alterações locais, não um CI publicado do novo candidato.

## Achados e decisões

| Achado | Conclusão e ação |
|---|---|
| Dois CIs divergem no mesmo SHA | **Confirmado, causa inconclusiva.** API pública confirma workflow `.github/workflows/native.yml`, primeira tentativa, `push`, runners `ubuntu-24.04`, SHA igual. A falha está no restore. Logs completos retornam 403 sem credencial disponível. [Metadados e passos](github-runs.json). Não foi inventada causa nem considerada uma execução verde como correção da divergência |
| Dependência da ponte Docker padrão no B12 | **Defeito local do ensaio confirmado.** Primeira reprodução: erro de criação de endpoint porque `docker0` não existe. A rede exclusiva elimina essa dependência. Em seguida, a alocação padrão falhou por esgotamento dos pools; foi usada sub-rede privada /28 livre e explícita, sem alterar o daemon ou redes existentes |
| Prontidão do PostgreSQL | **Fragilidade de código corrigida, sem atribuição ao CI.** A espera por socket podia aceitar o servidor temporário de init da imagem. Agora exige TCP em 127.0.0.1, como o healthcheck de produção. A regressão representa socket pronto antes do TCP; não comprova o erro dos logs inacessíveis |
| Concorrência/limpeza do ensaio | Binários passam a residir no diretório exclusivo da execução. Rede, volumes e containers são nomeados/rotulados por run; recursos preexistentes são recusados. Falha de descoberta/remoção impede sucesso. O recibo verde só é emitido depois da limpeza |
| Restore operacional reabria sem prova equivalente ao restore-check | **Defeito confirmado e corrigido.** Antes havia checksum genérico e stop/start opcionais; faltavam manifesto/isolamento/chaves antes de substituir. Agora exige destino explícito, autentica exatamente dump+manifesto, recusa duplicatas/caminhos extras, ensaia restore temporário com verificador criptográfico e confere snapshot/RLS no banco substituído. `prepare` é obrigatório, mesmo sem serviços previamente ativos. Falha após parada mantém escritores parados |
| Falha ao descobrir escritores no wrapper | **Defeito confirmado e corrigido.** Substituição de processo e `|| true` podiam esconder erro do Compose. Agora a descoberta falha antes de chamar o restore. Regressão verifica que só ocorre a consulta de serviços, sem mutação |
| Lacuna entre API e laboratório de 100 contas | **Confirmada na documentação e no roteiro externo consultado.** O ensaio de 02/11 inseria contas diretamente em `radius_*`. Foi acrescentada prova independente API → River → autorização RADIUS → PAP/UDP real, sem inserção direta nessas tabelas |
| Documentação desatualizada | **Confirmada e corrigida.** Pendências negavam IP fixo/tipos de importação já existentes; arquitetura/README omitiam o pipeline Efí sandbox; IPv6 e metas provisórias divergiam. Registros antigos foram identificados como históricos |
| Produtividade das filas | **Confirmada e corrigida no recorte.** Cabeçalhos/resumos compactos, rótulos operacionais objetivos, resumo/gráficos financeiros recolhidos, identidade e ações fixas na rolagem horizontal. Falha medida de primeira linha em 832 px no celular motivou recolher também os indicadores financeiros |
| Domínio abrindo PNETLab | Resposta local com esse Host/SNI confirma redirecionamento para `/store/public/admin/main/view`. HTTPS no IP público foi recusado deste host; não é prova de disponibilidade externa. A aplicação antiga está parada. [Configuração e pré-requisitos](PUBLICACAO.md), sem implantação |

Descartados como conclusões: “é só o ambiente porque outro CI passou”; “100 usuários homologam Huawei/Cisco”; “importação implementada equivale a migração real”; “backup local protege contra perda do host”; “teste rápido comprova RPO/RTO”; “pipeline Efí sandbox é integração financeira homologada”. Nada nas provas sustenta essas afirmações.

## Recuperação: mecanismo, prova e operação

- **Implementado:** dump custom e manifesto do mesmo snapshot PostgreSQL; soma de dump e manifesto; restore temporário; conferência de catálogo, versões, RLS, grants, contagens e totais; verificador AES/RADIUS; guardas novas do restore destrutivo. Documentos e anexos privados em `documents.content` integram o banco.
- **Executado localmente:** 17 fases B12, com origem/destino em clusters exclusivos, segredo errado e dump/manifesto adulterados recusados, anexos por bytes, login/sessão, recusa entre tenants, portal/POP, fila persistida com jobs desligados e replay da compensação. Além disso, o script real restaurou `nexo` somente no container descartável: `prepare=false` deixou marcador de parada presente e retomada ausente; recuperação posterior validou snapshot/isolamento/chaves, executou `prepare` e retomou o ciclo sintético.
- **Fora do dump:** `.env`, chaves AES/RADIUS/assinatura, certificados/mTLS, volumes VPN e SQLite dos sites exigem cópia e cofre próprios. Backups antigos sem manifesto autenticado precisam de recuperação isolada específica, sem contornar guardas no destino real.
- **Ainda não configurado/homologado:** destino externo, perda do host físico, cofre, canal operacional, reconciliação de alterações posteriores e aceite do operador. A fila restaurada foi mantida sem efeitos externos; sua existência não autoriza reenviar transporte incerto. RPO 24 h/RTO 4 h são metas provisórias, não resultados medidos.

Uso destrutivo agora exige, além de `--yes`, `NEXO_RESTORE_TARGET=<container>/nexo`, conforme [operação](../operacao.md). Os wrappers fornecem parada, preparação, verificação e retomada. Não executar esse comando no host compartilhado para reproduzir a prova: os harnesses criam seus próprios destinos.

## Jornadas e confiabilidade verificadas

| Jornada | Evidência nova e alcance |
|---|---|
| Cadastro/contrato/importação | Browser/API cria titular e contrato com UUID real. B12 importa lote sintético e reproduz compensação após restore. Há implementação documentada de IP fixo e tipos próprios de importação. Não houve exportação SGP/IXC ou migração de dados reais; os testes específicos históricos do IPAM não foram todos repetidos |
| Consulta financeira/manual | Fatura sintética, baixa manual com mesmo intent repetido e releitura de título pago; recusa entre provedores. Testes de outbox/avisos não fazem emissão financeira externa. Na fase 1 a cobrança continua na origem; nenhum pagamento automático foi ativado |
| Atendimento/OS/estoque/anexos | Protocolo sintético na fila; contratos HTTP existentes de OS/anexos e cotação/recebimento reaproveitados contra API Go e SQL exclusivo: download por bytes, sem autenticação/portal/outro tenant/POP, exclusão e LGPD; concorrência de requisições de estoque numa API. Não alegar duas réplicas nessa prova |
| Acesso | [Recibo API-RADIUS](radius-api.json) preserva titular/contrato/recurso/credencial/operação e confirma execução River com SUCCEEDED; FreeRADIUS real responde PAP Accept/Reject e o autenticador UDP é conferido. Não cobre sessão PPPoE, accounting, carga de 100, CoA físico, suspensão/reativação no NAS ou fabricante físico |
| Recuperação e auditoria | B12 e restore operacional acima; teste PostgreSQL do diário de desconexão comprova recuperação sem reenvio e escopo do NAS. Estados de operação permanecem distintos da intenção comercial. A prova de fila persistida não equivale a efeito confirmado no equipamento |
| Avisos/confiabilidade | Leitura de `outbound/notices.go`, `notices_cloud.go`, `delivery.go` e `jobs/jobs.go`: avisos são enfileirados antes do transporte; alertas atualizam `lastAlert` depois de resposta 2xx válida. PostgreSQL/race valida locks/rollback, estado incerto sem reenvio, gates por tenant, retenção e recuperação do worker. Deduplicação de alertas é em memória e transportes genéricos de webhook têm reentrega: não há garantia universal exactly-once. Avisos automáticos continuam fora da fase 1 |

Prova RADIUS neste host: Docker 20.10.9 recusou criação de threads da imagem atual com `Operation not permitted`. Apenas o container descartável FreeRADIUS usou `seccomp=unconfined`, opção explícita do harness; [falha sanitizada](radius-startup.log) e ajuste no recibo. Nenhuma política de segurança do host/produto foi alterada. A implantação definitiva precisa de runtime compatível e configuração própria de segurança.

## Interface e validação

Cinco capturas demonstrativas comparadas com a referência original ficaram idênticas pixel a pixel: assinantes em claro/escuro/celular, faturas e atendimento ([recibo](demo/comparacao-visual.json)). A primeira tentativa de comparação falhou por dependência CSS não resolvida e fontes bloqueadas pela allowlist do servidor da referência; ajustar somente o ambiente de referência resolveu a divergência, sem editar seu código.

Mantidos componentes, tokens, fontes e identidade v0; CSS adicional está em `apps/web/src/erp.css`. A demonstração recebe o mesmo conteúdo, sem wrapper operacional. Componentes `ui`, CSS global e referência original não foram editados. Os resumos opcionais financeiros ficam em `<details>`, com abertura por teclado e carregamento da série sob demanda. Avisos de demonstração/limitações continuam visíveis.

[Recibo de browser](browser.json): 1440×900 e 390×844, três filas, sem alargamento da página e com ações acessíveis após rolagem horizontal. Primeira linha no celular: assinantes 624 px, faturas 581 px, atendimento 699 px. Não são metas universais para qualquer volume/texto ou zoom. Capturas: [assinantes](assinantes-estreito.png), [faturas](faturas-estreito.png), [atendimento](atendimentos-estreito.png). Foco da abertura gerencial validado pelo teclado; a avaliação visual automatizada não substitui uso com atendente, leitor de tela ou auditoria completa de contraste.

Validações:

- 31 testes Python de operação/guardas aprovados, incluindo falha de descoberta do Compose, destino errado, manifesto sem checksum e recusa da prontidão temporária.
- [44 testes/subcasos Go](go-focused.jsonl), PostgreSQL 16.15 real, `-race`, nenhum skip: fase 1, restore Cloud/chaves, diário de desconexão/isolamento, avisos, rollback/locks, falha de tenant e retomada, framing/cancelamento UDP e prefixo delegado. Não é execução de toda a suíte Go.
- [Restore e Go](proof.json): o recibo `ok:false` preserva a tentativa integrada em que o backend passou e o browser detectou a tabela financeira abaixo da tela. Após correção, [nova prova focada de HTTP/browser](browser-run.json) passou, reutilizando os resultados Go sem repeti-los.
- Typecheck e build finais com Node 22.23.4/npm 10.9.9; seis testes locais de fidelidade/assinantes aprovados. Build mantém avisos existentes sobre chunks grandes e import estático/dinâmico do portal; não bloquearam compilação.

Reprodução (dependências instaladas, Docker/Go/Node/Chromium disponíveis; escolher /28 livres se os pools deste host estiverem esgotados):

```bash
python3 -m unittest discover -s tests/operacao
NEXO_B12_SUBNET=192.168.249.0/28 python3 tests/contrato/pilot_audit.py
# Repetir só HTTP/browser após ajuste de interface:
NEXO_AUDIT_UI_ONLY=1 NEXO_B12_SUBNET=192.168.249.0/28 python3 tests/contrato/pilot_audit.py
# Imagem exclusiva, sem push ou NAS:
docker build --network host -t nexo-audit-radius:local infra/radius
NEXO_B12_SUBNET=192.168.248.0/28 python3 tests/contrato/radius_api_lab.py
```

`NEXO_AUDIT_NODE` seleciona o executável Node compatível se necessário. Somente no runtime antigo deste laboratório, `NEXO_RADIUS_LAB_OLD_DOCKER=1` habilita a exceção seccomp registrada acima. Os scripts não carregam `.env` de produto, limpam apenas recursos próprios e falham sem dependências; não há skips nem retries cegos de efeito externo.

## Documentação e prontidão

Reconciliados README, ESTADO, PILOTO, pendências, arquitetura, operação e roteiro PPPoE. PLANO/matriz receberam nota temporal; nenhuma unidade funcional foi promovida sem prova, nem as contagens históricas foram usadas como aceite integral atual. Relatórios de lotes preservam rastreabilidade e são históricos quando divergirem de ESTADO.

A avaliação local pode usar este recorte sintético. Para publicar, faltam candidato com CI/SBOM, resolução da divergência original, configuração exclusiva e teste externo de HTTPS/origem. Para piloto, faltam operador/grupo, dados autorizados conferidos, NAS físico, recuperação externa assistida, monitoramento e aceite de uso. Cobrança real, fiscal e avisos automáticos não foram habilitados. As ações, responsáveis a designar e distinção das fases estão em [Pendências externas](PENDENCIAS-EXTERNAS.md).
