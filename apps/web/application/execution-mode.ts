import config from "../execution.config.json";

export type ExecutionMode = "demo" | "original";

export function parseExecutionMode(value: unknown): ExecutionMode {
  if (value !== "demo" && value !== "original") throw new Error("Modo de execução inválido: use demo ou original.");
  return value;
}

export const executionMode = parseExecutionMode(config.mode);
export const isDemoMode = executionMode === "demo";
