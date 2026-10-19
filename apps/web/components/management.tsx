"use client";

import { useState } from "react";
import Link from "@/platform/navigation/link";
import {
  ArrowUpRight,
  Download,
  ShieldCheck,
  Database,
  Network,
  MessageCircle,
  CircleDollarSign,
  Users,
  Building2,
  Mail,
  Info,
  Check,
  ArrowRight,
  Activity,
  Radio,
  Wrench,
  Headphones,
  Cable,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import {
  Panel,
  PageHeading,
  Status,
  SourceFooter,
  DemoNotice,
} from "@/components/workspace-ui";
import { useWorkspace } from "@/components/workspace-provider";
import { money, exportCsv, number } from "@/lib/format";
import { selectActivities, selectReportIndicators } from "@/application/selectors/reports";
import { isDemoMode } from "@/application/execution-mode";

export function Reports() {
  const { data, openSubscriber } = useWorkspace();
  const [tab, setTab] = useState("atividade");
  const [category, setCategory] = useState("Todos");
  const filtered = selectActivities(data.activities, category);
  const indicators = selectReportIndicators(data.snapshot);
  return (
    <>
      <PageHeading
        eyebrow="INFORMAÇÃO QUE FAZ SENTIDO"
        title="Do movimento à perspectiva."
        description="Uma leitura compartilhada do que aconteceu e do que merece atenção."
        actions={
          <Button
            variant="outline"
            onClick={() =>
              exportCsv(
                tab === "atividade"
                  ? "nexo-atividades-demonstrativas"
                  : "nexo-indicadores-demonstrativos",
                tab === "atividade"
                  ? ["Horário", "Evento", "Contexto"]
                  : ["Indicador", "Valor", "Definição"],
                tab === "atividade"
                  ? filtered.map((a) => [a.time, a.title, a.description])
                  : indicators,
              )
            }
          >
            <Download data-icon="inline-start" />
            Exportar {tab === "atividade" ? "histórico" : "indicadores"}
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList variant="line">
          <TabsTrigger value="atividade">Movimentos da operação</TabsTrigger>
          <TabsTrigger value="indicadores">
            Dicionário de indicadores
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "atividade" ? (
        <Panel
          title="Uma operação. Uma história."
          description="Linha do tempo do cenário, sem confundir atividade com auditoria"
          action={<Badge variant="outline">17 out. 2026</Badge>}
          className="reports-panel"
        >
          <div className="report-filters">
            <Tabs
              value={category}
              onValueChange={(v) => setCategory(String(v))}
            >
              <TabsList variant="line">
                <TabsTrigger value="Todos">Tudo</TabsTrigger>
                <TabsTrigger value="payment">Financeiro</TabsTrigger>
                <TabsTrigger value="network">Rede</TabsTrigger>
                <TabsTrigger value="order">Campo</TabsTrigger>
                <TabsTrigger value="ticket">Atendimento</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="report-timeline">
            {filtered.map((a) => {
              const Icon =
                a.type === "payment"
                  ? CircleDollarSign
                  : a.type === "network"
                    ? Radio
                    : a.type === "order"
                      ? Wrench
                      : a.type === "ticket"
                        ? Headphones
                        : Users;
              return (
                <div key={a.id}>
                  <time>
                    {a.time}
                    <small>17 OUT</small>
                  </time>
                  <span className="report-event-icon">
                    <Icon size={19} />
                  </span>
                  <div>
                    <strong>{a.title}</strong>
                    <p>{a.description}</p>
                  </div>
                  {a.subscriberId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openSubscriber(a.subscriberId!)}
                    >
                      Ver assinante
                      <ArrowUpRight data-icon="inline-end" />
                    </Button>
                  ) : (
                    <Link
                      href="/rede/equipamentos?filtro=atencao"
                      className={buttonVariants({
                        variant: "ghost",
                        size: "sm",
                      })}
                    >
                      Ver rede
                      <ArrowUpRight data-icon="inline-end" />
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      ) : (
        <Panel
          title="O que cada número quer dizer"
          description="Definições explícitas para evitar decisões com métricas ambíguas"
        >
          <div className="indicator-dictionary">
            {indicators.map(([label, value, description]) => (
              <div key={label}>
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
                <b className="mono">{value}</b>
              </div>
            ))}
          </div>
        </Panel>
      )}
      <DemoNotice>
        Este histórico exibe eventos fictícios de demonstração. Não é uma trilha
        de auditoria de ações de usuários.
      </DemoNotice>
      <SourceFooter sample="Histórico demonstrativo" />
    </>
  );
}

export function Settings() {
  const [about, setAbout] = useState(false);
  return (
    <>
      <PageHeading
        eyebrow="UMA BASE PARA CONECTAR"
        title="Seu workspace, com clareza."
        description="Entenda o ambiente, a origem dos dados e os limites da demonstração."
        actions={
          <Badge variant="outline">
            <ShieldCheck data-icon="inline-start" />
            Somente leitura
          </Badge>
        }
      />
      <div className="settings-layout">
        <Panel
          title="Identidade do provedor"
          description="Informações ilustrativas do workspace"
        >
          <div className="settings-provider">
            <span className="provider-avatar">
              <Building2 size={25} />
            </span>
            <div>
              <strong>Conecta Fibra</strong>
              <p>Workspace de demonstração do NexoISP</p>
            </div>
            <Badge variant="secondary">Demonstração</Badge>
          </div>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider-name">Nome do provedor</FieldLabel>
              <Input id="provider-name" value="Conecta Fibra" readOnly />
              <FieldDescription>
                Nome fictício utilizado apenas para avaliação.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-email">
                Contato demonstrativo
              </FieldLabel>
              <Input
                id="provider-email"
                value="operacao@example.com"
                readOnly
              />
            </Field>
          </FieldGroup>
          <div className="settings-note">
            <ShieldCheck size={17} />
            <p>
              Não há uma conta de administrador autenticada. O perfil
              apresentado faz parte da demonstração visual.
            </p>
          </div>
        </Panel>
        <Panel
          title="Conectado não é o mesmo que integrado"
          description="O estado real de cada fonte neste ambiente"
        >
          <div className="integration-list">
            {[
              {
                name: isDemoMode ? "Cenário demonstrativo local" : "Neon Postgres",
                detail: isDemoMode ? "Dados fictícios validados · sem consulta remota" : "Base demonstrativa persistida · consulta real",
                icon: Database,
                status: isDemoMode ? "Somente leitura" : "Conectado",
              },
              {
                name: "RADIUS / PPPoE / OLT",
                detail: "Telemetria sintética · sem equipamentos reais",
                icon: Network,
                status: "Não conectado",
              },
              {
                name: "Bancos e cobrança",
                detail: "Sem transações, emissão ou baixa de faturas",
                icon: CircleDollarSign,
                status: "Não conectado",
              },
              {
                name: "WhatsApp e telefonia",
                detail: "Sem envio ou recebimento de mensagens",
                icon: MessageCircle,
                status: "Não conectado",
              },
            ].map((i) => (
              <div key={i.name}>
                <span className="integration-icon">
                  <i.icon size={19} />
                </span>
                <span>
                  <strong>{i.name}</strong>
                  <small>{i.detail}</small>
                </span>
                <Status value={i.status} />
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel
        title="Uma demonstração honesta. Uma evolução responsável."
        description="O que está pronto e o que uma implantação de produção exige"
        action={
          <Button variant="outline" onClick={() => setAbout(true)}>
            Entender a implantação
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        }
      >
        <div className="readiness-grid">
          <div>
            <span className="summary-icon">
              <Check size={20} />
            </span>
            <h3>Pronto para explorar</h3>
            <p>
              Navegação, busca global, filtros, exportação CSV e ficha integrada. {isDemoMode ? "Os registros fictícios vêm exclusivamente do cenário local validado." : "Os registros fictícios vêm de uma base Neon real."}
            </p>
          </div>
          <div>
            <span className="summary-icon">
              <ShieldCheck size={20} />
            </span>
            <h3>Segurança antes da escrita</h3>
            <p>
              Cadastros e alterações não estão expostos. A operação real exige
              autenticação, isolamento por provedor e permissões no servidor.
            </p>
          </div>
          <div>
            <span className="summary-icon">
              <Cable size={20} />
            </span>
            <h3>Integrações com responsabilidade</h3>
            <p>
              Ações de rede, cobrança e comunicação precisam de credenciais,
              validação e uma trilha de auditoria antes de serem habilitadas.
            </p>
          </div>
        </div>
      </Panel>
      <SourceFooter sample="Configuração demonstrativa" />
      <Dialog open={about} onOpenChange={setAbout}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Da avaliação à sua operação</DialogTitle>
            <DialogDescription>
              O protótipo não deve receber dados reais de clientes ainda.
            </DialogDescription>
          </DialogHeader>
          <ol className="resolution-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Identidade e acesso</strong>
                <p>
                  Adicionar autenticação real, empresas, perfis e permissões
                  verificadas no servidor.
                </p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Importação com validação</strong>
                <p>
                  Definir o modelo de assinantes, contratos e cobranças e
                  importar os dados com revisão.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Conectar cada sistema</strong>
                <p>
                  Integrar equipamentos, banco e mensageria com logs,
                  confirmação de ações críticas e auditoria.
                </p>
              </div>
            </li>
          </ol>
          <Button variant="outline" onClick={() => setAbout(false)}>
            Continuar explorando
            <ArrowRight data-icon="inline-end" />
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
