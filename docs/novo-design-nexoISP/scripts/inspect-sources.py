import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

parser = argparse.ArgumentParser(description="Inventaria as nove origens sem executar código dos projetos.")
parser.add_argument("archive", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
expected = ["8001", "8002", "8004", "8006", "8008", "8015", "8021", "8022", "8026"]
projects = []
with ZipFile(args.archive) as archive:
    files = {item.filename: archive.read(item) for item in archive.infolist() if not item.is_dir()}
    for code in expected:
        prefix = f"nexoisp{code}/"
        entries = sorted((name[len(prefix):], content) for name, content in files.items() if name.startswith(prefix))
        if not any(name == "package.json" for name, _ in entries):
            raise ValueError(f"Projeto nexoisp{code} ausente ou inválido.")
        tree = "\n".join(f"{name}:{hashlib.sha256(content).hexdigest()}" for name, content in entries)
        evidence = [{"path": name, "sha256": hashlib.sha256(content).hexdigest()} for name, content in entries if PurePosixPath(name).parts[0] in {"app", "lib", "components"} and "/ui/" not in name]
        projects.append({"id": code, "name": f"nexoisp{code}", "fileCount": len(entries), "treeSha256": hashlib.sha256(tree.encode()).hexdigest(), "evidence": evidence})
    additional = [{"path": name, "sha256": hashlib.sha256(content).hexdigest()} for name, content in sorted(files.items()) if not any(name.startswith(f"nexoisp{code}/") for code in expected)]
    result = {"archiveSha256": hashlib.sha256(args.archive.read_bytes()).hexdigest(), "totalFiles": len(files), "additionalFiles": additional, "method": "Inspeção estática dos arquivos. Hash de árvore: SHA-256 das linhas caminho:sha256, ordenadas e separadas por LF. Não comprova equivalência funcional ou visual.", "projects": projects}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(f"{len(projects)} projetos e {result['totalFiles']} arquivos inventariados.")
