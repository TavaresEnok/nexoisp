import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Field, Form } from '../ui';

// Contas SINTÉTICAS do modo demonstração. Só existem (e só aparecem) quando o servidor roda com NEXO_DEMO_MODE=1.
const DEMO: [string, string][] = [
  ['admin@alfa.demo', 'Administrador — Provedor Alfa'], ['atendimento@alfa.demo', 'Atendimento — Alfa'], ['financeiro@alfa.demo', 'Financeiro — Alfa'],
  ['noc@alfa.demo', 'Técnico/NOC — Alfa'], ['admin@beta.demo', 'Administrador — Provedor Beta'], ['operador@nexoisp.demo', 'Operador do SaaS'],
];

export function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const nav = useNavigate();
  const [demo, setDemo] = useState(false);
  useEffect(() => { fetch('/api/health').then((r) => r.json()).then((h) => setDemo(!!h.demo)).catch(() => {}); }, []);
  return (
    <div className="login">
      <div className="box">
        <h1>NexoISP</h1>
        <p>Gestão para provedores de internet</p>
        <Form submit="Entrar" onSubmit={async () => {
          try {
            await api('/auth/login', { body: { email, password, ...(code ? { code } : {}) } });
          } catch (e: any) {
            if (/código de verificação/.test(e.message)) setNeedCode(true);
            throw e;
          }
          await onLogin();
          nav('/');
        }}>
          <Field label="E-mail"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></Field>
          <Field label="Senha"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          {needCode && <Field label="Código do aplicativo autenticador"><input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoFocus required /></Field>}
        </Form>
        {demo && (
          <div className="demo-users">
            <b>Ambiente de demonstração</b> — contas sintéticas, todas com a senha <code>demo1234</code>. Clique para preencher:
            <table style={{ marginTop: 6, border: 0 }}>
              <tbody>{DEMO.map(([e, label]) => (
                <tr key={e} style={{ cursor: 'pointer' }} onClick={() => { setEmail(e); setPassword('demo1234'); }}>
                  <td style={{ padding: '3px 6px', border: 0 }} className="mono">{e}</td><td style={{ padding: '3px 6px', border: 0 }}>{label}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
