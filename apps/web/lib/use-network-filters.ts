"use client";

import { useNavigation, useSearchParams } from "@/platform/navigation/react";
import type { SetStateAction } from "react";
import type { NetworkFilters } from "./network-query";
import { networkFilterKeys, readNetworkFilters } from "@/domain/network-filters";

const keys = networkFilterKeys;
export function useNetworkFilters(initial: NetworkFilters) {
  const params = useSearchParams();
  const navigation = useNavigation();
  const filters = readNetworkFilters(params, initial);
  const setFilters = (next: SetStateAction<NetworkFilters>) => {
    const current = new URLSearchParams(navigation.getSearch());
    const previous = readNetworkFilters(current, initial);
    const updated = typeof next === "function" ? next(previous) : next;
    navigation.replaceQuery(Object.fromEntries(keys.map(key => [`rede_${key}`, updated[key] || null])));
  };
  return [filters, setFilters] as const;
}
