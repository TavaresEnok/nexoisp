# SBOM do módulo Go e do workspace npm

O job `verificar` de `.github/workflows/native.yml` gera dois SBOM CycloneDX 1.6 a partir do mesmo checkout e os publica no artefato `sbom-cyclonedx`. Os passos de Go, frontend, PostgreSQL, browser e imagem já existentes permanecem no mesmo job. Os JSON em `sbom/` são só artefato de geração local ou do job; não entram no código versionado.

| Artefato | Fonte | Ferramenta |
| --- | --- | --- |
| `sbom/go.cdx.json` | módulo `apps/api-go` | `cyclonedx-gomod` 1.12.0, comando `mod -test` |
| `sbom/npm.cdx.json` | `package-lock.json` do workspace da raiz | `@cyclonedx/cyclonedx-npm` 6.0.1, `--package-lock-only` |

Cada arquivo traz, em `metadata.properties`, o commit completo (`nexoisp:git.commit`), o run (`nexoisp:ci.run`) e as toolchains Go, Node e npm observadas no momento da geração. No GitHub Actions o run é `GITHUB_RUN_ID`, com o attempt quando existe. Fora do Actions o valor é `local`, a menos que `NEXO_SBOM_RUN_ID` esteja definido.

## Comando local

Na raiz do repositório, com Go, Node, npm, Python 3, curl e git no `PATH`:

```bash
bash scripts/generate-sbom.sh
python3 scripts/validate-sbom.py check --file sbom/go.cdx.json --ecosystem go --expect-commit "$(git rev-parse HEAD)"
python3 scripts/validate-sbom.py check --file sbom/npm.cdx.json --ecosystem npm --expect-commit "$(git rev-parse HEAD)"
```

O diretório de saída é o primeiro argumento. O padrão é `sbom/` na raiz. O cache das ferramentas fica em `${XDG_CACHE_HOME:-$HOME/.cache}/nexoisp-sbom` e pode ser trocado com `NEXO_SBOM_TOOL_CACHE`. Esse cache não pode apontar para dentro do repositório.

## Ferramentas pinadas

As versões foram conferidas nas fontes oficiais em 29/10/2026.

| Ferramenta | Versão | Origem | Integridade verificada na instalação |
| --- | --- | --- | --- |
| cyclonedx-gomod | 1.12.0 | release GitHub `CycloneDX/cyclonedx-gomod` de 22/08/2026 | SHA-256 do tarball Linux amd64 `004b9f5cc595b797fb5423e2ae4c97bcf0f18c712ed2faee1640b09e5efd6d15`; arm64 `b6dd6424755e61c0f7fcd36074fbb78798a33c52f1bd35dd177ba62eccadf404` |
| @cyclonedx/cyclonedx-npm | 6.0.1 | `https://registry.npmjs.org/@cyclonedx/cyclonedx-npm/-/cyclonedx-npm-6.0.1.tgz` | `sha512-/aU3bBC6qP6cV/qQ5SfUSygE/+2hQhwgg6sJML31/gZ96NyMvIUuwdk637H4z+LS/NryRT2kjR2wtD0qBEVVHQ==` |

O script baixa o binário ou o tarball, recusa o arquivo se o hash divergir e só então instala. A instalação npm da ferramenta usa um diretório fora do produto, com `--ignore-scripts` e `--omit=optional`. Não há `npm audit`, `audit fix`, `go get` nem alteração de `go.mod`, `go.sum` ou `package-lock.json`.

O spec escrito pelos dois geradores é o CycloneDX 1.6. A checagem de schema opcional do `cyclonedx-npm` fica desligada porque os pacotes opcionais dela não entram na instalação. Quem falha o job é `scripts/validate-sbom.py`: JSON inválido, lista de componentes ausente ou vazia, ausência de `pkg:golang/` ou `pkg:npm/`, ou proveniência incompleta. Não há arquivo de demonstração de reserva.

## Escopo

O SBOM Go é o grafo de módulos de `apps/api-go`, inclusive dependências de teste (`cyclonedx-gomod mod -test`). A biblioteca padrão do Go não entra como componente. A detecção de licença fica desligada. Se o gerador não consegue calcular a versão do módulo principal, o que ocorre quando o Git não resolve uma tag semver, o script grava o commit em `metadata.component.version`. Uma versão já preenchida pelo gerador é mantida. O commit também fica em `nexoisp:git.commit`.

O SBOM npm lê o `package-lock.json` da raiz e os workspaces declarados em `package.json`. Hoje isso é `apps/web`, com dependências de produção e de build. `e2e/package-lock.json` e `apps/web-legacy` ficam de fora porque não pertencem a esse workspace. O gerador usa `--ignore-npm-errors` porque `npm ls --package-lock-only` termina com erro quando um peer opcional de WASM não está instalado (`@emnapi/*`, exigido por `@tailwindcss/oxide-wasm32-wasi`). A lista continua a ser a do lockfile. Lista vazia ou JSON inválido ainda falha.

O script não lê `.env`, credenciais, dados de clientes ou produção. A geração local consulta o release público do GitHub e o registry público do npm para obter as ferramentas. O fonte do produto não é enviado a scanner remoto nem a API paga.

## Limites

Este SBOM descreve a fonte e o grafo resolvido no checkout. Não comprova imagem publicada, conteúdo de `Dockerfile`, homologação nem deploy. Não substitui o resultado do job no GitHub: a gerência confere o run e o artefato `sbom-cyclonedx` antes de tratar B01-SBOM como testado no CI ou publicado.

`python3 -m unittest discover -s tests/operacao -p test_sbom.py` cobre artefato ausente, vazio, JSON inválido, componentes vazios e os dois formatos CycloneDX. Esses testes não baixam ferramenta, não geram o SBOM do produto e não aprovam o CI.
