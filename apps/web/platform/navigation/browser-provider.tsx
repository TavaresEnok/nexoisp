import { useMemo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { NavigationProvider, type NavigationAdapter } from "./react";
import { updateQueryHref } from "./query";
import { routerBasename } from "@/platform/execution";

export function BrowserNavigationProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const adapter = useMemo<NavigationAdapter>(() => ({
    pathname: location.pathname,
    search: location.search.slice(1),
    getSearch: () => window.location.search,
    push: href => { void navigate(href); },
    replace: href => { void navigate(href, { replace: true }); },
    refresh: () => navigate(0),
    replaceQuery: values => { const href = updateQueryHref(window.location.href, values); void navigate(routerBasename && href.startsWith(routerBasename) ? href.slice(routerBasename.length) || "/" : href, { replace: true, preventScrollReset: true }); },
  }), [location.pathname, location.search, navigate]);
  return <NavigationProvider adapter={adapter}>{children}</NavigationProvider>;
}
