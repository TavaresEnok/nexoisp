"use client";

import { useNavigation, useSearchParams } from "@/platform/navigation/react";
import type { SetStateAction } from "react";
import { readQueryValue } from "@/platform/navigation/query";

export function useReplaceQueryValues() {
  return useNavigation().replaceQuery;
}

export function useQueryState<T extends string = string>(key: string, fallback: NoInfer<T>, allowed?: readonly NoInfer<T>[], options?: { resetPage?: boolean }) {
  const params = useSearchParams();
  const navigation = useNavigation();
  const raw = params.get(key);
  const value = readQueryValue(raw, fallback, allowed);
  const setValue = (next: SetStateAction<T>) => {
    const current = new URLSearchParams(navigation.getSearch()).get(key);
    const previous = readQueryValue(current, fallback, allowed);
    const candidate = typeof next === "function" ? next(previous) : next;
    const updated = readQueryValue(candidate, fallback, allowed);
    navigation.replaceQuery({ [key]: updated === fallback ? null : updated, ...(options?.resetPage ? { pagina: null } : {}) });
  };
  return [value, setValue] as const;
}
