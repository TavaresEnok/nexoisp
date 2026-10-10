import { useState } from 'react';
import { api } from '../api';
import { useMe } from '../App';
import { Badge, Card, Field, Form, Page } from '../ui';

export function Account() {
  const { me, reload } = useMe();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState('');
  const [off, setOff] = useState({ password: '', code: '' });
  return (
    <Page title="Minha conta">
      {me.mfa_pending && <div className="state err">Sua conta administrativa exige verificação em duas etapas. Configure abaixo para liberar o restante do sistema.</div>}
      <Card title={<>Verificação em duas etapas {me.mfa_enabled ? <Badge tone="green">ativa</Badge> : <Badge tone="amber">inativa</Badge>}</>}>
        {!me.mfa_enabled && !setup && (<>
          <p className="small muted" style={{ marginTop: 0 }}>Use um aplicativo autenticador (TOTP). Recomendado para todos e obrigatório para administradores no piloto com dados reais.</p>
          <button className="primary" onClick={async () => { try { setSetup(await api('/me/mfa/setup', { method: 'POST' })); } catch (e: any) { alert(e.message); } }}>Configurar</button>
        </>)}
        {!me.mfa_enabled && setup && (
          <Form submit="Ativar" onSubmit={async () => { await api('/me/mfa/enable', { body: { code } }); setSetup(null); setCode(''); await reload(); }}>
            <p className="small">No aplicativo autenticador, adicione uma conta com a chave abaixo (ou abra o endereço <span className="mono">otpauth</span>) e informe o código de 6 dígitos gerado.</p>
            <Field label="Chave"><input readOnly value={setup.secret} className="mono" onFocus={(e) => e.target.select()} /></Field>
            <Field label="Endereço otpauth"><input readOnly value={setup.otpauth_url} className="mono" onFocus={(e) => e.target.select()} /></Field>
            <Field label="Código do aplicativo"><input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" required autoFocus style={{ maxWidth: 160 }} /></Field>
          </Form>
        )}
        {me.mfa_enabled && (
          <Form submit="Desativar verificação" onSubmit={async () => { await api('/me/mfa/disable', { body: off }); setOff({ password: '', code: '' }); await reload(); }}>
            <div className="cols">
              <Field label="Senha atual"><input type="password" value={off.password} onChange={(e) => setOff({ ...off, password: e.target.value })} required /></Field>
              <Field label="Código do aplicativo"><input value={off.code} onChange={(e) => setOff({ ...off, code: e.target.value })} required /></Field>
            </div>
          </Form>
        )}
      </Card>
      <Card title="Alterar senha">
        <Form submit="Alterar senha" onSubmit={async () => { await api('/me/password', { body: pw }); setPw({ current: '', next: '' }); setMsg('Senha alterada. Outras sessões foram encerradas.'); }}>
          <div className="cols">
            <Field label="Senha atual"><input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required /></Field>
            <Field label="Nova senha" hint="Mínimo de 8 caracteres."><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required minLength={8} /></Field>
          </div>
          {msg && <div className="small" style={{ color: 'var(--green)' }}>{msg}</div>}
        </Form>
      </Card>
    </Page>
  );
}
