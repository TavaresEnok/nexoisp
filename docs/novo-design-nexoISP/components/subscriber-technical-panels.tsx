"use client";

import { Activity, ArrowUpRight, Cable, Copy, LockKeyhole, Network, Radio, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProfileFacts, ProfileSection } from "@/components/subscriber-profile-sections";
import { byteLabel, durationLabel, type OnuEvidence, type RadiusRecord } from "@/lib/subscriber-diagnostics";
import type { Subscriber } from "@/lib/types";

export const unavailable = "Não informado";
export function TechnicalHeading({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="technical-heading"><div><span className="eyebrow">OPERAÇÃO DO ACESSO</span><h3>{title}</h3><p>{description}</p></div>{action}</div>;
}
export function OpticalMetrics({ evidence, storedRx }: { evidence: OnuEvidence | null; storedRx?: number }) {
  const metrics = [
    { label: "RX na ONU", value: evidence ? evidence.rx : storedRx, unit: "dBm", detail: evidence ? "Saída informada" : "Cadastro · sem horário de coleta" },
    { label: "TX da ONU", value: evidence?.tx, unit: "dBm", detail: "Potência transmitida" },
    { label: "RX na OLT", value: evidence?.oltRx, unit: "dBm", detail: "Retorno óptico da ONU" },
    { label: "Temperatura", value: evidence?.temperature, unit: "°C", detail: "Módulo óptico" },
    { label: "Tensão", value: evidence?.voltage, unit: "V", detail: "Alimentação do módulo" },
    { label: "Corrente do laser", value: evidence?.laser, unit: "mA", detail: "Laser bias current" },
  ];
  return <div className="technical-metrics">{metrics.map(metric => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value !== undefined ? metric.value.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : "—"}<small>{metric.value !== undefined ? metric.unit : ""}</small></strong><p>{metric.value !== undefined ? metric.detail : "Aguardando coleta manual"}</p></div>)}</div>;
}
export function AccessSession({ subscriber: s, session }: { subscriber: Subscriber; session?: RadiusRecord }) {
  const time = (value?: string | null) => value ? new Date(value).toLocaleString("pt-BR") : unavailable;
  return <ProfileSection title="Sessão de acesso · RADIUS" caption="Accounting e cadastro são fontes distintas; nenhum estado é consultado ao abrir a ficha." action={<Badge variant="outline">{session ? "Evidência manual" : "Sem accounting"}</Badge>}><ProfileFacts items={[
    ["Login de autenticação", session?.username ?? unavailable], ["Protocolo da sessão", session ? "Não consta no accounting" : unavailable],
    ["Concentrador cadastrado", s.nas], ["IP do NAS na sessão", session?.nasipaddress ?? unavailable],
    ["IPv4 atribuído", session?.framedipaddress ?? unavailable], ["Prefixo IPv6 / PD", session?.delegatedipv6prefix ?? unavailable],
    ["MAC autenticado", session?.callingstationid ?? unavailable], ["Porta lógica / NAS-Port-ID", session?.nasportid ?? unavailable],
    ["Início da sessão", time(session?.acctstarttime)], ["Tempo contabilizado", durationLabel(session?.acctsessiontime)],
    ["Session-ID", session?.acctsessionid ?? unavailable], ["Encerramento", session ? session.acctstoptime ? time(session.acctstoptime) : "Sem encerramento no arquivo" : unavailable],
  ]} /><p className="profile-footnote">{session ? "Uma sessão sem encerramento no arquivo não comprova conexão ativa neste momento." : "O estado comercial e o estado registrado do acesso não comprovam uma sessão ativa no NAS."}</p></ProfileSection>;
}
export function OnuIdentity({ subscriber: s, evidence, copy }: { subscriber: Subscriber; evidence: OnuEvidence | null; copy: (value: string) => void }) {
  const f = evidence?.fields ?? {};
  return <ProfileSection title="Identidade e localização FTTx" caption="Vínculo físico e provisionamento da ONU; dados ausentes não são deduzidos pelo POP."><div className="technical-path"><span><Network size={15} />{s.pop}</span><span aria-hidden="true">→</span><span>OLT não vinculada</span><span aria-hidden="true">→</span><span><Cable size={15} />{f["f/s/p"] ?? "PON não informada"}</span><span aria-hidden="true">→</span><span>ONU {f["ont-id"] ?? "—"}</span></div><ProfileFacts items={[
    ["Serial cadastrado", <span className="profile-copy mono" key="serial">{s.onu || unavailable}{s.onu && <button aria-label="Copiar serial da ONU" onClick={() => copy(s.onu)}><Copy size={13} /></button>}</span>],
    ["Serial da evidência", evidence?.serial ?? unavailable], ["OLT / IP de gerência", "Não vinculados"], ["Frame / slot / PON", f["f/s/p"] ?? unavailable],
    ["ONT-ID", f["ont-id"] ?? unavailable], ["Modelo / equipamento", f["equipmentid"] ?? f["equipment-id"] ?? unavailable],
    ["Versão de software", f["main software version"] ?? f["software version"] ?? unavailable], ["Distância óptica", evidence?.distance !== undefined ? `${evidence.distance.toLocaleString("pt-BR")} m` : unavailable],
    ["Autenticação", f["authentic type"] ?? unavailable], ["Gerenciamento", f["management mode"] ?? unavailable],
    ["CTO / porta", "Não cadastradas"], ["VLAN / service-port", "Não cadastrados"],
  ]} /></ProfileSection>;
}
export function OnuState({ evidence }: { evidence: OnuEvidence | null }) {
  const f = evidence?.fields ?? {};
  const cause = f["last down cause"];
  return <ProfileSection title="Estado, estabilidade e última queda" caption="Valores extraídos da saída informada, não de uma consulta em tempo real."><ProfileFacts items={[
    ["Run state", f["run state"] ?? unavailable], ["Control flag", f["control flag"] ?? unavailable],
    ["Config state", f["config state"] ?? unavailable], ["Match state", f["match state"] ?? unavailable],
    ["Última subida", f["last up time"] ?? unavailable], ["Última queda", f["last down time"] ?? unavailable],
    ["Último dying-gasp", f["last dying gasp time"] ?? unavailable], ["Tempo online informado", f["ont online duration"] ?? unavailable],
    ["Motivo da última queda", cause ?? unavailable], ["Isolamento", f["isolation state"] ?? unavailable],
    ["CPU da ONU", f["cpu occupation"] ?? unavailable], ["Memória da ONU", f["memory occupation"] ?? unavailable],
  ]} />{cause && <p className="profile-footnote">{cause.toLowerCase() === "dying-gasp" ? "Dying-gasp: a ONU reportou perda de alimentação. É um indício, não confirmação de falha elétrica no local." : "Interprete o motivo com os alarmes e as demais evidências. Uma queda isolada não define a causa raiz."}</p>}</ProfileSection>;
}
export function TechnicalParameters({ subscriber: s }: { subscriber: Subscriber }) {
  return <><TechnicalHeading title="Parâmetros do serviço" description="Contrato, autenticação, endereçamento e CPE organizados por camada." /><div className="profile-two-columns"><ProfileSection title="Autenticação e banda" caption="Configuração registrada, não resultado de teste de velocidade."><ProfileFacts items={[["Contrato", s.contract], ["Plano", s.plan], ["Download contratado", `${s.speed} Mbps`], ["Upload contratado", unavailable], ["Tipo de acesso", unavailable], ["NAS cadastrado", s.nas], ["Perfil RADIUS / rate-limit", unavailable], ["Logins simultâneos", unavailable], ["MAC fixo / automático", unavailable], ["Grupo SLA", unavailable]]} /></ProfileSection><ProfileSection title="Endereçamento e encaminhamento" caption="Nenhum IP, pool ou prefixo é deduzido a partir do concentrador."><ProfileFacts items={[["IPv4 fixo", unavailable], ["Pool IPv4 / CGNAT", unavailable], ["Blocos roteados", unavailable], ["Address-list", unavailable], ["Prefixo IPv6", unavailable], ["IPv6 PD / pool", unavailable], ["VLAN de serviço", unavailable], ["VLAN secundária", unavailable]]} /></ProfileSection></div><ProfileSection title="CPE, Wi-Fi e gerência" caption="Inventário e credenciais não estão vinculados ao cadastro atual."><ProfileFacts items={[["Modo bridge / router", unavailable], ["Gerenciador ACS / TR-069", unavailable], ["Modelo / firmware do roteador", unavailable], ["SSID 2,4 GHz / canal", unavailable], ["SSID 5 GHz / canal", unavailable], ["Acesso remoto", "Não configurado nesta tela"], ["ONU template", unavailable], ["Tipo de aquisição / comodato", unavailable]]} /><p className="profile-footnote"><LockKeyhole size={13} /> Senhas PPPoE, Wi-Fi e de gerência não são expostas nesta ficha.</p></ProfileSection></>;
}
export function OperationalActions({ navigate, pop, onDiagnose }: { navigate: (href: string) => void; pop: string; onDiagnose: () => void }) {
  return <ProfileSection title="Ferramentas do analista" caption="Leitura e análise disponíveis. Mudanças de serviço exigem um executor autorizado."><div className="technical-action-grid"><Button variant="outline" onClick={onDiagnose}><Activity data-icon="inline-start" />Preparar diagnóstico</Button><Button variant="outline" onClick={() => navigate(`/rede/equipamentos?busca=${encodeURIComponent(pop)}`)}><Network data-icon="inline-start" />Contexto do POP<ArrowUpRight data-icon="inline-end" /></Button></div><div className="technical-capabilities">{[[Radio, "Sessão e alcance", "Ping, tráfego, CoA e desconexão"], [Cable, "ONU e provisionamento", "Reiniciar, reautorizar e alterar serviço"], [ShieldCheck, "CPE e segurança", "Wi-Fi e acesso remoto"]].map(([Icon, title, detail]) => { const IconComponent = Icon as typeof Radio; return <div key={String(title)}><IconComponent size={16} /><span><strong>{String(title)}</strong><small>{String(detail)}</small></span><LockKeyhole size={13} /></div>; })}</div><p className="profile-footnote">Ações remotas indisponíveis sem conector, permissões e auditoria. Nenhum comando de alteração é gerado.</p></ProfileSection>;
}
export function RadiusTable({ records }: { records: RadiusRecord[] }) {
  return <div className="profile-table-scroll"><table className="profile-table"><caption className="sr-only">Sessões RADIUS do arquivo analisado</caption><thead><tr><th>Início / sessão</th><th>NAS / IPv4 / MAC</th><th>Duração</th><th>Encerramento / causa</th><th>Entrada / saída no NAS</th></tr></thead><tbody>{records.map(row => <tr key={row.acctsessionid}><td><strong>{new Date(row.acctstarttime).toLocaleString("pt-BR")}</strong><small className="mono">{row.acctsessionid}</small></td><td><strong className="mono">{row.nasipaddress}</strong><small className="mono">{row.framedipaddress ?? "IPv4 não informado"}<br />{row.callingstationid ?? "MAC não informado"}</small></td><td>{durationLabel(row.acctsessiontime)}</td><td><strong>{row.acctstoptime ? new Date(row.acctstoptime).toLocaleString("pt-BR") : "Sem encerramento no arquivo"}</strong><small>{row.acctterminatecause ?? "Sem causa informada"}</small></td><td>{byteLabel(row.acctinputoctets)} / {byteLabel(row.acctoutputoctets)}</td></tr>)}</tbody></table></div>;
}
