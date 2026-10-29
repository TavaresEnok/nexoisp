#!/usr/bin/env python3
"""Validação estrutural de SBOM CycloneDX. Não gera SBOM e não acessa a rede."""
import argparse
import base64
import hashlib
import json
import re
import sys
from pathlib import Path

COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
RUN_RE = re.compile(r"[A-Za-z0-9._:-]+")
NODE_RE = re.compile(r"v?\d+\.\d+\.\d+")
NPM_RE = re.compile(r"\d+\.\d+\.\d+")
SPEC_RE = re.compile(r"1\.\d+")
DEMO_RUNS = {"demo", "example", "placeholder", "unknown", "none", "null", "fake", "sample"}
ECOSYSTEMS = {"go": "pkg:golang/", "npm": "pkg:npm/"}
TOOLS = {"go": "cyclonedx-gomod", "npm": "@cyclonedx/cyclonedx-npm"}
PROPERTIES = (
    "nexoisp:ecosystem",
    "nexoisp:git.commit",
    "nexoisp:ci.run",
    "nexoisp:toolchain.go",
    "nexoisp:toolchain.node",
    "nexoisp:toolchain.npm",
    "nexoisp:tool.name",
    "nexoisp:tool.version",
    "nexoisp:scope",
)

class SbomError(ValueError):
    pass

def load(path):
    path = Path(path)
    if not path.is_file():
        raise SbomError(f"SBOM ausente: {path}")
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except OSError as error:
        raise SbomError(f"SBOM ilegível: {path}: {error}") from error
    if not raw.strip():
        raise SbomError(f"SBOM vazio: {path}")
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise SbomError(f"SBOM com JSON inválido: {path}: {error.msg}") from error
    if not isinstance(document, dict):
        raise SbomError(f"SBOM inválido: a raiz não é um objeto ({path})")
    return document

def walk(components):
    if not isinstance(components, list):
        raise SbomError("lista de componentes inválida")
    for component in components:
        if not isinstance(component, dict):
            raise SbomError("componente inválido")
        yield component
        nested = component.get("components")
        if nested is not None:
            yield from walk(nested)

def property_map(document):
    metadata = document.get("metadata")
    if not isinstance(metadata, dict):
        raise SbomError("SBOM sem metadata")
    props = metadata.get("properties")
    if not isinstance(props, list) or not props:
        raise SbomError("SBOM sem propriedades de proveniência")
    found = {}
    for item in props:
        if not isinstance(item, dict):
            raise SbomError("propriedade de proveniência inválida")
        name, value = item.get("name"), item.get("value")
        if not isinstance(name, str) or not isinstance(value, str):
            raise SbomError("propriedade de proveniência inválida")
        found[name] = value
    return found

def validate(path, ecosystem, expect_commit=None):
    if ecosystem not in ECOSYSTEMS:
        raise SbomError(f"ecossistema desconhecido: {ecosystem}")
    document = load(path)
    if document.get("bomFormat") != "CycloneDX":
        raise SbomError("SBOM inválido: bomFormat deve ser CycloneDX")
    spec = document.get("specVersion")
    if not isinstance(spec, str) or not SPEC_RE.fullmatch(spec):
        raise SbomError("SBOM inválido: specVersion ausente")
    if document.get("components") is None:
        raise SbomError("SBOM sem lista de componentes")
    components = list(walk(document["components"]))
    if not components:
        raise SbomError("SBOM sem componentes")
    for component in components:
        name = component.get("name")
        if not isinstance(name, str) or not name.strip():
            raise SbomError("componente sem nome")
    prefix = ECOSYSTEMS[ecosystem]
    if not any(isinstance(item.get("purl"), str) and item["purl"].startswith(prefix) for item in components):
        raise SbomError(f"SBOM sem componentes {ecosystem} ({prefix})")
    props = property_map(document)
    missing = [key for key in PROPERTIES if not props.get(key, "").strip()]
    if missing:
        raise SbomError("proveniência incompleta: " + ", ".join(missing))
    if props["nexoisp:ecosystem"] != ecosystem:
        raise SbomError("proveniência de ecossistema divergente")
    commit = props["nexoisp:git.commit"]
    if not COMMIT_RE.fullmatch(commit):
        raise SbomError("proveniência sem commit completo")
    if expect_commit is not None and commit != expect_commit:
        raise SbomError("proveniência não corresponde ao commit esperado")
    run = props["nexoisp:ci.run"]
    if not RUN_RE.fullmatch(run) or run.lower() in DEMO_RUNS:
        raise SbomError("proveniência sem identificação de run")
    if "go" not in props["nexoisp:toolchain.go"]:
        raise SbomError("proveniência sem toolchain Go")
    if not NODE_RE.search(props["nexoisp:toolchain.node"]):
        raise SbomError("proveniência sem toolchain Node")
    if not NPM_RE.fullmatch(props["nexoisp:toolchain.npm"].strip()):
        raise SbomError("proveniência sem toolchain npm")
    if props["nexoisp:tool.name"] != TOOLS[ecosystem]:
        raise SbomError("proveniência com ferramenta divergente")
    if not NPM_RE.fullmatch(props["nexoisp:tool.version"].strip()):
        raise SbomError("proveniência sem versão da ferramenta")
    if "não comprova" not in props["nexoisp:scope"]:
        raise SbomError("escopo sem limite explícito")
    return {
        "ecosystem": ecosystem,
        "commit": commit,
        "run": run,
        "components": len(components),
        "tool": props["nexoisp:tool.name"] + "@" + props["nexoisp:tool.version"],
    }

