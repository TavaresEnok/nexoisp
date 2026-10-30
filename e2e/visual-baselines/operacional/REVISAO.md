# Referências operacionais — 26/10/2026

## Lote 49 — ambiente canônico de CI

Os seis pares do lote 48 foram examinados individualmente e as referências alinhadas à captura no container canônico. Proveniência, hashes, dimensões e observações estão em [LOTE49](../../../docs/LOTE49-REFERENCIAS-CONTAINER-CI.md). A falha do CI 48 permanece registrada; captura com atualização não é aprovação do cenário normal. Revisão independente dos seis pares, resultado normal canônico confirmado e gates de CI e SBOM no SHA exato continuam obrigatórios.

## Lote 48 — reconciliação C34

Os seis pares foram examinados individualmente; hashes, dimensões e observações estão em [LOTE48](../../../docs/LOTE48-REFERENCIAS-VISUAIS-C34.md). As diferenças adotadas correspondem à barra lateral de favoritos e estrelas do C34 aprovado no lote 45; a referência de celular é binariamente idêntica. A captura manual não é aprovação do cenário normal: ele falhou posteriormente na exclusão de etiqueta. Revisão independente dos seis pares e execução sem atualização, CI completo e SBOM permanecem pendentes antes da integração.

As seis referências PNG foram confrontadas com uma compilação do HEAD local recebido antes do lote B01/B02/B12. As imagens anteriores ainda exibiam um banner de demonstração e navegação sem as setas dos submenus que já haviam mudado no código recebido. Os componentes, estilos e a interface oficial não foram alterados para acomodar o teste.

As imagens adotadas foram capturadas **do código recebido**, usando as dependências travadas atuais, e examinadas individualmente. A compilação do lote reproduziu o mesmo layout. Originais, capturas de ambas as versões, hashes e comparação estão em `fechamento-03/evidencias/visual-review/` e `visual-baseline-review.json` da entrega.

Repetir a mesma compilação revelou variação de rasterização: 17 pixels de borda com diferença de um nível e 26 pixels do ícone com diferença máxima de quatro níveis RGB. `visual-compare.mjs` limita a tolerância a 32 pixels em toda a imagem, diferença RGB máxima de 4/255 e nenhum desvio de alfa/dimensões. As máscaras preexistentes de IDs continuam iguais. Três testes demonstram recusa de deslocamento de controle, remoção de rótulo e mudanças acima desses limites. O teste registra hashes e métricas mesmo quando aceita esse ruído; não declara identidade binária quando há diferença.

Não atualizar referências automaticamente ao ocorrer falha. `UPDATE_V0_OPERATIONAL_VISUAL` continua uma opção manual preexistente de captura; o workflow normal não a define. PNGs podem ser decodificados pela biblioteca de teste [pngjs](https://github.com/pngjs/pngjs), fixada no lockfile E2E.
