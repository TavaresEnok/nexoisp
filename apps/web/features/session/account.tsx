import { useMemo, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { ShieldAlert, Smartphone, ScanLine, KeyRound } from "lucide-react";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { MutationForm, FormField } from "@/features/shared/form";
import { api } from "@/platform/erp-client";
import { useSession } from "./provider";
/** QR code do endereço otpauth gerado NO NAVEGADOR: o segredo nunca vai para um serviço externo de QR. */
function TotpQr({ value }: { value: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { size: n + 8, path: d };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label="QR code para o aplicativo autenticador"
      viewBox={`0 0 ${size} ${size}`}
      width={208}
      height={208}
      shapeRendering="crispEdges"
      className="rounded-md"
      style={{ background: "#ffffff" }}
    >
      <path d={path} fill="#111111" />
    </svg>
  );
}

function Passo({
  n,
  icon: Icon,
  title,
  children,
}: {
  n: number;
  icon: typeof Smartphone;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold">
        {n}
      </span>
      <div className="grid gap-1.5">
        <p className="flex items-center gap-1.5 font-medium">
          <Icon size={15} aria-hidden />
          {title}
        </p>
        {children}
      </div>
    </li>
  );
}

export function Account() {
  const { me, reload } = useSession();
  const [setup, setSetup] = useState<{
    secret: string;
    otpauth_url: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [off, setOff] = useState({ password: "", code: "" });
  const [password, setPassword] = useState({ current: "", next: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function startSetup() {
    setError("");
    try {
      setSetup(await api("/me/mfa/setup", { method: "POST" }));
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <>
      <PageHeading
        title="Minha conta"
        description="Credenciais e segurança de acesso."
      />
      {me?.password_change_required && (
        <Alert>
          <AlertTitle>Troque a senha provisória</AlertTitle>
          <AlertDescription>
            O administrador redefiniu sua senha. Defina uma nova senha para
            acessar o restante do sistema; até lá, as demais funções ficam
            bloqueadas.
          </AlertDescription>
        </Alert>
      )}
      {me?.mfa_pending && !me.password_change_required && (
        <Alert className="mb-4 border-warning bg-warning-bg px-4 py-3">
          <ShieldAlert className="text-warning" />
          <AlertTitle className="text-base font-semibold">
            Falta só um passo: ative a verificação em duas etapas
          </AlertTitle>
          <AlertDescription className="grid gap-3">
            <p>
              Por segurança, contas de administrador precisam do código de um
              aplicativo autenticador no celular. Enquanto isso não for feito, o
              menu do NexoISP fica bloqueado e só esta página aparece. Leva
              menos de um minuto.
            </p>
            {!setup && (
              <div>
                <Button onClick={startSetup}>Configurar agora</Button>
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}
      <div className="erp-stack">
        {!me?.password_change_required && (
          <Panel
            title="Verificação em duas etapas"
            description="Use um aplicativo autenticador para gerar seus códigos de acesso."
            action={
              <Badge variant={me?.mfa_enabled ? "success" : "secondary"}>
                {me?.mfa_enabled ? "Ativa" : "Inativa"}
              </Badge>
            }
          >
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {!me?.mfa_enabled && !setup && (
              <Button onClick={startSetup}>Configurar autenticação</Button>
            )}
            {!me?.mfa_enabled && setup && (
              <MutationForm
                submit="Ativar verificação"
                onSubmit={async () => {
                  await api("/me/mfa/enable", { body: { code } });
                  setSetup(null);
                  setCode("");
                  await reload();
                }}
              >
                <ol className="grid gap-5">
                  <Passo
                    n={1}
                    icon={Smartphone}
                    title="Instale um aplicativo autenticador no celular"
                  >
                    <p className="text-sm text-muted-foreground">
                      Google Authenticator, Microsoft Authenticator, Authy ou
                      2FAS.
                    </p>
                  </Passo>
                  <Passo
                    n={2}
                    icon={ScanLine}
                    title="No aplicativo, escolha adicionar conta e leia o QR code"
                  >
                    <TotpQr value={setup.otpauth_url} />
                    <details className="text-sm text-muted-foreground">
                      <summary className="cursor-pointer">
                        Não consegue ler? Digite a chave manualmente
                      </summary>
                      <div className="mt-2 max-w-md">
                        <Input
                          readOnly
                          aria-label="Chave de configuração"
                          value={setup.secret}
                          onFocus={(e) => e.target.select()}
                          className="font-mono"
                        />
                      </div>
                    </details>
                  </Passo>
                  <Passo
                    n={3}
                    icon={KeyRound}
                    title="Digite o código de 6 dígitos que o aplicativo mostrar"
                  >
                    <div className="max-w-48">
                      <FormField label="Código do aplicativo">
                        <Input
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          placeholder="000000"
                          value={code}
                          onChange={(e) =>
                            setCode(e.target.value.replace(/\D/g, ""))
                          }
                          className="font-mono tracking-widest"
                          required
                        />
                      </FormField>
                    </div>
                  </Passo>
                </ol>
              </MutationForm>
            )}
            {me?.mfa_enabled && (
              <MutationForm
                submit="Desativar verificação"
                onSubmit={async () => {
                  await api("/me/mfa/disable", { body: off });
                  setOff({ password: "", code: "" });
                  await reload();
                }}
              >
                <div className="erp-columns">
                  <FormField label="Senha atual">
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={off.password}
                      onChange={(e) =>
                        setOff({ ...off, password: e.target.value })
                      }
                      required
                    />
                  </FormField>
                  <FormField label="Código do aplicativo">
                    <Input
                      value={off.code}
                      onChange={(e) => setOff({ ...off, code: e.target.value })}
                      required
                    />
                  </FormField>
                </div>
              </MutationForm>
            )}
          </Panel>
        )}
        <Panel
          title="Alterar senha"
          description="A alteração encerra suas outras sessões."
        >
          <MutationForm
            submit="Alterar senha"
            onSubmit={async () => {
              const provisional = Boolean(me?.password_change_required);
              if (provisional && password.next === password.current)
                throw new Error(
                  "A nova senha deve ser diferente da senha provisória.",
                );
              await api("/me/password", { body: password });
              setPassword({ current: "", next: "" });
              setMessage("Senha alterada. Outras sessões foram encerradas.");
              if (provisional) await reload();
            }}
          >
            <div className="erp-columns">
              <FormField label="Senha atual">
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={password.current}
                  onChange={(e) =>
                    setPassword({ ...password, current: e.target.value })
                  }
                  required
                />
              </FormField>
              <FormField label="Nova senha" hint="Mínimo de 8 caracteres.">
                <Input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={password.next}
                  onChange={(e) =>
                    setPassword({ ...password, next: e.target.value })
                  }
                  required
                />
              </FormField>
            </div>
            {message && <p role="status">{message}</p>}
          </MutationForm>
        </Panel>
      </div>
    </>
  );
}
