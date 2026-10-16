/** Módulos posteriores (rede, OLT) reagem a mudanças de contrato na mesma transação. Fica em arquivo próprio, sem dependências, para não entrar em ciclo de importação. */
export const contractChangeHooks: Array<(c: any, ctx: any, contractId: string) => Promise<void>> = [];
