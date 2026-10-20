import { Link } from "react-router-dom";
import { Building2, ShieldCheck } from "lucide-react";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FormField } from "@/features/shared/form";
import { useSession } from "@/features/session/provider";
import { roleLabels } from "@/features/session/model";
import { canAccessPath } from "./navigation";
export function OperationalSettings() {
  const { me } = useSession();
  const links = [
    ["/conta", "Minha conta e segurança"],
    ["/administracao/usuarios", "Equipe e permissões"],
    ["/administracao/empresas", "Empresas faturadoras"],
    ["/financeiro/politica-de-cobranca", "Política de cobrança"],
    ["/administracao/avisos", "Avisos à equipe"],
    ["/administracao/avisos-assinante", "Avisos ao assinante"],
    ["/administracao/integracoes", "Integrações"],
    ["/administracao/catalogos-sla", "Catálogos e qualidade"],
    ["/auditoria", "Auditoria e retenção"],
  ];
  return (
    <>
      <PageHeading
        title="Seu workspace, com clareza."
        description="Identidade da sessão e configurações disponíveis para o seu perfil."
      />
      <div className="settings-layout">
        <Panel
          title="Identidade do provedor"
          description="Contexto autenticado pelo ERP."
        >
          <div className="settings-provider">
            <span className="provider-avatar">
              <Building2 size={25} />
            </span>
            <div>
              <strong>{me?.tenant?.name ?? "Plataforma NexoISP"}</strong>
              <p>{me?.tenant?.slug ?? "Gestão de provedores"}</p>
            </div>
            <Badge variant="outline">
              {me?.demo ? "Demonstração do servidor" : "Operacional"}
            </Badge>
          </div>
          <FormField label="Usuário autenticado">
            <Input readOnly value={me?.name ?? ""} />
          </FormField>
          <FormField label="E-mail da conta">
            <Input readOnly value={me?.email ?? ""} />
          </FormField>
          <div className="settings-note">
            <ShieldCheck size={17} />
            <p>
              {me ? roleLabels[me.role] : ""} · Permissões, módulos e dados são
              conferidos no servidor em cada operação.
            </p>
          </div>
        </Panel>
        <Panel
          title="Configurações disponíveis"
          description="Abra o recurso para consultar ou alterar suas configurações autorizadas."
        >
          <div className="erp-stack">
            {links
              .filter(([path]) => canAccessPath(me, path))
              .map(([path, label]) => (
                <Link key={path} to={path} className="profile-text-action">
                  {label}
                </Link>
              ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
