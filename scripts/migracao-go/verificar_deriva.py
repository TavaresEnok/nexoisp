#!/usr/bin/env python3
"""Fingerprints incluem SQL compartilhado, validadores, permissões, CSV e escopo."""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
FILES=['legacy/fastify/src/routes/cadastro.ts','legacy/fastify/src/validators.ts','legacy/fastify/src/auth.ts','legacy/fastify/src/db.ts','legacy/fastify/src/csv.ts','legacy/fastify/src/app.ts']


def shared(path, source):
    if path.endswith('/auth.ts'):
        # Hooks opt-in do piloto já existiam na árvore inicial, mas não são contrato do produto.
        source=source[source.index('export type Role'):]
        source=re.sub(r'\nasync function loadCtxOptimized\b.*?(?=/\*\* MFA obrigatório)', '\n', source, flags=re.S)
        source=re.sub(r'  // Só o laboratório ativa este caminho\..*?  if \(process.env.NEXO_BENCH_AUTH_MODE[^\n]+\n', '', source, flags=re.S)
    elif path.endswith('/db.ts'):
        parsers='\n'.join(re.findall(r'^pg.types.setTypeParser[^\n]+',source,re.M))
        pool=re.search(r'new pg.Pool\(\{([^}]+)\}\)',source).group(1)
        source=parsers+'\n'+pool+'\n'+source[source.index('export interface DbScope'):]
    return source


def fingerprints():
    cadastro=(ROOT/FILES[0]).read_text()
    contract=re.search(r'export const CONTRACT_SELECT = `([^`]+)`',cadastro).group(1)
    listing=re.search(r'`(select s\.\*, \(select count\(\*\).*?order by s.name, s.id)`',cadastro,re.S).group(1)
    history=re.search(r'`(select h.at, h.event, h.detail, u.name as actor_name[^`]+)`',cadastro).group(1)
    queries={'subscriber':'select * from subscribers where id = $1','subscriber_contracts':contract+' where c.subscriber_id = $1 order by c.created_at desc','contract':contract+' where c.id = $1','history':history,'list':listing}
    hashes={k:hashlib.sha256(v.encode()).hexdigest() for k,v in queries.items()}
    for name,sql in queries.items():
        source=(ROOT/f'apps/api-go/internal/modules/cadastro/queries/{name}.sql').read_text().split('\n',1)[1]
        assert source==sql+';\n', 'SQL divergente: '+name
    validators=(ROOT/'legacy/fastify/src/validators.ts').read_text()
    schemas={'uuid':re.search(r'export const zUuid = (.*?);',validators).group(1),
             'page':re.search(r'export const zPage = (.*?);',validators).group(1),
             'list':re.search(r"app.get\('/api/subscribers'.*?const q = (.*?)\.parse\(req.query\)",cadastro,re.S).group(1)}
    return hashes,{k:hashlib.sha256(v.encode()).hexdigest() for k,v in schemas.items()}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--gravar',action='store_true');args=parser.parse_args()
    hashes,schemas=fingerprints()
    definitions=[('get_api_subscribers_id',['subscriber','subscriber_contracts'],['uuid']),('get_api_contracts_id',['contract','history'],['uuid']),('get_api_subscribers',['list'],['list','page'])]
    for name,query_names,schema_names in definitions:
        path=ROOT/f'tests/contrato/rotas/{name}.yaml'
        specification=json.loads(path.read_text())
        expected={'sql':{k:hashes[k] for k in query_names},'zod':{k:schemas[k] for k in schema_names}}
        if args.gravar:
            specification['hashes']=expected;path.write_text(json.dumps(specification,ensure_ascii=False,indent=2)+'\n')
        assert specification['hashes']==expected, 'deriva na especificação: '+name
    path=ROOT/'tests/contrato/rotas/compartilhados.sha256.json'
    actual={p:hashlib.sha256(shared(p,(ROOT/p).read_text()).encode()).hexdigest() for p in FILES[1:]}
    if args.gravar:path.write_text(json.dumps(actual,indent=2)+'\n')
    assert json.loads(path.read_text())==actual, 'controle compartilhado mudou: revisar Go e corpus'
    print('SQL, Zod e controles compartilhados: sem deriva')


if __name__=='__main__':main()
