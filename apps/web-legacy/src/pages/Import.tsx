import { useState } from 'react';
import { api, dt, money, useLoad } from '../api';
import { ActionButton, Badge, Card, Field, Modal, Page, State, toast } from '../ui';

const STATUS: Record<string, [string, 'green' | 'blue' | 'gray' | 'red']> = { created: ['novo', 'green'], updated: ['atualizado', 'blue'], unchanged: ['sem alteração', 'gray'], error: ['erro', 'red'] };

function Totals({ t, kind }: { t: any; kind: string }) {
  return (
    <div className="row small" style={{ gap: 14 }}>
      <span><b>{t.rows}</b> linha(s)</span><span><Badge tone="green">{t.created} novo(s)</Badge></span><span><Badge tone="blue">{t.updated} atualizado(s)</Badge></span>
      <span><Badge>{t.unchanged} sem alteração</Badge></span><span><Badge tone={t.error ? 'red' : 'gray'}>{t.error} com erro</Badge></span>
      {kind === 'subscribers' ? <span>{t.contracts_created} contrato(s) · {t.accounts_created} conta(s) PPPoE{t.accounts_without_secret > 0 && <b style={{ color: 'var(--red)' }}> · {t.accounts_without_secret} sem senha</b>}</span>
        : kind === 'history' ? <span>{t.history_tickets ?? 0} atendimento(s) · {t.history_work_orders ?? 0} OS · {t.history_notes ?? 0} anotação(ões)</span>
        : <span>soma dos novos títulos: <b>{money(t.amount_cents_total)}</b></span>}
    </div>
  );
}
function Rows({ rows }: { rows: any[] }) {
  if (!rows.length) return <div className="state">Nenhuma linha com erro ou aviso.</div>;
  return (
    <table>
      <thead><tr><th>Linha</th><th>Id externo</th><th>Resultado</th><th>Mensagens</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.row}><td>{r.row}</td><td className="mono">{r.external_id ?? '—'}</td><td><Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge></td><td className="small">{r.messages.join(' · ')}</td></tr>)}</tbody>
    </table>
  );
}

