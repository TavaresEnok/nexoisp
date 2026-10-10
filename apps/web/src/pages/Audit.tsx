import { dt, usePaged } from '../api';
import { Badge, Page, Pager, State } from '../ui';

export function Audit() {
  const list = usePaged<any>('/audit');
  const { data, loading, error } = list;
  return (
    <Page title="Auditoria">
      <State loading={loading} error={error} empty={data?.length === 0}>
        <table>
          <thead><tr><th>Quando</th><th>Autor</th><th>Ação</th><th>Entidade</th><th>Resultado</th><th>Detalhe</th></tr></thead>
          <tbody>{data?.map((a) => (
            <tr key={a.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{dt(a.at)}</td>
              <td>{a.actor_name ?? '—'} <span className="muted small">({a.actor_type === 'user' ? 'usuário' : a.actor_type === 'agent' ? 'agente' : 'rotina'})</span>
                {a.detail?.support_access && <> <Badge tone="red">suporte</Badge></>}</td>
              <td className="mono">{a.action}</td>
              <td className="small">{a.entity_type}{a.entity_id && <span className="muted mono"> {String(a.entity_id).slice(0, 8)}</span>}</td>
              <td>{a.result === 'ok' ? <Badge tone="green">ok</Badge> : <Badge tone="red">{a.result === 'denied' ? 'negado' : a.result}</Badge>}</td>
              <td className="small muted mono" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{Object.keys(a.detail ?? {}).length ? JSON.stringify(a.detail) : ''}</td>
            </tr>
          ))}</tbody>
        </table>
      <Pager p={list} />
      </State>
    </Page>
  );
}
