import { lazy, Suspense } from "react";
import { QueryBoundary } from "@/features/shared/feedback";
const ContractFinance = lazy(() =>
  import("./contract").then((module) => ({ default: module.ContractFinance })),
);
export function LazyContractFinance(
  props: Parameters<typeof import("./contract").ContractFinance>[0],
) {
  return (
    <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
      <ContractFinance {...props} />
    </Suspense>
  );
}
