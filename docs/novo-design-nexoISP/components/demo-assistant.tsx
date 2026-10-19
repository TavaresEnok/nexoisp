import * as React from "react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export function DemoAssistant() {
  return <Alert><AlertTitle><h1>Assistente indisponível no modo demonstrativo local</h1></AlertTitle><AlertDescription>A implementação original foi preservada. Este modo não consulta sessões, não envia mensagens e não cria conversas fictícias. As consultas do workspace continuam disponíveis.</AlertDescription></Alert>;
}
