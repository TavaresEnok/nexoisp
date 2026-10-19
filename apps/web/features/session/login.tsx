import { useState } from "react";
import useSWR from "swr";
import {
  Infinity as InfinityIcon,
  ShieldCheck,
  Eye,
  EyeOff,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { returnPath } from "@/features/operations/return-path";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/workspace-ui";
import { MutationForm, FormField } from "@/features/shared/form";
import { api } from "@/platform/erp-client";
import { useSession } from "./provider";
const demoAccounts = [
  "admin@alfa.demo",
  "atendimento@alfa.demo",
  "financeiro@alfa.demo",
  "noc@alfa.demo",
  "admin@beta.demo",
  "operador@nexoisp.demo",
];
export function Login() {
  const { reload } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const health = useSWR("health", () => api<{ demo: boolean }>("/health"));
  return (
    <main className="erp-login">
      <div className="erp-login-brand">
        <InfinityIcon size={34} />
        <span className="full-wordmark">
          nexo<span>isp</span>
          <i />
        </span>
        <p>Seu provedor, em sintonia.</p>
      </div>
      <Panel
        title="Entrar no NexoISP"
        description="Acesse o ambiente do seu provedor."
      >
        <MutationForm
          submit="Entrar"
          onSubmit={async () => {
            try {
              await api("/auth/login", {
                body: { email, password, ...(code ? { code } : {}) },
              });
            } catch (error) {
              if (
                error instanceof Error &&
                /código de verificação/.test(error.message)
              )
                setNeedsCode(true);
              throw error;
            }
            const me = await reload();
            if (!me)
              throw new Error(
                "Não foi possível confirmar a sessão. Tente novamente.",
              );
            navigate(
              me.mfa_pending
                ? "/conta"
                : (returnPath(me, location.state) ??
                    (me.role === "saas_operator" && !me.support
                      ? "/provedores"
                      : me.role === "subscriber"
                        ? "/portal"
                        : "/")),
              { replace: true },
            );
          }}
        >
          <FormField label="E-mail">
            <Input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </FormField>
          <FormField label="Senha">
            <div className="flex gap-2">
              <Input
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </Button>
            </div>
          </FormField>
          {needsCode && (
            <FormField label="Código do aplicativo autenticador">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
              />
            </FormField>
          )}
        </MutationForm>
        <p className="profile-footnote">
          <ShieldCheck size={14} />A sessão é protegida pelo servidor.
        </p>
        <p className="text-xs text-muted-foreground">
          Para redefinir sua senha, procure o administrador do provedor.
        </p>
        {health.data?.demo && (
          <section className="erp-demo-accounts">
            <p>Ambiente de demonstração do servidor</p>
            {demoAccounts.map((account) => (
              <Button
                key={account}
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEmail(account);
                  setPassword("demo1234");
                }}
              >
                {account}
              </Button>
            ))}
          </section>
        )}
        <a className="profile-text-action" href="/demonstracao/">
          Explorar a demonstração visual
        </a>
      </Panel>
    </main>
  );
}
