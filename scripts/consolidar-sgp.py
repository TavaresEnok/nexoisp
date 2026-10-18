#!/usr/bin/env python3
"""Revisão documental pontual do inventário já sanitizado; não lê o espelho SGP.

Executar uma vez, antes da retirada das fontes. Não aprova regras de negócio.
O verificador permanente é auditoria-sgp.py.
"""
import csv
import json
from collections import Counter
from pathlib import Path
import re

OUT = Path(__file__).resolve().parents[1]/'docs/SGP_COMPARATIVO_NEXOISP'


def read(name):
    with (OUT/name).open(newline='') as f:
        return list(csv.DictReader(f))


def write(name, rows):
    with (OUT/name).open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def save(name, obj):
    (OUT/name).write_text(json.dumps(obj, ensure_ascii=False, indent=2)+'\n')


# Revisão explícita dos 101 títulos sem href. Um agrupador não é um endpoint.
MENUS = {
    'C03': '001 004 021',
    'C06': '009 013 014 016 020 027',
    'C10': '033 034 048 050 053 065 066 068 072 075 076 080 083 087 090 092 094 100',
    'C11': '059 105',
    'C12': '108 109 116 121 124 130 139 142 148 152 157',
    'C38': '162',
    'C17': '164 174 178 187 190',
    'C19': '165 179 184 193',
    'C20': '197 338 343',
    'C37': '199 200 201 205 215 222 224 226 236 245 251 258 275 284 297 312 316 326 329 333',
    'C40': '335 346 383 385 397 399 406 419 433',
    'C23': '350',
    'C05': '369 477',
    'C07': '371 372',
    'C30': '389',
    'C42': '393',
    'C16': '414 416',
    'C32': '426 431',
    'C44': '435 444',
    'C29': '440 453 458',
    'C35': '450',
    'C28': '462',
    'C34': '468',
}

