import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "@/features/session/provider";
import { QueryBoundary } from "@/features/shared/feedback";
export function PortalSignOut() {
  const { logout } = useSession();
  const navigate = useNavigate();
  const started = useRef(false);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void logout()
      .then(() => navigate("/login", { replace: true }))
      .catch((reason) => setError(reason as Error));
  }, [logout, navigate]);
  return (
    <QueryBoundary
      loading={!error}
      error={error}
      retry={() => window.location.reload()}
    >
      <p>Encerrando sessão…</p>
    </QueryBoundary>
  );
}
