import Link from "@/platform/navigation/link";
import { ArrowLeft, Network } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="table-empty">
      <Network size={30} />
      <p className="eyebrow">PÁGINA NÃO ENCONTRADA</p>
      <h1 className="text-2xl font-medium">Esta conexão ainda não existe.</h1>
      <p>Volte ao panorama para encontrar o que precisa.</p>
      <Link href="/" className={buttonVariants({ variant: "outline" })}>
        <ArrowLeft data-icon="inline-start" />
        Voltar à visão geral
      </Link>
    </div>
  );
}
