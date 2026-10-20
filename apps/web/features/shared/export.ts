import { toast } from "sonner";
import { download } from "@/platform/erp-client";

// Exportação CSV limitada pelo servidor; avisa quando o arquivo não traz todos os registros.
export async function exportCsv(path: string, filename: string) {
  const result = await download(path, filename);
  if (result.truncated)
    toast.warning(
      `O arquivo traz os primeiros ${result.limit!.toLocaleString("pt-BR")} de ${result.total!.toLocaleString("pt-BR")} registros. Refine os filtros para exportar o restante.`,
    );
  return result;
}
