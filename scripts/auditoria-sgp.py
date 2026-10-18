#!/usr/bin/env python3
"""Valida o dossiê sanitizado sem os espelhos SGP; backup é opcional."""
import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'docs/SGP_COMPARATIVO_NEXOISP'


def load(name):
    return json.loads((OUT/name).read_text())


def rows(name):
    with (OUT/name).open(newline='') as f:
        return list(csv.DictReader(f))


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()


def validate():
    surfaces, fields, menus = rows('matriz_superficies.csv'), rows('campos_44_formularios.csv'), rows('revisao_101_menus.csv')
    caps, evidence, forms = rows('matriz_capacidades.csv'), load('evidencias_sanitizadas.json'), load('formularios_revisados.json')
    cap_ids = {c['id'] for c in caps}
    ids = {s['id_origem'] for s in surfaces}
    require(len(caps) == len(cap_ids) == 45, 'Capacidades incompletas/duplicadas')
    require(len(surfaces) == len(ids) == len(evidence) == 1246 and ids == set(evidence), 'Superfícies/evidências incompletas')
    require(len(fields) == len({f['id'] for f in fields}) == 956, 'Campos incompletos/duplicados')
    require(len(forms) == len({f['id'] for f in forms}) == 44, 'Formulários incompletos/duplicados')
    require(len(menus) == len({m['id'] for m in menus}) == 101, 'Revisão de menus incompleta')
    surface_by_id = {s['id_origem']: s for s in surfaces}
    for menu in menus:
        s = surface_by_id[menu['id']]
        require(s['tipo'] == 'menu' and not s['rota_sgp'], 'Título de navegação ganhou operação presumida')
        require(menu['hierarquia'] == s['descricao_origem'] and menu['capacidade_tematica'] == s['capacidade_nexo'], 'Revisão de menu divergente')
        require(bool(menu['decisao'] and menu['limite_e_pendencia']), 'Menu sem decisão/limite')
    for form in forms:
        items = [f for f in fields if f['formulario'] == form['id']]
        require(len(items) == form['quantidade_controles'] and [f['id'] for f in items] == form['campos'], 'Cardinalidade divergente em '+form['id'])
    for field in fields:
        require(field['capacidade_nexo'] in cap_ids, 'Campo sem capacidade')
        for key in ('nome_normalizado', 'dominio_revisado', 'decisao', 'destino_nexo', 'regra_proposta_ou_questao', 'criterio_aceite', 'limite_revisao'):
            require(bool(field[key]), 'Campo sem '+key+': '+field['id'])
        for source in field['evidencia_nexo'].split('; '):
            if source:
                require((ROOT/source).exists(), 'Código Nexo ausente: '+source)
    for surface in surfaces:
        require(surface['capacidade_nexo'] in cap_ids, 'Superfície sem associação revisada')
    for row, column in [(s, 'evidencia_sgp') for s in surfaces]+[(f, 'evidencia') for f in fields]:
        filename, identifier = row[column].split('#', 1)
        require(filename == 'evidencias_sanitizadas.json' and identifier in evidence, 'Referência sanitizada inválida')
    for cap in caps:
        require(all(identifier in ids for identifier in cap['evidencias_sgp'].split('; ') if identifier), 'Referência de capacidade inválida')
    for p in OUT.glob('*.md'):
        for target in re.findall(r'\]\(([^)]+)\)', p.read_text()):
            if not target.startswith(('https:', 'http:', '#')):
                require((p.parent/target.split('#')[0]).exists(), f'Link local quebrado em {p.name}: {target}')
    require(load('resumo_revisao_campos.json')['por_decisao'] == dict(Counter(f['decisao'] for f in fields)), 'Resumo de campos divergente')
    require(len(load('fontes_sha256.json')) == 1207, 'Inventário histórico incompleto')
    return {'capacidades': len(caps), 'superficies': len(surfaces), 'menus_revisados': len(menus), 'formularios': len(forms), 'controles_revisados': len(fields)}


def check_backup(path):
    metadata = load('retirada_fontes.json')
    require(path.is_file() and sha(path) == metadata['backup_sha256'], 'Backup ausente ou SHA-256 divergente')
    require(path.stat().st_mode & 0o077 == 0, 'Backup com permissão de grupo/outros; use chmod 600')
    expected, found = load('fontes_sha256.json'), {}
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            require(not member.issym() and not member.islnk(), 'Link inesperado no backup')
            require(member.isdir() or member.isfile(), 'Tipo inesperado no backup')
            if not member.isfile():
                continue
            require(member.name.startswith('SGP/'), 'Membro fora de SGP/')
            relative = member.name[len('SGP/'):]
            require(relative in expected and relative not in found, 'Membro inesperado/duplicado')
            h = hashlib.sha256()
            with archive.extractfile(member) as stream:
                for block in iter(lambda: stream.read(1024*1024), b''):
                    h.update(block)
            found[relative] = h.hexdigest()
    require(found == expected, 'Conteúdo do backup difere do inventário inicial')
    print('Backup privado validado: 1207 arquivos íntegros; nada extraído.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='validar dossiê/manifesto, sem fontes ou backup')
    parser.add_argument('--atualizar-manifesto', action='store_true', help='registrar edição documental revisada')
    parser.add_argument('--check-backup', type=Path, metavar='ARQUIVO', help='conferir opcionalmente arquivo privado externo')
    args = parser.parse_args()
    result = validate()
    files = {p.name: sha(p) for p in sorted(OUT.iterdir()) if p.is_file() and p.name != 'manifesto_consolidado.json'}
    if args.atualizar_manifesto:
        (OUT/'manifesto_consolidado.json').write_text(json.dumps({'arquivos': files, 'revisao': result,
             'limite': 'Integridade documental; não comprova homologação funcional ou regras desconhecidas.'}, ensure_ascii=False, indent=2)+'\n')
    else:
        require(load('manifesto_consolidado.json')['arquivos'] == files, 'Dossiê alterado: revisar e usar --atualizar-manifesto')
    if args.check_backup:
        check_backup(args.check_backup)
    print(json.dumps({'ok': True, 'independente_das_fontes': True, **result}, ensure_ascii=False))


if __name__ == '__main__':
    main()
