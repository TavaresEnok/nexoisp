import { lazy, Suspense } from "react";
import { QueryBoundary } from "@/features/shared/feedback";
const ContractFinance = lazy(() => import("./contract").then(module => ({ default: module.ContractFinance })));
export function LazyContractFinance({ id }: { id: string }) { return <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}><ContractFinance id={id} /></Suspense>; }
