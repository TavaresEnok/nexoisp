#!/usr/bin/env python3
"""Validate exactly the dump and its snapshot manifest before restoration."""
import hashlib
from pathlib import Path
import re
import sys


def verify(path):
    dump = Path(path)
    expected = {dump.name: dump, dump.name + '.manifest.json': Path(str(dump) + '.manifest.json')}
    entries = {}
    for line in Path(str(dump) + '.sha256').read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64}) [ *](.+)', line)
        if not match or match[2] not in expected or match[2] in entries:
            raise ValueError('checksum deve conter apenas dump e manifesto, sem duplicatas')
        entries[match[2]] = match[1]
    if set(entries) != set(expected):
        raise ValueError('checksum precisa autenticar dump e manifesto')
    for name, file in expected.items():
        digest = hashlib.sha256()
        with file.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != entries[name]:
            raise ValueError('soma inválida do dump ou manifesto')


if __name__ == '__main__':
    try:
        verify(sys.argv[1])
    except (OSError, ValueError, IndexError) as exc:
        sys.exit('ERRO: backup recusado: ' + str(exc))
