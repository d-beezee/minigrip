import { useState } from 'react';
import { api } from './api.js';
import { Modal, Field, Icon, TYPE_LABEL } from './ui.jsx';

const COLORS = ['', '#5fb865', '#3574f0', '#e5a33a', '#d95e5e', '#a77de8', '#3fb8c9'];
const DEFAULT_PORT = { mysql: 3306, mariadb: 3306, postgres: 5432 };
const BADGE = { postgres: 'PG', mysql: 'My', mariadb: 'Ma', sqlite: 'SL' };

const blank = () => ({
  name: '', type: 'postgres', host: 'localhost', port: '', user: '', password: '', database: '', file: '',
  ssl: false, sslVerify: false, color: '', readOnly: false,
  ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password', password: '', keyPath: '~/.ssh/id_rsa', privateKey: '', passphrase: '' },
});

// Secrets come back from the server only as hasX flags; an empty, untouched field means "keep".
export default function ConnectionDialog({ initial, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [c, setC] = useState(() => {
    const b = blank();
    if (!initial) return b;
    return { ...b, ...initial, password: '', ssh: { ...b.ssh, ...initial.ssh, password: '', privateKey: '', passphrase: '' } };
  });
  const [touched, setTouched] = useState({});
  const [tab, setTab] = useState('general');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k, v) => setC((o) => ({ ...o, [k]: v }));
  const setSsh = (k, v) => setC((o) => ({ ...o, ssh: { ...o.ssh, [k]: v } }));
  const touch = (k) => setTouched((t) => ({ ...t, [k]: true }));
  const lite = c.type === 'sqlite';

  function payload() {
    const out = structuredClone(c);
    delete out.id; delete out.connected; delete out.hasPassword;
    for (const k of ['hasPassword', 'hasPrivateKey', 'hasPassphrase']) delete out.ssh[k];
    out.port = Number(out.port) || DEFAULT_PORT[out.type];
    out.ssh.port = Number(out.ssh.port) || 22;
    if (lite) out.ssh.enabled = false;
    if (!out.name.trim()) out.name = lite ? out.file.split(/[\\/]/).pop() || 'SQLite' : `${out.user || 'db'}@${out.host}`;
    // untouched secret fields of an existing connection: omit so the server keeps the stored value
    if (editing) {
      if (!touched.password) delete out.password;
      for (const k of ['password', 'privateKey', 'passphrase']) if (!touched['ssh.' + k]) delete out.ssh[k];
    }
    return out;
  }

  async function test() {
    setBusy(true);
    setStatus({ kind: 'busy', text: c.ssh.enabled && !lite ? 'Opening SSH tunnel and connecting…' : 'Connecting…' });
    try {
      const r = await api.test({ ...payload(), id: initial?.id });
      setStatus({ kind: 'ok', text: `Connected — ${lite ? 'SQLite' : 'server'} ${r.version} (${r.ms} ms)` });
    } catch (e) {
      setStatus({ kind: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const saved = editing ? await api.update(initial.id, payload()) : await api.create(payload());
      onSaved(saved);
    } catch (e) {
      setStatus({ kind: 'err', text: e.message });
      setBusy(false);
    }
  }

  const secretPh = (has) => (editing && has ? '•••••• (saved — type to replace)' : '');

  return (
    <Modal
      title={editing ? `Edit connection — ${initial.name}` : 'New connection'}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn" onClick={test} disabled={busy}><Icon name="plug" /> Test connection</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>{editing ? 'Save' : 'Create'}</button>
        </>
      }
    >
      <div className="type-picker">
        {['postgres', 'mysql', 'mariadb', 'sqlite'].map((t) => (
          <button key={t} className={'type-opt' + (c.type === t ? ' on' : '')}
            onClick={() => {
              set('type', t);
              if (!c.port || c.port == DEFAULT_PORT[c.type]) set('port', '');
              if (t === 'sqlite' && tab === 'ssh') setTab('general');
            }}>
            <span className={'type-badge t-' + t}>{BADGE[t]}</span>
            {TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="tabs-mini">
        {[['general', 'General'], !lite && ['ssh', 'SSH tunnel'], ['options', 'Options']].filter(Boolean).map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}{k === 'ssh' && c.ssh.enabled && <span className="dot-on" />}
          </button>
        ))}
      </div>

      {tab === 'general' && lite && (
        <div className="form-grid">
          <Field label="Name" wide>
            <input value={c.name} onChange={(e) => set('name', e.target.value)} placeholder={c.file.split(/[\\/]/).pop() || 'SQLite'} autoFocus />
          </Field>
          <Field label="Database file" wide hint="Path on the machine running MiniGrip. Created if it doesn't exist.">
            <div className="input-row">
              <input value={c.file} onChange={(e) => set('file', e.target.value)} placeholder="~/data/app.db" />
              {window.minigrip?.pickFile && (
                <button type="button" className="btn" onClick={async () => {
                  const p = await window.minigrip.pickFile({ title: 'Choose SQLite database' });
                  if (p) set('file', p);
                }}>Browse…</button>
              )}
            </div>
          </Field>
        </div>
      )}

      {tab === 'general' && !lite && (
        <div className="form-grid">
          <Field label="Name" wide>
            <input value={c.name} onChange={(e) => set('name', e.target.value)} placeholder={`${c.user || 'user'}@${c.host || 'host'}`} autoFocus />
          </Field>
          <Field label="Host">
            <input value={c.host} onChange={(e) => set('host', e.target.value)} placeholder="localhost" />
          </Field>
          <Field label="Port">
            <input value={c.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} placeholder={String(DEFAULT_PORT[c.type])} />
          </Field>
          <Field label="User">
            <input value={c.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Password">
            <input type="password" value={c.password} placeholder={secretPh(initial?.hasPassword)} autoComplete="new-password"
              onChange={(e) => { set('password', e.target.value); touch('password'); }} />
          </Field>
          <Field label="Database" wide hint={c.type === 'postgres' ? 'Defaults to "postgres"' : 'Optional — all schemas are listed in the tree'}>
            <input value={c.database} onChange={(e) => set('database', e.target.value)} />
          </Field>
          {c.ssh.enabled && (
            <p className="note wide"><Icon name="lock" /> Host and port are resolved from the SSH server <b>{c.ssh.host || '…'}</b>.</p>
          )}
        </div>
      )}

      {tab === 'ssh' && !lite && (
        <div className="form-grid">
          <label className="check wide">
            <input type="checkbox" checked={c.ssh.enabled} onChange={(e) => setSsh('enabled', e.target.checked)} />
            Connect through an SSH tunnel
          </label>
          <fieldset disabled={!c.ssh.enabled} className="form-grid wide sub">
            <Field label="SSH host">
              <input value={c.ssh.host} onChange={(e) => setSsh('host', e.target.value)} placeholder="bastion.example.com" />
            </Field>
            <Field label="Port">
              <input value={c.ssh.port} onChange={(e) => setSsh('port', e.target.value.replace(/\D/g, ''))} />
            </Field>
            <Field label="User">
              <input value={c.ssh.user} onChange={(e) => setSsh('user', e.target.value)} />
            </Field>
            <Field label="Authentication">
              <select value={c.ssh.auth} onChange={(e) => setSsh('auth', e.target.value)}>
                <option value="password">Password</option>
                <option value="key">Key pair</option>
                <option value="agent">OpenSSH config and agent</option>
              </select>
            </Field>
            {c.ssh.auth === 'password' && (
              <Field label="SSH password" wide>
                <input type="password" value={c.ssh.password} placeholder={secretPh(initial?.ssh?.hasPassword)} autoComplete="new-password"
                  onChange={(e) => { setSsh('password', e.target.value); touch('ssh.password'); }} />
              </Field>
            )}
            {c.ssh.auth === 'key' && (
              <>
                <Field label="Private key file" wide hint="Path on the machine running MiniGrip. Ignored if a key is pasted below.">
                  <div className="input-row">
                    <input value={c.ssh.keyPath} onChange={(e) => setSsh('keyPath', e.target.value)} />
                    {window.minigrip?.pickFile && (
                      <button type="button" className="btn" onClick={async () => {
                        const p = await window.minigrip.pickFile({ title: 'Choose SSH private key', defaultPath: '~/.ssh' });
                        if (p) setSsh('keyPath', p);
                      }}>Browse…</button>
                    )}
                  </div>
                </Field>
                <Field label="…or paste private key" wide>
                  <textarea rows={3} value={c.ssh.privateKey} placeholder={secretPh(initial?.ssh?.hasPrivateKey) || '-----BEGIN OPENSSH PRIVATE KEY-----'}
                    onChange={(e) => { setSsh('privateKey', e.target.value); touch('ssh.privateKey'); }} />
                </Field>
                <Field label="Passphrase" wide>
                  <input type="password" value={c.ssh.passphrase} placeholder={secretPh(initial?.ssh?.hasPassphrase)} autoComplete="new-password"
                    onChange={(e) => { setSsh('passphrase', e.target.value); touch('ssh.passphrase'); }} />
                </Field>
              </>
            )}
            {c.ssh.auth === 'agent' && (
              <p className="note wide">
                Like <code>ssh</code>: reads <code>~/.ssh/config</code> (host aliases, User, Port, IdentityFile), then tries the agent
                and the key files (<code>~/.ssh/id_rsa</code>, <code>id_ed25519</code>…). Encrypted keys need the passphrase below.
              </p>
            )}
            {c.ssh.auth === 'agent' && (
              <Field label="Key passphrase (optional)" wide>
                <input type="password" value={c.ssh.passphrase} placeholder={secretPh(initial?.ssh?.hasPassphrase)} autoComplete="new-password"
                  onChange={(e) => { setSsh('passphrase', e.target.value); touch('ssh.passphrase'); }} />
              </Field>
            )}
          </fieldset>
        </div>
      )}

      {tab === 'options' && (
        <div className="form-grid">
          {!lite && (
            <>
              <label className="check wide">
                <input type="checkbox" checked={c.ssl} onChange={(e) => set('ssl', e.target.checked)} /> Use SSL/TLS
              </label>
              <label className="check wide" style={{ opacity: c.ssl ? 1 : 0.5 }}>
                <input type="checkbox" disabled={!c.ssl} checked={c.sslVerify} onChange={(e) => set('sslVerify', e.target.checked)} /> Verify server certificate
              </label>
            </>
          )}
          <label className="check wide">
            <input type="checkbox" checked={c.readOnly} onChange={(e) => set('readOnly', e.target.checked)} /> Warn before running data-modifying statements
          </label>
          <Field label="Color" wide>
            <div className="swatches">
              {COLORS.map((col) => (
                <button key={col || 'none'} className={'swatch' + (c.color === col ? ' on' : '')} style={{ background: col || 'transparent' }}
                  onClick={() => set('color', col)} title={col || 'None'}>{!col && <Icon name="close" size={12} />}</button>
              ))}
            </div>
          </Field>
        </div>
      )}

      {status && (
        <div className={'status-line ' + status.kind}>
          <Icon name={status.kind === 'ok' ? 'check' : status.kind === 'err' ? 'warn' : 'refresh'} className={status.kind === 'busy' ? 'spin' : ''} />
          <span>{status.text}</span>
        </div>
      )}
    </Modal>
  );
}
