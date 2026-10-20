import { Check, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Filtro liga/desliga no estilo dos controles do v0, no lugar de uma caixa de seleção solta. */
export function FilterToggle({
  active,
  onChange,
  children,
}: {
  active: boolean;
  onChange: (active: boolean) => void;
  children: string;
}) {
  return (
    <Button
      variant={active ? "secondary" : "outline"}
      size="sm"
      aria-pressed={active}
      onClick={() => onChange(!active)}
    >
      {active ? (
        <Check data-icon="inline-start" />
      ) : (
        <UserRound data-icon="inline-start" />
      )}
      {children}
    </Button>
  );
}
