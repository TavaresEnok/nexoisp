import importlib.util
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def module():
    spec = importlib.util.spec_from_file_location("sbom_validate", ROOT / "scripts" / "validate-sbom.py")
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

sbom = module()
COMMIT = "0123456789abcdef0123456789abcdef01234567"

def provenance(ecosystem):
    tool = sbom.TOOLS[ecosystem]
    version = "1.12.0" if ecosystem == "go" else "6.0.1"
    return {
        "nexoisp:ecosystem": ecosystem,
        "nexoisp:git.commit": COMMIT,
        "nexoisp:ci.run": "local",
        "nexoisp:toolchain.go": "go version go1.27.3 linux/amd64",
        "nexoisp:toolchain.node": "v22.23.4",
        "nexoisp:toolchain.npm": "10.9.9",
        "nexoisp:tool.name": tool,
        "nexoisp:tool.version": version,
        "nexoisp:scope": "Escopo de fonte. Este SBOM não comprova imagem publicada, homologação ou deploy.",
    }

def document(ecosystem, components, props=None):
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "metadata": {
            "component": {"type": "application", "name": "nexoisp"},
            "properties": [{"name": key, "value": value} for key, value in (props or provenance(ecosystem)).items()],
        },
        "components": components,
    }

def go_component():
    return {"type": "library", "name": "github.com/google/uuid", "version": "v1.6.0", "purl": "pkg:golang/github.com/google/uuid@v1.6.0"}

def npm_component():
    return {"type": "library", "name": "react", "version": "19.2.4", "purl": "pkg:npm/react@19.2.4"}