# Escopo observado por formulário, sem copiar valores, opções ou registros.
# A decisão é proposta documental; não é aprovação comercial/fiscal/de rede.
FORMS = {
    'AV001': ('empresa e parâmetros fiscais', 'Separar identidade empresarial, contatos, marca e emissão; definir campos necessários, documento fiscal e emissor antes de expandir companies.'),
    'AV002': ('RH e dependentes', 'Decidir se haverá RH; usuário operacional não substitui funcionário. Aprovar finalidade, acesso e retenção antes de coletar documentos, remuneração ou dependentes.'),
    'AV003': ('composição de planos', 'Preservar plano versionado; aprovar composição por serviço/empresa, vigência, arredondamento e classificação fiscal com exemplos conciliados.'),
    'AV004': ('serviço comercial e fiscal', 'Distinguir adicional faturável, serviço provisionado e classificação tributária; aprovar unidades e exemplos antes de converter valores.'),
    'AV005': ('categoria de estoque', 'Proposta: categoria por provedor com nome único e referências; aprovar exclusão/inativação e hierarquia antes de implementar.'),
    'AV006': ('fabricante', 'Proposta: catálogo de fabricante por provedor; definir duplicidade, vínculo ao produto e inativação.'),
    'AV007': ('produto de estoque', 'Preservar razão de saldo, SKU, unidade e série; custo, preço, fornecedor e fiscal dependem de regras próprias, não de um movimento genérico.'),
    'AV008': ('relação produto-fornecedor', 'Proposta: associação de produto, fornecedor e código externo; aprovar identidade, duplicidade e recebimento antes de compras.'),
    'AV009': ('kit de instalação', 'Preservar kit transacional existente; especificar permissão de remover/alterar item por OS e tratamento de itens seriados.'),
    'AV010': ('NCM', 'Decidir catálogo e atualização fiscal com responsável; não presumir validade de código pelo HTML.'),
    'AV011': ('veículo', 'Aprovar necessidade de frota e vínculo de veículo à OS; definir placa, disponibilidade e identificação antes de CRUD.'),
    'AV012': ('empresa em popup', 'Mesmo domínio de AV001; não criar segunda entidade por ser popup. Manter vínculos e requisitos fiscais separados.'),
    'AV013': ('depósito e acesso', 'Proposta: local por empresa/provedor e usuários autorizados; aprovar recebimento, transferência e conciliação de saldo por local.'),
    'AV014': ('produto em popup', 'Mesmo domínio de AV007; popup não é novo requisito de negócio. Preservar referências e extensão fiscal/compras pendente.'),
    'AV015': ('transportadora e veículos', 'Aprovar necessidade, identidade e vínculos antes de coletar cadastro fiscal; sem integração automática de transporte.'),
    'AV016': ('uso de veículo e combustível', 'Definir responsáveis, datas/fuso, unidade, quilometragem, custo e correção; não inventar cálculo de reembolso.'),
    'AV017': ('CGNAT', 'Comparar interfaces, redes e faixas com o modelo nativo; aprovar variantes/protocolo e provar ausência de sobreposição em laboratório.'),
    'AV018': ('VLAN/QinQ', 'Proposta: domínio de VLAN com escopo e vínculos; aprovar modos, faixas e colisões antes de persistir ou provisionar.'),
    'AV019': ('template de switch', 'Dispensar execução de comandos/regex arbitrários no painel; transformar capacidades necessárias em operação tipada, assinada e homologada.'),
    'AV020': ('RADIUS e acesso de rede', 'Distinguir servidor RADIUS, NAS e túnel. Portas/timeout/configuração do SGP não equivalem automaticamente ao NAS integrado do Nexo.'),
    'AV021': ('tipo de ONU', 'Definir modelo, portas e argumentos por driver/firmware homologado; não confundir registro de equipamento com template multivendor.'),
    'AV022': ('template de ONU', 'Dispensar comandos livres; mapear intenção para operações de driver homologado com verificação e recuperação.'),
    'AV023': ('fidelidade e descontos', 'Aprovar carência, renovação, multa, desconto e parcelas com exemplos em centavos e vigências; não inferir fórmulas do formulário.'),
    'AV024': ('desconto em combo', 'Aprovar composição por família de produto, vigência, acumulação e arredondamento; preservar contratos antigos.'),
    'AV025': ('variável administrativa', 'Dispensar armazenamento/execução de variável arbitrária; cada necessidade aprovada vira configuração tipada com permissão e auditoria.'),
    'AV026': ('canal SMS', 'Escolher serviço e contrato HTTP; mapear finalidade, escopo POP e padrão de envio com consentimento, erro e deduplicação.'),
    'AV027': ('conector TV', 'Definir fornecedor, credenciais novas, sandbox e estados de ativação/cancelamento; adicional faturável não prova entrega externa.'),
    'AV028': ('assinatura externa', 'Escolher provedor e contrato; definir documento/hash, identidade, assinatura de webhook, repetição e cancelamento. Aceite simples continua distinto.'),
    'AV029': ('bureau de crédito', 'Escolher serviço, finalidade e limites; definir consulta, negativação/baixa e autorização. Restrição interna não equivale ao bureau.'),
    'AV030': ('clube de benefícios', 'Escolher fornecedor e critérios contratuais; homologar ativação/revogação e reconciliação de status.'),
    'AV031': ('sistema de atendimento', 'Definir relação com tickets/catálogos nativos e serviço externo; parâmetros arbitrários não viram integração automática.'),
    'AV032': ('telefonia', 'Escolher fornecedor, contrato, certificados e sandbox; separar cobrança, provisionamento e recuperação.'),
    'AV033': ('blacklist de telefonia', 'Aprovar finalidade, escopo, normalização e remoção; não aplicar bloqueio real a partir do inventário.'),
    'AV034': ('grupo de telefonia', 'Definir identidade, vínculo ao fornecedor e inativação; grupo comercial não prova provisionamento externo.'),
    'AV035': ('multimídia', 'Escolher serviço e contrato de ativação/revogação; não converter parâmetros genéricos em comando de rede.'),
    'AV036': ('mapa externo', 'Escolher serviço e dados autorizados; definir identidade remota, projetos, expiração/renovação de token e reconciliação.'),
    'AV037': ('log de mapa externo', 'Proposta: metadados de tentativa, status e correlação com acesso restrito; mascarar payload e não persistir resposta bruta com segredos.'),
    'AV038': ('canal de aviso', 'Escolher serviço; aprovar configuração tipada, credenciais novas, disponibilidade e desativação com regras dependentes.'),
    'AV039': ('régua de SMS', 'Comparar regra nativa, template, janela e intervalo; aprovar semântica de dias, feriados, destinatários, tags e reenvio.'),
    'AV040': ('régua de e-mail', 'Separar seleção de destinatários e entrega SMTP; aprovar assunto/HTML/PDF, dias, feriados, janelas e limites antes de enviar.'),
    'AV041': ('gerência CPE', 'Escolher gerenciador/modelos e comprovar posse; aprovar ações do portal, escopo POP e ocultação de senha. GenieACS não equivale a todos os conectores.'),
    'AV042': ('dashboard por grupo', 'Proposta: preferências por usuário/provedor; definir precedência, grupos, widgets e layout responsivo antes de ampliar o painel.'),
    'AV043': ('imagem de marca', 'Proposta: assets próprios por provedor, tipos/tamanho/MIME permitidos, acesso e contraste; nunca reutilizar imagens do SGP.'),
    'AV044': ('SMTP', 'Escolher entrega própria ou fornecedor; definir TLS, autenticação/OAuth, timeout, limites, erros e segredos novos. Canal HTTP existente não prova SMTP nativo.'),
}

