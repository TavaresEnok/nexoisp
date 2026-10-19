import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SWRConfig } from "swr";
import { ApiError } from "@/data/erp/http";
import { api, sessionExpiredEvent } from "@/platform/erp-client";
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
    try {
      const me = sessionSchema.parse(await api<unknown>("/me"));
      if (current === generation.current)
        setState((previous) => ({
          me,
          error: null,
          loading: false,
          revision: previous.revision + 1,
        }));
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
  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    generation.current++;
    setState((previous) => ({
      me: null,
      loading: false,
      error: null,
      revision: previous.revision + 1,
    }));
  };
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
