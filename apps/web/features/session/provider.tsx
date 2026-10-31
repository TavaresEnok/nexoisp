import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { SWRConfig } from "swr";
import { ApiError } from "@/data/erp/http";
import { api, erpClient, sessionExpiredEvent } from "@/platform/erp-client";
import { isOperational } from "@/platform/execution";
import { sessionSchema, sessionScope, type Session } from "./model";

type State = {
  me: Session | null;
  loading: boolean;
  error: Error | null;
  revision: number;
};
type Context = State & {
  operational: boolean;
  reload: () => Promise<Session | null>;
  logout: () => Promise<void>;
};
const SessionContext = createContext<Context | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({
    me: null,
    loading: isOperational,
    error: null,
    revision: 0,
  });
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    erpClient.beginSessionTransition();
    // Impede que formulários e efeitos da árvore anterior usem a nova prova.
    flushSync(() =>
      setState((previous) => ({
        me: null,
        error: null,
        loading: true,
        revision: previous.revision + 1,
      })),
    );
    try {
      const candidate = await erpClient.session();
      const me = sessionSchema.parse(candidate.data);
      if (current === generation.current) {
        candidate.accept();
        setState((previous) => ({ ...previous, me, loading: false }));
      }
      return me;
    } catch (error) {
      if (current === generation.current)
        setState((previous) => ({
          me: null,
          loading: false,
          error:
            error instanceof ApiError && error.status === 401
              ? null
              : (error as Error),
          revision: previous.revision + 1,
        }));
      return null;
    }
  }, []);
  useEffect(() => {
    if (!isOperational) return;
    void reload();
    const expire = () => {
      generation.current++;
      setState((previous) => ({
        me: null,
        loading: false,
        error: null,
        revision: previous.revision + 1,
      }));
    };
    window.addEventListener(sessionExpiredEvent, expire);
    return () => {
      generation.current++;
      window.removeEventListener(sessionExpiredEvent, expire);
    };
  }, [reload]);
  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" });
    generation.current++;
    setState((previous) => ({
      me: null,
      loading: false,
      error: null,
      revision: previous.revision + 1,
    }));
  }, []);
  const key = state.me
    ? `${sessionScope(state.me)}:${state.revision}`
    : `anonymous:${state.revision}`;
  return (
    <SessionContext.Provider
      value={{ ...state, operational: isOperational, reload, logout }}
    >
      <SessionCache key={key}>{children}</SessionCache>
    </SessionContext.Provider>
  );
}
function SessionCache({ children }: { children: ReactNode }) {
  const [cache] = useState(() => new Map());
  return (
    <SWRConfig
      value={{
        provider: () => cache,
        revalidateOnFocus: true,
        shouldRetryOnError: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider ausente.");
  return value;
}
