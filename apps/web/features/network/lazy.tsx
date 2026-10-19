import { lazy, Suspense } from "react";
import { QueryBoundary } from "@/features/shared/feedback";
const ContractService = lazy(() =>
  import("./service").then((module) => ({ default: module.ContractService })),
);
export function LazyContractService(props: {
  id: string;
  status: string;
  planName?: string;
}) {
  return (
    <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
      <ContractService {...props} />
    </Suspense>
  );
}

const ContractTelemetry = lazy(() =>
  import("./telemetry").then((module) => ({
    default: module.ContractTelemetry,
  })),
);
export function LazyContractTelemetry(props: { id: string }) {
  return (
    <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
      <ContractTelemetry {...props} />
    </Suspense>
  );
}

const ContractCpe = lazy(() =>
  import("./cpe").then((module) => ({ default: module.ContractCpe })),
);
export function LazyContractCpe(props: { id: string }) {
  return (
    <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
      <ContractCpe {...props} />
    </Suspense>
  );
}

const ContractDiagnosisButton = lazy(() =>
  import("./noc").then((module) => ({
    default: module.ContractDiagnosisButton,
  })),
);
export function LazyContractDiagnosisButton(props: { id: string }) {
  return (
    <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
      <ContractDiagnosisButton {...props} />
    </Suspense>
  );
}

const ContractOnu = lazy(() =>
  import("./onus").then((module) => ({ default: module.ContractOnu })),
);
export function LazyContractOnu(props: { id: string; status: string }) {
  return (
    <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
      <ContractOnu {...props} />
    </Suspense>
  );
}

const ContractAddresses = lazy(() =>
  import("./ipam").then((module) => ({ default: module.ContractAddresses })),
);
export function LazyContractAddresses(props: { id: string }) {
  return (
    <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
      <ContractAddresses {...props} />
    </Suspense>
  );
}

const ContractFiber = lazy(() =>
  import("./ftth").then((module) => ({ default: module.ContractFiber })),
);
export function LazyContractFiber(props: { id: string }) {
  return (
    <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
      <ContractFiber {...props} />
    </Suspense>
  );
}
