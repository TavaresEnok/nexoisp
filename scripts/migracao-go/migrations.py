#!/usr/bin/env python3
"""Copiar/verificar o SQL legado sem normalizar nenhum byte."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ORIGINS = ROOT / 'apps/api/migrations'
DEST = ROOT / 'db/migrations'
PREFIX = b'-- +goose Up\n-- +goose StatementBegin\n'
SUFFIX = b'-- +goose StatementEnd\n'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--gerar', action='store_true')
    args = parser.parse_args()
    originals = sorted(ORIGINS.glob('*.sql'))
    assert len(originals) == 53, 'mudou o conjunto legado de 53 migrations'
    manifest = {}
    for i, original in enumerate(originals, 1):
        assert int(original.name.split('_')[0]) == i
        data = original.read_bytes()
        assert data.endswith(b'\n'), original
        target = DEST / f'{i:05d}_{original.name.split("_", 1)[1]}'
        expected = PREFIX + data + SUFFIX
        if args.gerar:
            target.write_bytes(expected)
        assert target.read_bytes() == expected, f'deriva SQL: {original.name}'
        manifest[original.name] = hashlib.sha256(data).hexdigest()
    path = DEST.parent / 'legado.sha256.json'
    if args.gerar:
        path.write_text(json.dumps(manifest, indent=2) + '\n')
    assert json.loads(path.read_text()) == manifest, 'legado alterado após adoção'
    print('53 migrations: SQL e hashes idênticos')


if __name__ == '__main__':
    main()