def apply_provenance(path, ecosystem, commit, run, toolchain_go, toolchain_node, toolchain_npm, tool_name, tool_version, scope):
    path = Path(path)
    document = load(path)
    metadata = document.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        document["metadata"] = metadata
    current = metadata.get("properties")
    if current is None:
        current = []
    if not isinstance(current, list):
        raise SbomError("propriedades existentes inválidas")
    values = {
        "nexoisp:ecosystem": ecosystem,
        "nexoisp:git.commit": commit,
        "nexoisp:ci.run": run,
        "nexoisp:toolchain.go": toolchain_go,
        "nexoisp:toolchain.node": toolchain_node,
        "nexoisp:toolchain.npm": toolchain_npm,
        "nexoisp:tool.name": tool_name,
        "nexoisp:tool.version": tool_version,
        "nexoisp:scope": scope,
    }
    kept = [item for item in current if not (isinstance(item, dict) and str(item.get("name", "")).startswith("nexoisp:"))]
    metadata["properties"] = kept + [{"name": name, "value": values[name]} for name in PROPERTIES]
    component = metadata.get("component")
    if isinstance(component, dict) and not str(component.get("version") or "").strip():
        component["version"] = commit
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def verify_integrity(path, expected):
    path = Path(path)
    if not path.is_file():
        raise SbomError(f"arquivo ausente para integridade: {path}")
    data = path.read_bytes()
    if expected.startswith("sha256-"):
        digest = expected[len("sha256-"):].lower()
        if hashlib.sha256(data).hexdigest() != digest:
            raise SbomError("integridade sha256 não confere")
        return
    if expected.startswith("sha512-"):
        digest = expected[len("sha512-"):]
        if base64.b64encode(hashlib.sha512(data).digest()).decode() != digest:
            raise SbomError("integridade sha512 não confere")
        return
    raise SbomError("algoritmo de integridade não suportado")

def main(argv=None):
    parser = argparse.ArgumentParser(description="Valida a estrutura e a proveniência de um SBOM CycloneDX")
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check")
    check.add_argument("--file", type=Path, required=True)
    check.add_argument("--ecosystem", choices=sorted(ECOSYSTEMS), required=True)
    check.add_argument("--expect-commit")
    apply = commands.add_parser("apply")
    apply.add_argument("--file", type=Path, required=True)
    apply.add_argument("--ecosystem", choices=sorted(ECOSYSTEMS), required=True)
    apply.add_argument("--commit", required=True)
    apply.add_argument("--run", required=True)
    apply.add_argument("--toolchain-go", required=True)
    apply.add_argument("--toolchain-node", required=True)
    apply.add_argument("--toolchain-npm", required=True)
    apply.add_argument("--tool-name", required=True)
    apply.add_argument("--tool-version", required=True)
    apply.add_argument("--scope", required=True)
    integrity = commands.add_parser("integrity")
    integrity.add_argument("--file", type=Path, required=True)
    integrity.add_argument("--expected", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            print(json.dumps(validate(args.file, args.ecosystem, args.expect_commit), ensure_ascii=False, sort_keys=True))
        elif args.command == "apply":
            apply_provenance(args.file, args.ecosystem, args.commit, args.run, args.toolchain_go, args.toolchain_node, args.toolchain_npm, args.tool_name, args.tool_version, args.scope)
        else:
            verify_integrity(args.file, args.expected)
    except SbomError as error:
        print(f"ERRO: {error}", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
