import { lazy, Suspense } from "react";
import { QueryBoundary } from "@/features/shared/feedback";
const LinkedOrders = lazy(() =>
  import("./linked").then((module) => ({ default: module.LinkedOrders })),
);
export function LazyLinkedOrders(props: {
  subscriberId: string;
  contractId?: string;
}) {
  return (
    <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
      <LinkedOrders {...props} />
    </Suspense>
  );
}
