#!/usr/bin/env python3
"""Compare authorized, normalized exports before cutover; never imports data."""
import argparse
import csv
import json
from pathlib import Path

FIELDS={'source','entity','external_id','parent_external_id','amount_cents','status'}

def load(path):
    records={}
    with path.open(newline='',encoding='utf-8-sig') as file:
        reader=csv.DictReader(file)
        if not FIELDS.issubset(reader.fieldnames or []):
            raise ValueError('exportação normalizada exige: '+', '.join(sorted(FIELDS)))
        for row in reader:
            if any(row.get(field) is None for field in FIELDS): raise ValueError('linha CSV incompleta')
            key=tuple(row[name].strip() for name in ('source','entity','external_id'))
            if not all(key): raise ValueError('identidade ausente na exportação')
            if key in records: raise ValueError('identidade duplicada na exportação')
            amount=row['amount_cents'].strip()
            try: cents=int(amount) if amount else None
            except ValueError: raise ValueError('valor deve conter centavos inteiros')
            records[key]=(row['parent_external_id'].strip(),cents,row['status'].strip())
    return records

def compare(source,target):
    missing=source.keys()-target.keys();extra=target.keys()-source.keys()
    changed={key for key in source.keys()&target.keys() if source[key]!=target[key]}
    def summary(rows):
        result={}
        for (_,entity,_),(_,amount,_) in rows.items():
            entry=result.setdefault(entity,{'count':0,'amount_cents':0})
            entry['count']+=1;entry['amount_cents']+=amount or 0
        return result
    return {'ok':not (missing or extra or changed),'source':summary(source),'target':summary(target),
            'missing':len(missing),'extra':len(extra),'changed':len(changed)}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--target',type=Path,required=True)
    args=parser.parse_args()
    try: result=compare(load(args.source),load(args.target))
    except (ValueError,OSError) as error: parser.error(str(error))
    print(json.dumps(result,ensure_ascii=False,sort_keys=True))
    return 0 if result['ok'] else 1

if __name__=='__main__':
    raise SystemExit(main())
