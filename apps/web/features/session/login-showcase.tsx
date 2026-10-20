import { useEffect, useState, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import styles from "./login.module.css";

const duration = 7000;

function Chip({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "off" | "danger" | "info";
  children: ReactNode;
}) {
  return (
    <span className={`${styles.chip} ${styles[`chip_${tone}`]}`}>
      <i />
      {children}
    </span>
  );
}

function Frame({
  label,
  aside,
  children,
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.frame}>
      <div className={styles.frameHead}>
        <span>{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

const rows = (items: [string, string, ReactNode, string?][]) =>
  items.map(([title, detail, status, time]) => (
    <div className={styles.row} key={title}>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      {time && <span className={styles.time}>{time}</span>}
      {status}
    </div>
  ));

function Access() {
  return (
    <Frame
      label="ONLINE AGORA · 3 CONEXÕES"
      aside={
        <span className={styles.live}>
          <i />
          Atualiza a cada 15 s
        </span>
      }
    >
      {rows([
        [
          "cliente.fibra01",
          "100.64.12.8 · POP Central",
          <Chip key="s" tone="ok">
            Online
          </Chip>,
          "3 d 04 h",
        ],
        [
          "cliente.fibra02",
          "100.64.12.9 · POP Norte",
          <Chip key="s" tone="ok">
            Online
          </Chip>,
          "11 h 20",
        ],
        [
          "cliente.fibra03",
          "Sem sessão desde 08:40",
          <Chip key="s" tone="off">
            Offline
          </Chip>,
          "—",
        ],
      ])}
    </Frame>
  );
}

function NetworkMap() {
  const nodes = [
    { x: 90, y: 58, label: "OLT NORTE" },
    { x: 470, y: 58, label: "OLT SUL" },
    { x: 110, y: 190, label: "CTO 14" },
    { x: 450, y: 190, label: "CTO 22" },
  ];
  return (
    <div className={`${styles.frame} ${styles.map}`}>
      <svg
        viewBox="0 0 560 250"
        role="img"
        aria-label="Exemplo de mapa de rede com POP central, OLTs e caixas ópticas"
      >
        {nodes.map((node, index) => (
          <g key={node.label}>
            <line
              className={index > 1 ? styles.dash : styles.link}
              x1="280"
              y1="125"
              x2={node.x}
              y2={node.y}
            />
            <circle className={styles.pulse} r="3.5">
              <animateMotion
                dur={`${3 + index * 0.6}s`}
                repeatCount="indefinite"
                path={`M280,125 L${node.x},${node.y}`}
              />
            </circle>
            <rect
              className={styles.node}
              x={node.x - 16}
              y={node.y - 16}
              width="32"
              height="32"
              rx="8"
            />
            <circle className={styles.nodeDot} cx={node.x} cy={node.y} r="4" />
            <text
              className={styles.nodeLabel}
              x={node.x}
              y={node.y + 34}
              textAnchor="middle"
            >
              {node.label}
            </text>
          </g>
        ))}
        <rect
          className={styles.hub}
          x="258"
          y="103"
          width="44"
          height="44"
          rx="10"
        />
        <g className={styles.hubIcon}>
          <rect x="268" y="114" width="24" height="8" rx="2" />
          <rect x="268" y="127" width="24" height="8" rx="2" />
        </g>
        <text className={styles.nodeLabel} x="280" y="166" textAnchor="middle">
          POP CENTRAL
        </text>
      </svg>
    </div>
  );
}

function Lookup() {
  return (
    <Frame
      label="OFÍCIO · CONSULTA LEGAL DE IP"
      aside={<Chip tone="info">Registro auditável</Chip>}
    >
      <div className={styles.lookup}>
        <div>
          <small>IP público · porta</small>
          <strong className={styles.mono}>203.0.113.40 : 41872</strong>
        </div>
        <div>
          <small>Instante · fuso</small>
          <strong className={styles.mono}>14:02:11 · −03:00</strong>
        </div>
      </div>
      {rows([
        [
          "Titular fictício da silva",
          "Contrato #A41C9E02 · IP privado 100.64.12.8",
          <Chip key="s" tone="ok">
            Identificado
          </Chip>,
        ],
        [
          "Sessão registrada",
          "Início 13:51 · NAS BRAS-CENTRO",
          <Chip key="s" tone="info">
            Evidência
          </Chip>,
        ],
      ])}
    </Frame>
  );
}

function Orders() {
  return (
    <Frame
      label="ATENDIMENTOS EM CAMPO"
      aside={<span className={styles.aside}>Equipe técnica</span>}
    >
      {rows([
        [
          "#4821 Instalação",
          "Rua das Acácias, 120 · 15:30",
          <Chip key="s" tone="off">
            Agendada
          </Chip>,
        ],
        [
          "#4817 Manutenção",
          "Av. Central, 88 · 14:00",
          <Chip key="s" tone="warn">
            Em execução
          </Chip>,
        ],
        [
          "#4809 Troca de ONU",
          "Rua dos Ipês, 45 · 10:15",
          <Chip key="s" tone="ok">
            Concluída
          </Chip>,
        ],
      ])}
    </Frame>
  );
}

function Billing() {
  return (
    <Frame
      label="FATURAS · OUTUBRO"
      aside={<span className={styles.aside}>R$ 1.249,70 a receber</span>}
    >
      {rows([
        [
          "FAT-8401 · Fibra 500",
          "Venc. 20/10 · Pix",
          <Chip key="s" tone="ok">
            Paga
          </Chip>,
          "R$ 99,90",
        ],
        [
          "FAT-8402 · Fibra 1 Giga",
          "Venc. 25/10",
          <Chip key="s" tone="warn">
            Em aberto
          </Chip>,
          "R$ 149,90",
        ],
        [
          "FAT-8377 · Fibra 200",
          "Venc. 05/10",
          <Chip key="s" tone="danger">
            Vencida
          </Chip>,
          "R$ 79,90",
        ],
      ])}
    </Frame>
  );
}

const slides = [
  {
    tab: "Acessos",
    eyebrow: "01 / CONEXÕES",
    title: "Quem está online, agora.",
    text: "Sessões, IP e tempo conectado de cada assinante, com desconexão controlada pelo servidor.",
    view: <Access />,
  },
  {
    tab: "Mapa",
    eyebrow: "02 / VISIBILIDADE",
    title: "Sua rede, no mapa.",
    text: "Contratos, caixas ópticas e POPs posicionados, com o estado de cada ponto.",
    view: <NetworkMap />,
  },
  {
    tab: "Consulta IP",
    eyebrow: "03 / CONFORMIDADE",
    title: "Resposta a ofícios em minutos.",
    text: "Do IP público e da porta ao titular, com a evidência registrada para auditoria.",
    view: <Lookup />,
  },
  {
    tab: "Ordens",
    eyebrow: "04 / CAMPO",
    title: "Ordens de serviço.",
    text: "Do agendamento à conclusão, com técnico, materiais e histórico de cada visita.",
    view: <Orders />,
  },
  {
    tab: "Cobrança",
    eyebrow: "05 / FINANCEIRO",
    title: "Do boleto à baixa.",
    text: "Faturas, baixa manual, conciliação e liberação por confiança em um só lugar.",
    view: <Billing />,
  },
];

export function LoginShowcase() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const running = !paused && !hover && !reduced;
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(
      () => setIndex((value) => (value + 1) % slides.length),
      duration,
    );
    return () => window.clearTimeout(timer);
  }, [index, running]);
  const slide = slides[index];
  return (
    <section
      className={styles.stage}
      aria-label="Destaques do NexoISP"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <header className={styles.brand}>
        <span className={styles.wordmark}>
          nexo<span>isp</span>
          <i />
        </span>
        <span className={styles.caption}>WORKSPACE</span>
      </header>
      <h2 className={styles.headline}>
        Toda a sua operação.
        <br />
        <em>Em sintonia.</em>
      </h2>
      <div className={styles.slideMeta}>
        <span>{slide.eyebrow}</span>
        <button
          type="button"
          className={styles.pause}
          onClick={() => setPaused((value) => !value)}
          aria-label={paused ? "Retomar apresentação" : "Pausar apresentação"}
        >
          {paused || reduced ? <Play size={12} /> : <Pause size={12} />}
          {paused || reduced ? "Retomar" : "Pausar"}
        </button>
      </div>
      <div
        className={styles.slide}
        key={slide.tab}
        aria-live={running ? "off" : "polite"}
      >
        <h3>{slide.title}</h3>
        <p>{slide.text}</p>
        {slide.view}
        <small className={styles.illustrative}>
          Exemplo ilustrativo · dados fictícios
        </small>
      </div>
      <nav className={styles.tabs} aria-label="Escolher destaque">
        {slides.map((item, position) => (
          <button
            key={item.tab}
            type="button"
            className={position === index ? styles.tabActive : undefined}
            aria-current={position === index}
            onClick={() => setIndex(position)}
          >
            <span className={styles.bar}>
              <i
                key={position === index ? `run-${index}` : "idle"}
                style={{
                  animationDuration: `${duration}ms`,
                  animationPlayState: running ? "running" : "paused",
                  width:
                    position < index || (position === index && reduced)
                      ? "100%"
                      : undefined,
                }}
              />
            </span>
            {item.tab}
          </button>
        ))}
      </nav>
    </section>
  );
}
