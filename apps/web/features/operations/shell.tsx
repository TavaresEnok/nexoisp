import { useMemo } from "react";
import useSWR from "swr";
import type {
  ShellAdapter,
  ShellAttention,
  ShellRecordSearch,
} from "@/components/shell-context";
import {
  roleLabels,
  sessionScope,
  type Session,
} from "@/features/session/model";
import { useSession } from "@/features/session/provider";
import { api } from "@/platform/erp-client";
import { initials } from "@/lib/format";
import {
  findOperationalPage,
  operationalBranch,
  operationalNavigationAreas,
  searchOperationalNavigation,
} from "./catalogue";
import { canAccessPath, canonicalErpPath } from "./navigation";
import { integrationStatus, operationalTitle } from "./status";

type SearchResult = {
  subscriber_id: string;
  subscriber_name: string;
  contract_id?: string;
  plan_name?: string;
  document?: string;
};

function searchable(me: Session | null) {
  return Boolean(
    me && !me.mfa_pending && me.tenant && me.role !== "subscriber",
  );
}

function operationalPreferenceScope(me: Session | null): string | null {
  if (
    !me ||
    me.mfa_pending ||
    me.role === "subscriber" ||
    (me.role === "saas_operator" && !me.tenant)
  ) {
    return null;
  }
  return sessionScope(me);
}

/** Liga o shell original do v0 à sessão, às permissões e ao catálogo operacional. */
export function useOperationalShell(): ShellAdapter {
  const { me, logout, reload } = useSession();
  return useMemo<ShellAdapter>(() => {
    function useRecordSearch(query: string): ShellRecordSearch {
      const text = query.trim();
      const result = useSWR(
        searchable(me) && text.length >= 2 ? ["erp-search", text] : null,
        ([, value]) =>
          api<{ results: SearchResult[] }>(
            `/search?q=${encodeURIComponent(value)}`,
          ),
      );
      return {
        loading: result.isLoading,
        error: result.error as Error | undefined,
        results: result.data?.results.map((item) => ({
          id: item.contract_id ?? item.subscriber_id,
          title: item.subscriber_name,
          detail: item.plan_name ?? item.document ?? "Cadastro",
          href: `/assinantes?ficha=${encodeURIComponent(item.subscriber_id)}`,
        })),
      };
    }
    function useAttention(): ShellAttention {
      const result = useSWR(
        searchable(me) ? "erp-today" : null,
        () =>
          api<{ items: { title: string; n: number; link: string }[] }>(
            "/today",
          ),
        { refreshInterval: 30000 },
      );
      return {
        loading: result.isLoading,
        error: result.error as Error | undefined,
        items: (result.data?.items ?? [])
          .map((item) => {
            const [path, query] = item.link.split("?");
            const target = canonicalErpPath(path);
            return {
              item,
              target,
              href: `${target}${query ? `?${query}` : ""}`,
            };
          })
          .filter(({ target }) => canAccessPath(me, target))
          .map(({ item, target, href }) => ({
            id: `${item.title}-${href}`,
            title: `${item.n} · ${item.title}`,
            href,
            area: /^\/(?:rede|noc|pops)/.test(target)
              ? "network"
              : /^\/(?:ordens-de-servico|agenda|meu-trabalho|estoque)/.test(
                    target,
                  )
                ? "field"
                : /^\/(?:atendimentos|prospectos)/.test(target)
                  ? "support"
                  : "other",
          })),
      };
    }
    return {
      account: me
        ? {
            name: me.name,
            initials: initials(me.name).toUpperCase(),
            role: roleLabels[me.role],
            tenant: me.tenant?.name ?? null,
            demo: Boolean(me.demo),
            support: Boolean(me.support),
          }
        : null,
      preferenceScope: operationalPreferenceScope(me),
      canAccess: (path) => canAccessPath(me, path),
      connected: (path) => integrationStatus(path) === "connected",
      title: operationalTitle,
      areas: operationalNavigationAreas,
      findPage: findOperationalPage,
      branch: operationalBranch,
      searchPages: searchOperationalNavigation,
      personal:
        me?.role === "subscriber"
          ? { href: "/portal", label: "Meu portal", audience: "Assinante" }
          : me?.role === "saas_operator" && !me.support
            ? { href: "/provedores", label: "Provedores", audience: "Operador" }
            : null,
      useRecordSearch,
      useAttention,
      logout,
      exitSupport: async () => {
        await api("/support/exit", { method: "POST" });
        await reload();
      },
    };
  }, [me, logout, reload]);
}
