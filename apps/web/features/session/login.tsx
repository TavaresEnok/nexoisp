import { useEffect, useState, type FormEvent } from "react";
import useSWR from "swr";
import {
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Lock,
  Mail,
  Moon,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { returnPath } from "@/features/operations/return-path";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { api } from "@/platform/erp-client";
import { readAppearance, saveAppearance } from "@/platform/appearance";
import { useSession } from "./provider";
import { LoginShowcase } from "./login-showcase";
import styles from "./login.module.css";

const demoAccounts = [
  "admin@alfa.demo",
  "atendimento@alfa.demo",
  "financeiro@alfa.demo",
  "noc@alfa.demo",
  "admin@beta.demo",
  "operador@nexoisp.demo",
];

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "Bom dia." : hour < 18 ? "Boa tarde." : "Boa noite.";
}

export function Login() {
  const { reload } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  const health = useSWR("health", () => api<{ demo: boolean }>("/health"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  useEffect(() => {
    const stored = readAppearance();
    if (stored) setDark(stored === "dark");
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      try {
        await api("/auth/login", {
          body: { email, password, ...(code ? { code } : {}) },
        });
      } catch (reason) {
        if (
          reason instanceof Error &&
          /código de verificação/.test(reason.message)
        )
          setNeedsCode(true);
        throw reason;
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
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Não foi possível entrar.",
      );
      setBusy(false);
    }
  };
  return (
    <main className={styles.page}>
      <LoginShowcase />
      <section className={styles.side}>
        <div className={styles.topbar}>
          <span className={`${styles.wordmark} ${styles.mobileBrand}`}>
            nexo<span>isp</span>
            <i />
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={dark ? "Usar tema claro" : "Usar tema escuro"}
            onClick={() => {
              const next = !dark;
              setDark(next);
              saveAppearance(next ? "dark" : "light");
            }}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
        </div>
        <div className={styles.formWrap}>
          <p className={styles.eyebrow}>BEM-VINDO AO SEU WORKSPACE</p>
          <h1>{greeting()}</h1>
          <p className={styles.lead}>
            Acesse o ambiente do seu provedor e continue de onde parou.
          </p>
          <form className={styles.form} onSubmit={submit} noValidate={false}>
            <fieldset disabled={busy}>
              <div className={styles.field}>
                <Label htmlFor="login-email">E-mail</Label>
                <InputGroup className={styles.group}>
                  <InputGroupAddon>
                    <Mail />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    placeholder="voce@seuprovedor.com.br"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                  />
                </InputGroup>
              </div>
              <div className={styles.field}>
                <Label htmlFor="login-password">Senha</Label>
                <InputGroup className={styles.group}>
                  <InputGroupAddon>
                    <Lock />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="Digite sua senha"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <InputGroupAddon align="inline-end">
                    <button
                      type="button"
                      className={styles.eye}
                      aria-label={
                        showPassword ? "Ocultar senha" : "Mostrar senha"
                      }
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOff /> : <Eye />}
                    </button>
                  </InputGroupAddon>
                </InputGroup>
              </div>
              {needsCode && (
                <div className={styles.field}>
                  <Label htmlFor="login-code">
                    Código do aplicativo autenticador
                  </Label>
                  <InputGroup className={styles.group}>
                    <InputGroupAddon>
                      <KeyRound />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="login-code"
                      className={styles.code}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="000000"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      required
                      autoFocus
                    />
                  </InputGroup>
                  <small className={styles.hint}>
                    Sua conta usa verificação em duas etapas. Abra o aplicativo
                    autenticador e informe o código atual.
                  </small>
                </div>
              )}
              {error && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" size="lg" className={styles.submit}>
                {busy ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    Entrando…
                  </>
                ) : (
                  <>
                    Entrar
                    <ArrowRight data-icon="inline-end" />
                  </>
                )}
              </Button>
            </fieldset>
          </form>
          {health.data?.demo && (
            <section
              className={styles.demo}
              aria-label="Contas de demonstração"
            >
              <p>Ambiente de demonstração · toque para preencher</p>
              <div>
                {demoAccounts.map((account) => (
                  <button
                    key={account}
                    type="button"
                    onClick={() => {
                      setEmail(account);
                      setPassword("demo1234");
                    }}
                  >
                    {account}
                  </button>
                ))}
              </div>
            </section>
          )}
          <div className={styles.assist}>
            <p>
              <ShieldCheck size={14} />
              Sessão protegida por cookie seguro e verificação em duas etapas
              quando configurada.
            </p>
            <p>
              Sem acesso ainda? Fale com o administrador do seu provedor. Ele
              também redefine senhas.
            </p>
            <a href="/demonstracao/">
              Explorar a demonstração visual
              <ArrowRight size={13} />
            </a>
          </div>
        </div>
        <footer className={styles.footer}>
          <span>© 2026 NexoISP</span>
          <span>Seu provedor, em sintonia.</span>
        </footer>
      </section>
    </main>
  );
}
