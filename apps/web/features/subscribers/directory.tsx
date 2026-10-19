import { useState } from "react";
import useSWR from "swr";
import { useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  Users,
  UserCheck,
  UserX,
  FileText,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  PageHeading,
  Panel,
  Status,
  PersonAvatar,
  ActiveFilters,
} from "@/components/workspace-ui";
import { EmptyState } from "@/components/workspace-feedback";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { download } from "@/platform/erp-client";
import { readSubscribers, subscriberQuery } from "@/data/erp/subscribers";
import { SubscriberEditor } from "./form";
export function SubscriberDirectory() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const query = params.get("busca") ?? "";
  const status = ["active", "inactive"].includes(params.get("cadastro") ?? "")
    ? params.get("cadastro")!
    : "";
  const rawPage = Number(params.get("pagina") ?? "1");
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage - 1 : 0;
  const path = subscriberQuery({ query, status, page });
  const list = useSWR(["erp-subscribers", path], ([, path]) =>
    readSubscribers(path),
  );
  const change = (values: Record<string, string | null>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(values))
          value ? next.set(key, value) : next.delete(key);
        return next;
      },
      { replace: true },
    );
  const open = (id: string) => change({ ficha: id, abaFicha: null });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 8));
  const exportRows = async () => {
    setExporting(true);
    try {
      await download(
        `/subscribers?${new URLSearchParams({ q: query, ...(status ? { status } : {}), format: "csv", limit: "5000" })}`,
        "assinantes.csv",
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
      <PageHeading
        title="Assinantes"
        description="Cadastro, contratos e atendimento. Todo o contexto em uma única ficha."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void exportRows()}
              disabled={exporting}
            >
              <Download />
              {exporting ? "Exportando…" : "Exportar CSV"}
            </Button>
            {can(me, "subscribers:write") && (
              <Button onClick={() => setCreating(true)}>
                <Plus />
                Novo assinante
              </Button>
            )}
          </>
        }
      />
      <ConnectedNotice demo={me?.demo} />
      <QueryBoundary
        loading={list.isLoading}
        error={list.error}
        retry={() => list.mutate()}
      >
        <div className="subscriber-summary">
          {[
            { icon: Users, value: total, label: "cadastros na consulta" },
            {
              icon: UserCheck,
              value: rows.filter((row) => row.status === "active").length,
              label: "ativos nesta página",
            },
            {
              icon: UserX,
              value: rows.filter((row) => row.status === "inactive").length,
              label: "inativos nesta página",
            },
            {
              icon: FileText,
              value: rows.reduce(
                (total, row) => total + (row.active_contracts ?? 0),
                0,
              ),
              label: "contratos ativos nesta página",
            },
          ].map(({ icon: Icon, value, label }) => (
            <div key={label}>
              <span className="summary-icon">
                <Icon size={19} />
              </span>
              <span>
                <strong>{value}</strong>
                <small>{label}</small>
              </span>
            </div>
          ))}
        </div>
      </QueryBoundary>
      <Panel
        title="Uma base. Todas as conexões."
        description="Dados cadastrais do provedor"
        action={
          <Badge variant="outline">
            {list.data ? `${total} registros` : "Consulta"}
          </Badge>
        }
        className="list-panel"
      >
        <div className="list-toolbar">
          <Tabs
            value={status || "all"}
            onValueChange={(value) =>
              change({
                cadastro: value === "all" ? null : String(value),
                pagina: null,
              })
            }
          >
            <TabsList variant="line">
              <TabsTrigger value="all">Todos</TabsTrigger>
              <TabsTrigger value="active">Ativos</TabsTrigger>
              <TabsTrigger value="inactive">Inativos</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="table-tools">
            <InputGroup className="subscriber-search">
              <InputGroupInput
                value={query}
                onChange={(event) =>
                  change({ busca: event.target.value || null, pagina: null })
                }
                placeholder="Nome, documento, e-mail ou telefone…"
                aria-label="Buscar assinantes"
              />
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
            </InputGroup>
          </div>
        </div>
        <ActiveFilters
          count={total}
          onClear={() => change({ busca: null, cadastro: null, pagina: null })}
          filters={[
            ...(query
              ? [
                  {
                    label: `Busca: ${query}`,
                    onRemove: () => change({ busca: null, pagina: null }),
                  },
                ]
              : []),
            ...(status
              ? [
                  {
                    label: `Cadastro: ${status === "active" ? "Ativo" : "Inativo"}`,
                    onRemove: () => change({ cadastro: null, pagina: null }),
                  },
                ]
              : []),
          ]}
        />
        <QueryBoundary
          loading={list.isLoading}
          error={list.error}
          retry={() => list.mutate()}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="checkbox-column">#</TableHead>
                <TableHead>Assinante</TableHead>
                <TableHead>CPF/CNPJ</TableHead>
                <TableHead>Cadastro</TableHead>
                <TableHead>Localidade</TableHead>
                <TableHead className="text-right">Contratos ativos</TableHead>
                <TableHead>
                  <span className="sr-only">Abrir ficha</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="mono subtle">
                    {row.id.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    <button
                      className="table-person"
                      onClick={() => open(row.id)}
                    >
                      <PersonAvatar name={row.name} />
                      <span>
                        <strong>{row.name}</strong>
                        <small>
                          {row.email || row.phone || "Sem contato principal"}
                        </small>
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className="mono">{row.document || "—"}</TableCell>
                  <TableCell>
                    <Status
                      value={row.status === "active" ? "Ativo" : "Inativo"}
                    />
                  </TableCell>
                  <TableCell className="subtle">
                    {[row.address_city, row.address_state]
                      .filter(Boolean)
                      .join(" / ") || "—"}
                  </TableCell>
                  <TableCell className="text-right mono">
                    {row.active_contracts ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => open(row.id)}
                      aria-label={`Abrir ficha de ${row.name}`}
                    >
                      <ArrowUpRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!rows.length && (
            <EmptyState
              icon={Search}
              title="Nenhum assinante encontrado."
              description="Tente outro termo ou remova os filtros."
            />
          )}
        </QueryBoundary>
        <div className="erp-pagination">
          <span>
            {total} registro(s) · página {page + 1} de {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0 || list.isLoading}
            onClick={() => change({ pagina: page === 1 ? null : String(page) })}
          >
            <ChevronLeft />
            Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= pages || list.isLoading}
            onClick={() => change({ pagina: String(page + 2) })}
          >
            Próxima
            <ChevronRight />
          </Button>
        </div>
      </Panel>
      {creating && (
        <SubscriberEditor
          onClose={() => setCreating(false)}
          onDone={async (id) => {
            setCreating(false);
            await list.mutate();
            open(id);
          }}
        />
      )}
    </>
  );
}
