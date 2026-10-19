"use client";

import { lazy, Suspense, useSyncExternalStore } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { NetworkSubscriber } from "@/lib/network-query";

const LeafletMap = lazy(() => import("@/components/network-leaflet-map"));
const subscribe = () => () => {};
export function ClientMap(props: { rows: NetworkSubscriber[]; selectedId: string | null }) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const loading = <Skeleton className="size-full" />;
  return mounted ? <Suspense fallback={loading}><LeafletMap {...props} /></Suspense> : loading;
}