export function Import() {
  const batches = useLoad<any[]>('/import/batches');
  const devices = useLoad<any[]>('/devices');
  const plans = useLoad<any[]>('/plans');
  const [kind, setKind] = useState('subscribers');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [mapping, setMapping] = useState<Record<string, string> | undefined>();
  const [planMap, setPlanMap] = useState<Record<string, string>>({});
  const [pv, setPv] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const body = (m = mapping, pm = planMap) => ({ kind, filename: file!.name, csv: file!.text, device_id: deviceId || null, mapping: m, plan_map: pm });
  const run = async (apply: boolean, m = mapping, pm = planMap) => {
    setBusy(true); setErr(null);
    try {
      const r = await api(`/import/${apply ? 'apply' : 'preview'}`, { body: body(m, pm) });
      setPv(r);
      setMapping(Object.fromEntries(Object.entries(r.mapping).filter(([, v]) => v)) as any);
      if (apply) batches.reload();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const reset = () => { setPv(null); setMapping(undefined); setPlanMap({}); };
  return (
    <Page title="Importação de dados">
      <Card title="1. Arquivo">
        <p className="small muted" style={{ marginTop: 0 }}>Formato CSV intermediário do NexoISP (ver <span className="mono">docs/importacao-csv.md</span>). <b>Não é o formato nativo do MK-Auth</b>: a exportação precisa ser convertida para estas colunas ou mapeada abaixo.</p>
        <div className="cols3">
          <Field label="Conteúdo">
            <select value={kind} onChange={(e) => { setKind(e.target.value); reset(); }}>
              <option value="subscribers">Assinantes, contratos e contas PPPoE</option><option value="invoices">Títulos em aberto</option>
              <option value="history">Histórico: atendimentos, OS e anotações</option>
            </select>
          </Field>
          <Field label="Arquivo CSV">
            <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setFile({ name: f.name, text: await f.text() }); reset(); } }} />
          </Field>
          {kind === 'subscribers' && (
            <Field label="Equipamento para as contas PPPoE" hint="Sem equipamento, as contas PPPoE não são criadas.">
              <select value={deviceId} onChange={(e) => { setDeviceId(e.target.value); setPv(null); }}>
                <option value="">Não criar contas PPPoE</option>
                {devices.data?.filter((d) => !d.driver.startsWith('olt')).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        <button className="primary" disabled={!file || busy} onClick={() => run(false)}>{busy ? 'Processando…' : 'Simular importação (não grava)'}</button>
        {err && <div className="state err">{err}</div>}
      </Card>
      {pv && (<>
        <Card title="2. Mapa de campos">
          {pv.missing_required.length > 0 && <div className="state err">Colunas obrigatórias sem correspondência: {pv.missing_required.join(', ')}. Indique abaixo a coluna do arquivo para cada uma.</div>}
          <div className="kv">
            {pv.fields.map((f: string) => (
              <label key={f} className="field"><span>{f}</span>
                <select value={mapping?.[f] ?? ''} onChange={(e) => { const m = { ...(mapping ?? {}), [f]: e.target.value }; setMapping(m); }}>
                  <option value="">(não importar)</option>
                  {pv.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          {pv.totals.plans_unmatched.length > 0 && (<>
            <h3 style={{ margin: '10px 0 6px' }}>Planos do arquivo sem correspondência</h3>
            {pv.totals.plans_unmatched.map((name: string) => (
              <div key={name} className="row" style={{ marginBottom: 6 }}>
                <span className="mono" style={{ minWidth: 220 }}>{name}</span> →
                <select style={{ maxWidth: 300 }} value={planMap[name] ?? ''} onChange={(e) => setPlanMap({ ...planMap, [name]: e.target.value })}>
                  <option value="">(deixar com erro)</option>
                  {plans.data?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} — {money(p.price_cents)}</option>)}
                </select>
              </div>
            ))}
          </>)}
          <button disabled={busy} onClick={() => run(false)}>Simular novamente com este mapa</button>
        </Card>
        <Card title={pv.applied ? '3. Resultado da importação' : '3. Prévia — nada foi gravado'}>
          <Totals t={pv.totals} kind={kind} />
          {pv.applied
            ? <div className="state" style={{ background: 'var(--green-bg)', color: 'var(--green)', borderRadius: 8, textAlign: 'left', margin: '10px 0' }}>Importação aplicada. Linhas com erro não foram gravadas; corrija o arquivo e reimporte — os já importados não serão duplicados.</div>
            : pv.missing_required.length === 0 && (
              <div className="row" style={{ margin: '10px 0' }}>
                <ActionButton className="primary" confirm={`Aplicar a importação? ${pv.totals.created} novo(s), ${pv.totals.updated} atualizado(s), ${pv.totals.error} linha(s) com erro ficarão de fora.`} onClick={() => run(true)}>Aplicar importação</ActionButton>
                <span className="small muted">Confira quantidades e valores antes de aplicar.</span>
              </div>
            )}
          <Rows rows={pv.rows} />
        </Card>
      </>)}
      <Card title="Lotes importados">
        <State loading={batches.loading} error={batches.error} empty={batches.data?.length === 0}>
          <table>
            <thead><tr><th>Quando</th><th>Arquivo</th><th>Conteúdo</th><th>Resultado</th><th>Por</th><th></th></tr></thead>
            <tbody>{batches.data?.map((b) => (
              <tr key={b.id}>
                <td>{dt(b.created_at)}</td><td>{b.filename ?? '—'} <span className="muted small mono">{b.source}</span></td><td>{b.kind === 'subscribers' ? 'Assinantes' : b.kind === 'history' ? 'Histórico' : 'Títulos'}</td>
                <td className="small">{b.totals.created} novos · {b.totals.updated} atualizados · {b.totals.unchanged} iguais · {b.totals.error} erros</td><td>{b.created_by_name}</td>
                <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="sm" onClick={async () => setDetail({ batch: b, rows: await api(`/import/batches/${b.id}`) })}>erros e avisos</button>
                  {b.accounts_to_provision > 0 && (
                    <ActionButton className="sm primary" confirm={`Enviar ao agente o provisionamento de ${b.accounts_to_provision} conta(s) PPPoE deste lote? Faça isso apenas no momento combinado para a virada do grupo.`}
                      onClick={async () => { const r = await api(`/import/batches/${b.id}/provision`, { method: 'POST' }); toast(`${r.requested} operação(ões) solicitada(s). Acompanhe em Rede → Operações.`); batches.reload(); }}>
                      Provisionar {b.accounts_to_provision} conta(s)</ActionButton>
                  )}
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </State>
      </Card>
      {detail && <Modal title={`Lote ${detail.batch.filename ?? ''}`} onClose={() => setDetail(null)} wide><Rows rows={detail.rows} /></Modal>}
    </Page>
  );
}