# Correspondências limitadas, conferidas nos schemas reais. São candidatas:
# não demonstram igualdade das regras de origem nem conversão de tipos.
EXISTING = {}
for form in ('AV001', 'AV012'):
    EXISTING[form] = {'razaosocial': ('companies.name', 'schemas.go'), 'cpfcnpj': ('companies.document', 'schemas.go')}
for form in ('AV007', 'AV014'):
    EXISTING[form] = {name: ('stock_items.'+column, 'estoque.go') for name, column in
                      [('codigo', 'sku'), ('descricao', 'name'), ('unidade', 'unit'), ('estoque_minimo', 'min_qty'), ('ativo', 'active')]}
EXISTING['AV009'] = {'descricao': ('install_kits.name', 'documentos.go')}
for form in ('AV039', 'AV040'):
    EXISTING[form] = {'descricao': ('notice_rules.name', 'avisos.go'), 'mensagem': ('notice_templates.body', 'avisos.go')}


def field_decision(row):
    form, name = row['formulario'], row['nome']
    domain, proposal = FORMS[form]
    base = re.sub(r'-(?:\d+|__prefix__)-', '-[]-', name)
    result = {'nome_normalizado': base, 'dominio_revisado': domain,
              'decisao': 'especificar antes de implementar', 'destino_nexo': 'a especificar; sem correspondência demonstrada', 'evidencia_nexo': '',
              'regra_proposta_ou_questao': proposal+' Campo: '+name+'.',
              'criterio_aceite': 'Definir significado, tipo/unidade, ausência, edição, papel/tenant e efeito; exemplificar válido/inválido sem dados reais.',
              'limite_revisao': 'Revisão documental; required HTML não prova obrigação servidora, valor padrão nem comportamento no SGP.'}
    if name in ('_popup', '_to_field') or re.search(r'-(TOTAL|INITIAL|MIN_NUM|MAX_NUM)_FORMS$', name) or name.startswith('initial-'):
        result.update(decisao='dispensar representação técnica da origem', destino_nexo='não portar controle auxiliar de formulário',
                      regra_proposta_ou_questao='Metadado de popup, contagem de formset ou estado inicial; preservar as entidades/itens em API tipada, sem reproduzir este controle HTML.',
                      criterio_aceite='O novo fluxo preserva vínculo e cardinalidade; o controle técnico da origem não entra como campo de negócio.')
    elif re.match(r'param_(chave|valor)_\d+$', name) or name in ('param_rows_visiveis', 'param_chaves_removidas', 'params_json_manual'):
        result.update(decisao='dispensar editor genérico; especificar configuração tipada', destino_nexo='adaptador escolhido; schema a definir',
                      regra_proposta_ou_questao='A grade chave/valor é representação de edição; documentar cada parâmetro do fornecedor escolhido, sem importar valores ou executar configuração arbitrária.',
                      criterio_aceite='Parâmetros aceitos são tipados e autorizados; segredo mascarado; chave desconhecida recusada.')
    elif re.search(r'senha|password|token|certificado|vpn_pass|config_pass|email_host_user|^usuario$', name):
        result.update(decisao='especificar acesso ou segredo; nunca importar valor', destino_nexo='identidade/segredo do serviço escolhido; sem equivalência automática',
                      regra_proposta_ou_questao=proposal+' Distinguir referência de usuário, credencial e arquivo; usar segredos novos, acesso mínimo, proteção em repouso, rotação e log mascarado.',
                      criterio_aceite='Nenhum valor do acervo reutilizado; papel/tenant e finalidade comprovados; segredo não aparece em consulta/log/exportação.')
    elif form in ('AV019', 'AV022') and re.search(r'cmd|regex|args|configxml', name):
        result.update(decisao='substituir comando/template livre por operação tipada', destino_nexo='catálogo de operações e driver homologado',
                      evidencia_nexo='apps/api-go/internal/network/; services/network-agent/',
                      regra_proposta_ou_questao=proposal,
                      criterio_aceite='Nenhum campo do painel executa shell/regex/comando arbitrário; driver valida argumentos e confirma efeito em laboratório.')
    elif name in EXISTING.get(form, {}):
        target, source = EXISTING[form][name]
        result.update(decisao='preservar capacidade nativa; correspondência parcial', destino_nexo=target,
                      evidencia_nexo='apps/api-go/internal/modules/escrita/'+source,
                      regra_proposta_ou_questao='Candidato estrutural no schema Nexo: '+target+'. '+proposal,
                      criterio_aceite='Aprovar conversão e diferenças de formato/limite; criar/ler/editar/limpar com tenant e papel; não presumir mesmas regras do SGP.')
    elif form == 'AV009' and re.search(r'-(produto|quantidade)$', name):
        result.update(decisao='preservar capacidade nativa; correspondência parcial',
                      destino_nexo='install_kit_items.'+('item_id' if name.endswith('-produto') else 'qty'),
                      evidencia_nexo='apps/api-go/internal/modules/escrita/documentos.go; apps/api-go/internal/modules/escrita/materiais.go',
                      regra_proposta_ou_questao='Preservar vínculo ao item e quantidade inteira positiva; mapear IDs de origem separadamente. '+proposal,
                      criterio_aceite='Kit válido consome todos os itens; saldo insuficiente não consome; identidade e unidade reconciliadas; AUD-05 valida somente regras nativas.')
    elif form in ('AV001', 'AV012', 'AV003', 'AV004', 'AV007', 'AV014', 'AV010') and re.search(r'^nf|fiscal|tribut|cfop|cnae|cclass|ibscbs|ncm|cest|irpj|csll|csc|cidtoken|sit_fiscal', name):
        result.update(decisao='aguardar especificação fiscal', destino_nexo='domínio fiscal/emissor a definir',
                      regra_proposta_ou_questao='Responsável fiscal define documento, código, vigência, unidade, cálculo e emissor. Campo: '+name+'. Não deduzir regra tributária do HTML.',
                      criterio_aceite='Exemplos reconciliados e sandbox autorizado; autorização, rejeição e cancelamento auditados; sem emissão real para testar.')
    elif form == 'AV002':
        result.update(decisao='aguardar decisão de escopo RH', destino_nexo='sem módulo RH equivalente; não usar users/subscribers como substituto')
    elif form in ('AV011', 'AV016'):
        result.update(decisao='aguardar decisão de escopo frota', destino_nexo='sem domínio de frota aprovado')
    elif form in ('AV005', 'AV006', 'AV008', 'AV013', 'AV015'):
        result.update(decisao='especificar catálogo/compras e vínculos', destino_nexo='domínio de compras/depósitos ainda ausente')
    elif form in ('AV023', 'AV024'):
        result.update(decisao='aguardar regra comercial aprovada', destino_nexo='condições contratuais nativas; equivalência não comprovada')
    elif form in ('AV027', 'AV028', 'AV029', 'AV030', 'AV032', 'AV033', 'AV034', 'AV035', 'AV036', 'AV037', 'AV038', 'AV041', 'AV044'):
        result.update(decisao='aguardar fornecedor/contrato ou especificação do conector', destino_nexo='conector específico não comprovado; manter distinção da capacidade nativa')
    return result


