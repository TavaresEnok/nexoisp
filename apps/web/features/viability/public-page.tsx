import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import {
  CheckCircle2,
  LoaderCircle,
  LocateFixed,
  MapPin,
  MessageCircle,
  Phone,
  SearchX,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { readAppearance, systemIsDark } from "@/platform/appearance";
import {
  parseCoordinate,
  publicViabilityPath,
  publicViabilitySchema,
  viabilityResultSchema,
  whatsappLink,
  type PublicViability as Provider,
  type ViabilityResult,
} from "./models";
import styles from "./public-page.module.css";

class PublicError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Rotas públicas sem sessão: nenhum cookie é enviado e nenhum dado interno volta.
async function publicRequest(path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new PublicError(0, "Não foi possível conectar. Tente novamente.");
  }
  const data = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  if (!response.ok)
    throw new PublicError(
      response.status,
      response.status === 429
        ? "Muitas consultas seguidas. Aguarde alguns minutos e tente de novo."
        : (data?.error ?? "Não foi possível concluir a consulta."),
    );
  return data;
}

type Load =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "error"; message: string }
  | { state: "ready"; provider: Provider };

export function PublicViability() {
  const { slug = "" } = useParams();
  const base = publicViabilityPath(slug);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [address, setAddress] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ViabilityResult | null>(null);
  const [lead, setLead] = useState({ name: "", phone: "", consent: false });
  const [leadBusy, setLeadBusy] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);
  const [leadSent, setLeadSent] = useState(false);

  useEffect(() => {
    const stored = readAppearance();
    document.documentElement.classList.toggle(
      "dark",
      stored ? stored === "dark" : systemIsDark(),
    );
  }, []);
  useEffect(() => {
    let active = true;
    setLoad({ state: "loading" });
    publicRequest(base)
      .then((data) => {
        if (active)
          setLoad({
            state: "ready",
            provider: publicViabilitySchema.parse(data),
          });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        if (reason instanceof PublicError && reason.status === 404)
          setLoad({ state: "unavailable" });
        else
          setLoad({
            state: "error",
            message:
              reason instanceof Error
                ? reason.message
                : "Não foi possível abrir a consulta.",
          });
      });
    return () => {
      active = false;
    };
  }, [base, attempt]);
  useEffect(() => {
    document.title =
      load.state === "ready"
        ? `Consulta de viabilidade · ${load.provider.name}`
        : "Consulta de viabilidade";
  }, [load]);

  const locate = () => {
    setError(null);
    if (!("geolocation" in navigator)) {
      setError(
        "Este navegador não oferece localização. Informe as coordenadas.",
      );
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLatitude(position.coords.latitude.toFixed(6));
        setLongitude(position.coords.longitude.toFixed(6));
        setLocating(false);
      },
      () => {
        setError(
          "Não foi possível obter a localização. Autorize o acesso ou informe as coordenadas.",
        );
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  };
  const point = () => {
    const lat = parseCoordinate(latitude, "latitude");
    const lng = parseCoordinate(longitude, "longitude");
    if (lat === null || lng === null)
      throw new Error(
        "Informe latitude entre -90 e 90 e longitude entre -180 e 180.",
      );
    const text = address.trim();
    return {
      latitude: lat,
      longitude: lng,
      ...(text ? { address: text } : {}),
    };
  };
  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setLeadSent(false);
    setLeadError(null);
    try {
      setResult(
        viabilityResultSchema.parse(
          await publicRequest(`${base}/consulta`, point()),
        ),
      );
    } catch (reason) {
      if (reason instanceof PublicError && reason.status === 404)
        setLoad({ state: "unavailable" });
      else
        setError(
          reason instanceof Error
            ? reason.message
            : "Não foi possível concluir a consulta.",
        );
    } finally {
      setBusy(false);
    }
  };
  const sendLead = async (event: FormEvent) => {
    event.preventDefault();
    if (leadBusy) return;
    setLeadBusy(true);
    setLeadError(null);
    try {
      if (!lead.consent)
        throw new Error("Autorize o contato para enviar seus dados.");
      await publicRequest(`${base}/interesse`, {
        ...point(),
        name: lead.name.trim(),
        phone: lead.phone.trim(),
        consent: true,
      });
      setLeadSent(true);
    } catch (reason) {
      setLeadError(
        reason instanceof Error ? reason.message : "Não foi possível enviar.",
      );
    } finally {
      setLeadBusy(false);
    }
  };

  const provider = load.state === "ready" ? load.provider : null;
  const phone = result?.phone ?? provider?.phone ?? null;
  const whatsapp = whatsappLink(result?.whatsapp ?? provider?.whatsapp ?? null);
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-busy={load.state === "loading"}>
        {load.state === "loading" && (
          <p className={styles.lead}>
            <LoaderCircle className="inline size-4 animate-spin" /> Carregando a
            consulta…
          </p>
        )}
        {load.state === "unavailable" && (
          <>
            <p className={styles.eyebrow}>CONSULTA DE VIABILIDADE</p>
            <h1>Consulta indisponível</h1>
            <p className={styles.lead}>
              Este endereço não tem uma consulta de viabilidade ativa. Confira o
              link recebido ou fale diretamente com o provedor.
            </p>
          </>
        )}
        {load.state === "error" && (
          <>
            <p className={styles.eyebrow}>CONSULTA DE VIABILIDADE</p>
            <Alert variant="destructive" role="alert">
              <AlertDescription>{load.message}</AlertDescription>
            </Alert>
            <div className={styles.actions}>
              <Button
                variant="outline"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Tentar novamente
              </Button>
            </div>
          </>
        )}
        {provider && (
          <>
            <div className={styles.brand}>
              {provider.logo && (
                <img
                  src={`${base}/logo?v=${encodeURIComponent(provider.logo.sha256)}`}
                  alt={`Logotipo de ${provider.name}`}
                />
              )}
              <strong>{provider.name}</strong>
            </div>
            <p className={styles.eyebrow}>CONSULTA DE VIABILIDADE</p>
            <h1>Verifique se atendemos o seu endereço.</h1>
            <p className={styles.lead}>
              {provider.message ??
                "Use a localização do seu aparelho ou informe as coordenadas do endereço onde deseja a instalação."}
            </p>
            <form className={styles.form} onSubmit={check}>
              <fieldset disabled={busy}>
                <div className={styles.field}>
                  <Label htmlFor="viability-address">
                    Endereço da instalação (opcional)
                  </Label>
                  <Input
                    id="viability-address"
                    autoComplete="street-address"
                    maxLength={200}
                    placeholder="Rua, número e bairro"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                  />
                </div>
                <div className={styles.columns}>
                  <div className={styles.field}>
                    <Label htmlFor="viability-latitude">Latitude</Label>
                    <Input
                      id="viability-latitude"
                      inputMode="decimal"
                      placeholder="-3.731900"
                      required
                      value={latitude}
                      onChange={(event) => setLatitude(event.target.value)}
                    />
                  </div>
                  <div className={styles.field}>
                    <Label htmlFor="viability-longitude">Longitude</Label>
                    <Input
                      id="viability-longitude"
                      inputMode="decimal"
                      placeholder="-38.526700"
                      required
                      value={longitude}
                      onChange={(event) => setLongitude(event.target.value)}
                    />
                  </div>
                </div>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={locate}
                    disabled={locating}
                  >
                    {locating ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <LocateFixed />
                    )}
                    Usar minha localização
                  </Button>
                  <Button type="submit">
                    {busy ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <MapPin />
                    )}
                    Consultar viabilidade
                  </Button>
                </div>
              </fieldset>
            </form>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {result && (
              <Alert role="status">
                {result.covered ? <CheckCircle2 /> : <SearchX />}
                <AlertTitle>
                  {result.covered
                    ? "Atendemos este local."
                    : "Ainda não atendemos este local."}
                </AlertTitle>
                <AlertDescription>
                  {result.covered
                    ? "Há estrutura disponível perto do endereço informado. A instalação ainda depende de vistoria técnica."
                    : "Não encontramos estrutura disponível perto do endereço informado. Fale com a equipe para saber das próximas expansões."}
                </AlertDescription>
              </Alert>
            )}
            {result && (phone || whatsapp) && (
              <div className={styles.contact}>
                {whatsapp && (
                  <a
                    className={buttonVariants({ variant: "outline" })}
                    href={whatsapp}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <MessageCircle />
                    Falar no WhatsApp
                  </a>
                )}
                {phone && (
                  <a
                    className={buttonVariants({ variant: "outline" })}
                    href={`tel:${phone.replace(/[^\d+]/g, "")}`}
                  >
                    <Phone />
                    {phone}
                  </a>
                )}
              </div>
            )}
            {result?.covered && result.lead_capture && !leadSent && (
              <form className={styles.form} onSubmit={sendLead}>
                <fieldset disabled={leadBusy}>
                  <p className={styles.eyebrow}>QUERO SER CONTATADO</p>
                  <div className={styles.columns}>
                    <div className={styles.field}>
                      <Label htmlFor="viability-name">Seu nome</Label>
                      <Input
                        id="viability-name"
                        autoComplete="name"
                        required
                        minLength={2}
                        maxLength={120}
                        value={lead.name}
                        onChange={(event) =>
                          setLead({ ...lead, name: event.target.value })
                        }
                      />
                    </div>
                    <div className={styles.field}>
                      <Label htmlFor="viability-phone">Telefone com DDD</Label>
                      <Input
                        id="viability-phone"
                        type="tel"
                        autoComplete="tel"
                        required
                        maxLength={25}
                        value={lead.phone}
                        onChange={(event) =>
                          setLead({ ...lead, phone: event.target.value })
                        }
                      />
                    </div>
                  </div>
                  <label className={styles.consent}>
                    <input
                      type="checkbox"
                      checked={lead.consent}
                      onChange={(event) =>
                        setLead({ ...lead, consent: event.target.checked })
                      }
                    />
                    <span>
                      Autorizo {provider.name} a usar meu nome, telefone e a
                      localização informada para entrar em contato sobre a
                      contratação.
                    </span>
                  </label>
                  {leadError && (
                    <Alert variant="destructive" role="alert">
                      <AlertDescription>{leadError}</AlertDescription>
                    </Alert>
                  )}
                  <div className={styles.actions}>
                    <Button type="submit">
                      {leadBusy && <LoaderCircle className="animate-spin" />}
                      Enviar meus dados
                    </Button>
                  </div>
                </fieldset>
              </form>
            )}
            {leadSent && (
              <Alert role="status">
                <CheckCircle2 />
                <AlertTitle>Recebemos seu contato.</AlertTitle>
                <AlertDescription>
                  A equipe de {provider.name} vai falar com você pelo telefone
                  informado.
                </AlertDescription>
              </Alert>
            )}
            <p className={styles.note}>
              A localização é usada apenas para esta consulta. O resultado
              indica disponibilidade de estrutura e não garante a instalação.
            </p>
          </>
        )}
        <footer className={styles.footer}>
          <span>Consulta pública de viabilidade</span>
          <span>NexoISP</span>
        </footer>
      </section>
    </main>
  );
}
