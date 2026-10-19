import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Brand, Field, Form } from '../ui';

// Contas SINTÉTICAS do modo demonstração. Só existem (e só aparecem) quando o servidor roda com NEXO_DEMO_MODE=1.
const DEMO: [string, string][] = [
  ['admin@alfa.demo', 'Administrador, Provedor Alfa'], ['atendimento@alfa.demo', 'Atendimento, Alfa'], ['financeiro@alfa.demo', 'Financeiro, Alfa'],
  ['noc@alfa.demo', 'Técnico/NOC, Alfa'], ['admin@beta.demo', 'Administrador, Provedor Beta'], ['operador@nexoisp.demo', 'Operador do SaaS'],
];

export function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [show, setShow] = useState(false);
  const nav = useNavigate();
  const [demo, setDemo] = useState(false);
  useEffect(() => { fetch('/api/health').then((r) => r.json()).then((h) => setDemo(!!h.demo)).catch(() => {}); }, []);
  return (
    <div className="login">
      <aside className="pitch">
        <Brand />
        <div>
          <h1>Do contrato ao sinal na casa do assinante.</h1>
          <p>Cadastro, cobrança, PPPoE, fibra, atendimento e operação de rede do provedor em um só lugar.</p>
        </div>
        {/* fibras saindo de um mesmo cabo: o código de cores que todo técnico conhece */}
        <svg className="strands" viewBox="0 0 800 300" preserveAspectRatio="none" aria-hidden="true" fill="none" strokeWidth="5" strokeLinecap="round">
          {['#2f6fb0', '#d9661a', '#2e8b57', '#8a5a3c', '#8b98a1', '#f4f6f5', '#b8322a', '#0a8f8a'].map((c, i) => (
            <path key={c} stroke={c} d={`M-20 ${150 + (i - 3.5) * 5} C 260 ${150 + (i - 3.5) * 5}, 380 ${150 + (i - 3.5) * 30}, 820 ${150 + (i - 3.5) * 42}`} />
          ))}
        </svg>
      </aside>
      <div className="box">
        <h2>Entrar</h2>
        <p>Use o e-mail e a senha da sua conta.</p>
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
          <Field label="E-mail"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required autoComplete="username" /></Field>
          <Field label="Senha">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
              <button type="button" onClick={() => setShow(!show)} aria-pressed={show} style={{ whiteSpace: 'nowrap' }}>{show ? 'Ocultar' : 'Mostrar'}</button>
            </div>
          </Field>
          {needCode && <Field label="Código do aplicativo autenticador"><input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoFocus required /></Field>}
        </Form>
        <p className="small muted" style={{ marginTop: 16 }}>Esqueceu a senha? Quem redefine é o administrador do seu provedor, em Usuários. Assinantes pedem ao provedor um novo acesso ao portal.</p>
        {demo && (
          <div className="demo-users">
            <b>Ambiente de demonstração.</b> Contas sintéticas, todas com a senha <code>demo1234</code>. Escolha uma para preencher:
            <div style={{ marginTop: 8 }}>{DEMO.map(([e, label]) => (
              <button key={e} type="button" onClick={() => { setEmail(e); setPassword('demo1234'); }}><span>{e}</span><span>{label}</span></button>
            ))}</div>
          </div>
        )}
      </div>
    </div>
  );
}
