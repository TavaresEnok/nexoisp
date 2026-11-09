// Redução de fotos tiradas pela câmera antes do envio: lado maior até 1920 px,
// recodificada em JPEG. O servidor continua conferindo tipo e tamanho.
export const photoMaxSide = 1920;
export const photoMaxBytes = 5 * 1024 * 1024;
const qualities = [0.85, 0.72, 0.6];

export type DecodedImage = {
  width: number;
  height: number;
  close?: () => void;
};
export type PhotoCodec<T extends DecodedImage = DecodedImage> = {
  decode: (file: Blob) => Promise<T>;
  encode: (
    image: T,
    width: number,
    height: number,
    quality: number,
  ) => Promise<Blob>;
};

/** Dimensões proporcionais que cabem no limite, sem ampliar fotos menores. */
export function fitWithin(width: number, height: number, max = photoMaxSide) {
  if (!(width > 0) || !(height > 0))
    throw new Error("Foto sem dimensões válidas.");
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function photoName(now: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `foto-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.jpg`;
}

export async function reducePhoto<T extends DecodedImage>(
  file: Blob,
  codec: PhotoCodec<T>,
): Promise<{ blob: Blob; width: number; height: number }> {
  if (!file.type.startsWith("image/"))
    throw new Error("Selecione uma foto da câmera.");
  let image: T;
  try {
    image = await codec.decode(file);
  } catch {
    throw new Error(
      "Não foi possível ler a foto; tente novamente ou use JPEG, PNG ou WebP.",
    );
  }
  try {
    const size = fitWithin(image.width, image.height);
    for (const quality of qualities) {
      const blob = await codec.encode(image, size.width, size.height, quality);
      if (blob.type !== "image/jpeg")
        throw new Error("O navegador não gerou JPEG para a foto.");
      if (blob.size > 0 && blob.size <= photoMaxBytes) return { blob, ...size };
    }
    throw new Error("A foto continua acima de 5 MiB após a redução.");
  } finally {
    image.close?.();
  }
}

/** Implementação do navegador: decodifica respeitando a orientação EXIF e desenha em canvas. */
export const browserPhotoCodec: PhotoCodec<ImageBitmap> = {
  decode: (file) => createImageBitmap(file, { imageOrientation: "from-image" }),
  async encode(image, width, height, quality) {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas indisponível para reduzir a foto.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      return canvas.convertToBlob({ type: "image/jpeg", quality });
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas indisponível para reduzir a foto.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("Falha ao gerar a foto reduzida.")),
        "image/jpeg",
        quality,
      ),
    );
  },
};

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