def main():
    target = OUT/'evidencias_sanitizadas.json'
    if target.exists():
        raise SystemExit('Consolidação já executada; use auditoria-sgp.py para validar. Não sobrescrever proveniência.')
    surfaces = read('matriz_superficies.csv')
    fields = read('campos_44_formularios.csv')
    caps = read('matriz_capacidades.csv')
    by_cap = {c['id']: c for c in caps}
    reviewed = []
    assignments = {'M'+number: cap for cap, numbers in MENUS.items() for number in numbers.split()}
    missing = {r['id_origem'] for r in surfaces if r['capacidade_nexo'] == 'SEM_MAPEAMENTO'}
    assert len(assignments) == len(missing) == 101 and set(assignments) == missing
    evidence = {}
    for row in surfaces:
        identifier = row['id_origem']
        evidence[identifier] = {'id': identifier, 'tipo': row['tipo'], 'descricao': row['descricao_origem'],
                                'rota_observada': row['rota_sgp'], 'confianca': row['confianca_sgp'],
                                'referencias_historicas_no_backup': row['evidencia_sgp'],
                                'limite': 'Estrutura observada; não contém backend, registros ou valores. Referências históricas pertencem ao arquivo externo, não são dependências locais.'}
        row['evidencia_sgp'] = 'evidencias_sanitizadas.json#'+identifier
        if identifier in assignments:
            cap = assignments[identifier]
            row['capacidade_nexo'] = cap
            row['situacao_nexo'] = 'agrupador de navegação revisado; não é fluxo homologado'
            row['limite'] = 'Título sem rota; associação temática revisada, sem presumir operação ou paridade.'
            row['frontend'], row['backend'], row['persistencia'] = '', '', ''
            row['diferencas_dependencias'] = 'Não existe endpoint observado neste item; capacidades do tema estão em '+cap+'.'
            row['melhoria_proposta'] = 'Dispensar reprodução literal da hierarquia; preservar fluxos necessários do domínio.'
            row['criterios_aceite'] = 'Necessidade do domínio especificada e rastreável; nenhuma conclusão funcional derivada deste título.'
            row['validacao'] = 'Revisão individual do título/hierarquia e associação; nenhuma execução de negócio.'
            note = 'Agrupador temático; não constitui operação adicional.'
            if identifier in ('M393', 'M397', 'M385', 'M383', 'M419', 'M433'):
                note = 'Escopo específico continua desconhecido. Associação é apenas temática; obter contrato/uso antes de implementar.'
            reviewed.append({'id': identifier, 'hierarquia': row['descricao_origem'], 'capacidade_tematica': cap,
                             'decisao': 'dispensar cópia do agrupador; manter avaliação do domínio', 'limite_e_pendencia': note})
    for row in fields:
        row['evidencia'] = 'evidencias_sanitizadas.json#'+row['formulario']
        row.update(field_decision(row))
        row['situacao'] = 'revisado documentalmente; implementação/regra conforme decisão'
        row['diferenca'] = row['regra_proposta_ou_questao']
    for cap in caps:
        ids = [r['id_origem'] for r in surfaces if r['capacidade_nexo'] == cap['id']]
        cap['evidencias_sgp'] = '; '.join(ids)
    forms = [{'id': form, 'dominio': domain, 'especificacao_proposta': proposal,
              'quantidade_controles': sum(r['formulario'] == form for r in fields),
              'campos': [r['id'] for r in fields if r['formulario'] == form],
              'evidencia': 'evidencias_sanitizadas.json#'+form,
              'limite': 'HTTP e estrutura, sem POST de negócio nem validação visual/interativa.'}
             for form, (domain, proposal) in FORMS.items()]
    save('evidencias_sanitizadas.json', evidence)
    save('formularios_revisados.json', forms)
    write('revisao_101_menus.csv', reviewed)
    write('campos_44_formularios.csv', fields)
    write('matriz_superficies.csv', surfaces)
    write('matriz_capacidades.csv', caps)
    save('resumo_revisao_campos.json', {'total': len(fields), 'formularios': len(forms),
         'por_decisao': dict(Counter(r['decisao'] for r in fields)),
         'limite': 'Revisão de destinação dos controles concluída; decisões comerciais/fiscais/externas continuam propostas, não aprovadas.'})
    print(f'{len(reviewed)} menus e {len(fields)} controles revisados; evidências sanitizadas independentes das fontes.')


if __name__ == '__main__':
    main()