class SbomTests(unittest.TestCase):
    def write(self, directory, payload):
        path = Path(directory) / "bom.json"
        if isinstance(payload, str):
            path.write_text(payload, encoding="utf-8")
        else:
            path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_missing_empty_and_invalid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "ausente.json"
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.validate(missing, "go")
            self.assertIn("ausente", str(caught.exception))
            empty = self.write(directory, "   \n")
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.validate(empty, "go")
            self.assertIn("vazio", str(caught.exception))
            broken = self.write(directory, "{")
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.validate(broken, "npm")
            self.assertIn("JSON inválido", str(caught.exception))
            root = self.write(directory, [])
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.validate(root, "go")
            self.assertIn("raiz", str(caught.exception))

    def test_empty_component_list_fails_both_ecosystems(self):
        with tempfile.TemporaryDirectory() as directory:
            for ecosystem in ("go", "npm"):
                path = self.write(directory, document(ecosystem, []))
                with self.assertRaises(sbom.SbomError) as caught:
                    sbom.validate(path, ecosystem)
                self.assertIn("sem componentes", str(caught.exception))
                nameless = document(ecosystem, [{"type": "library", "purl": sbom.ECOSYSTEMS[ecosystem] + "x@1.0.0"}])
                path = self.write(directory, nameless)
                with self.assertRaises(sbom.SbomError) as caught:
                    sbom.validate(path, ecosystem)
                self.assertIn("sem nome", str(caught.exception))

    def test_real_go_and_npm_shapes(self):
        with tempfile.TemporaryDirectory() as directory:
            go_path = self.write(directory, document("go", [go_component()]))
            go_result = sbom.validate(go_path, "go", COMMIT)
            self.assertEqual(go_result["components"], 1)
            self.assertEqual(go_result["tool"], "cyclonedx-gomod@1.12.0")
            nested = document("npm", [{
                "type": "application",
                "name": "@nexo/web",
                "components": [npm_component()],
            }])
            npm_path = self.write(directory, nested)
            npm_result = sbom.validate(npm_path, "npm", COMMIT)
            self.assertEqual(npm_result["components"], 2)
            self.assertEqual(npm_result["tool"], "@cyclonedx/cyclonedx-npm@6.0.1")
            swapped = self.write(directory, document("go", [npm_component()]))
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.validate(swapped, "go")
            self.assertIn("pkg:golang/", str(caught.exception))
            swapped = self.write(directory, document("npm", [go_component()]))
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.validate(swapped, "npm")
            self.assertIn("pkg:npm/", str(caught.exception))

    def test_provenance_commit_run_and_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            props = provenance("go")
            del props["nexoisp:git.commit"]
            path = self.write(directory, document("go", [go_component()], props))
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.validate(path, "go")
            self.assertIn("proveniência incompleta", str(caught.exception))
            props = provenance("go")
            props["nexoisp:git.commit"] = "abc"
            path = self.write(directory, document("go", [go_component()], props))
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.validate(path, "go")
            self.assertIn("commit completo", str(caught.exception))
            path = self.write(directory, document("npm", [npm_component()]))
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.validate(path, "npm", "f" * 40)
            self.assertIn("commit esperado", str(caught.exception))
            for run in ("demo", "placeholder", "run com espaço"):
                props = provenance("npm")
                props["nexoisp:ci.run"] = run
                path = self.write(directory, document("npm", [npm_component()], props))
                with self.assertRaises(sbom.SbomError):
                    sbom.validate(path, "npm")
            props = provenance("go")
            props["nexoisp:scope"] = "só a lista de módulos"
            path = self.write(directory, document("go", [go_component()], props))
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.validate(path, "go")
            self.assertIn("limite", str(caught.exception))
            props = provenance("go")
            props["nexoisp:tool.name"] = "@cyclonedx/cyclonedx-npm"
            path = self.write(directory, document("go", [go_component()], props))
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.validate(path, "go")
            self.assertIn("ferramenta", str(caught.exception))

    def test_apply_then_check_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            original = {
                "bomFormat": "CycloneDX",
                "specVersion": "1.6",
                "metadata": {
                    "component": {"type": "application", "name": "nexoisp"},
                    "properties": [{"name": "cdx:npm:keep", "value": "1"}, {"name": "nexoisp:git.commit", "value": "antigo"}],
                },
                "components": [npm_component()],
            }
            path = self.write(directory, original)
            values = provenance("npm")
            sbom.apply_provenance(
                path, "npm", values["nexoisp:git.commit"], "4242.attempt2",
                values["nexoisp:toolchain.go"], values["nexoisp:toolchain.node"], values["nexoisp:toolchain.npm"],
                values["nexoisp:tool.name"], values["nexoisp:tool.version"], values["nexoisp:scope"],
            )
            stamped = json.loads(path.read_text(encoding="utf-8"))
            names = [item["name"] for item in stamped["metadata"]["properties"]]
            self.assertIn("cdx:npm:keep", names)
            self.assertEqual(names.count("nexoisp:git.commit"), 1)
            result = sbom.validate(path, "npm", COMMIT)
            self.assertEqual(result["run"], "4242.attempt2")
            self.assertEqual(stamped["components"][0]["purl"], npm_component()["purl"])
            self.assertEqual(stamped["metadata"]["component"]["version"], COMMIT)
            stamped["metadata"]["component"]["version"] = "0.1.0"
            path.write_text(json.dumps(stamped), encoding="utf-8")
            sbom.apply_provenance(
                path, "npm", values["nexoisp:git.commit"], "4242.attempt2",
                values["nexoisp:toolchain.go"], values["nexoisp:toolchain.node"], values["nexoisp:toolchain.npm"],
                values["nexoisp:tool.name"], values["nexoisp:tool.version"], values["nexoisp:scope"],
            )
            again = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(again["metadata"]["component"]["version"], "0.1.0")

    def test_integrity_mismatch_and_unknown_algorithm(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "blob"
            path.write_bytes(b"nexoisp")
            sha = hashlib.sha256(b"nexoisp").hexdigest()
            sbom.verify_integrity(path, "sha256-" + sha)
            digest = __import__("base64").b64encode(hashlib.sha512(b"nexoisp").digest()).decode()
            sbom.verify_integrity(path, "sha512-" + digest)
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.verify_integrity(path, "sha256-" + ("0" * 64))
            self.assertIn("sha256", str(caught.exception))
            with self.assertRaises(sbom.SbomError) as caught:
                sbom.verify_integrity(path, "md5-abcd")
            self.assertIn("não suportado", str(caught.exception))
            with self.assertRaises(sbom.SbomError):
                sbom.verify_integrity(Path(directory) / "ausente", "sha256-" + sha)

    def test_cli_rejects_missing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = str(Path(directory) / "ausente.json")
            proc = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / "validate-sbom.py"), "check", "--file", missing, "--ecosystem", "go"],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(proc.returncode, 1)
            self.assertIn("SBOM ausente", proc.stderr)
            self.assertNotIn("http", proc.stdout.lower())

    def test_generator_pins_and_workflow_keeps_gates(self):
        script = (ROOT / "scripts" / "generate-sbom.sh").read_text(encoding="utf-8")
        workflow = (ROOT / ".github" / "workflows" / "native.yml").read_text(encoding="utf-8")
        docs = (ROOT / "docs" / "SBOM.md").read_text(encoding="utf-8")
        self.assertIn("GOMOD_VERSION=1.12.0", script)
        self.assertIn("004b9f5cc595b797fb5423e2ae4c97bcf0f18c712ed2faee1640b09e5efd6d15", script)
        self.assertIn("b6dd6424755e61c0f7fcd36074fbb78798a33c52f1bd35dd177ba62eccadf404", script)
        self.assertIn("NPM_TOOL_VERSION=6.0.1", script)
        self.assertIn("--ignore-npm-errors", script)
        self.assertIn("sha512-/aU3bBC6qP6cV/qQ5SfUSygE/+2hQhwgg6sJML31/gZ96NyMvIUuwdk637H4z+LS/NryRT2kjR2wtD0qBEVVHQ==", script)
        self.assertNotIn("npm audit", script)
        self.assertNotIn("go get", script)
        self.assertNotIn("source ", script)
        for step in (
            "go test -race ./...",
            "npm -w apps/web run build",
            "python3 tests/contrato/nativo.py",
            "python3 tests/contrato/go_integration.py",
            "python3 tests/contrato/e2e.py",
            "docker build -f apps/api-go/Dockerfile.vpn",
            "name: frontend-v0-evidencias",
            "jobs:\n  verificar:",
            "agente:",
        ):
            self.assertIn(step, workflow)
        self.assertIn("bash scripts/generate-sbom.sh", workflow)
        self.assertIn("sbom-cyclonedx", workflow)
        self.assertIn("1.12.0", docs)
        self.assertIn("6.0.1", docs)
        self.assertIn("Não comprova", docs)

if __name__ == "__main__":
    unittest.main()
