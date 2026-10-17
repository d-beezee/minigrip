import { useState } from 'react';
import { api } from './api.js';
import { Modal, Field, Icon } from './ui.jsx';

const COLORS = ['', '#5fb865', '#3574f0', '#e5a33a', '#d95e5e', '#a77de8', '#3fb8c9'];
const DEFAULT_PORT = { mysql: 3306, mariadb: 3306, postgres: 5432 };

const blank = () => ({
  name: '', type: 'postgres', host: 'localhost', port: '', user: '', password: '', database: '',
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

  function payload() {
    const out = structuredClone(c);
    delete out.id; delete out.connected; delete out.hasPassword;
    for (const k of ['hasPassword', 'hasPrivateKey', 'hasPassphrase']) delete out.ssh[k];
    out.port = Number(out.port) || DEFAULT_PORT[out.type];
    out.ssh.port = Number(out.ssh.port) || 22;
    if (!out.name.trim()) out.name = `${out.user || 'db'}@${out.host}`;
    // untouched secret fields of an existing connection: omit so the server keeps the stored value
    if (editing) {
      if (!touched.password) delete out.password;
      for (const k of ['password', 'privateKey', 'passphrase']) if (!touched['ssh.' + k]) delete out.ssh[k];
    }
    return out;
  }

  async function test() {
    setBusy(true);
    setStatus({ kind: 'busy', text: c.ssh.enabled ? 'Opening SSH tunnel and connecting…' : 'Connecting…' });
    try {
      const r = await api.test({ ...payload(), id: initial?.id });
      setStatus({ kind: 'ok', text: `Connected — server ${r.version} (${r.ms} ms)` });
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
        {['postgres', 'mysql', 'mariadb'].map((t) => (
          <button key={t} className={'type-opt' + (c.type === t ? ' on' : '')}
            onClick={() => { set('type', t); if (!c.port || c.port == DEFAULT_PORT[c.type]) set('port', ''); }}>
            <span className={'type-badge t-' + t}>{t === 'postgres' ? 'PG' : t === 'mysql' ? 'My' : 'Ma'}</span>
            {t === 'postgres' ? 'PostgreSQL' : t === 'mysql' ? 'MySQL' : 'MariaDB'}
          </button>
        ))}
      </div>

      <div className="tabs-mini">
        {[['general', 'General'], ['ssh', 'SSH tunnel'], ['options', 'Options']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}{k === 'ssh' && c.ssh.enabled && <span className="dot-on" />}
          </button>
        ))}
      </div>

      {tab === 'general' && (
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

      {tab === 'ssh' && (
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
                <option value="agent">SSH agent</option>
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
            {c.ssh.auth === 'agent' && <p className="note wide">Uses the agent at <code>$SSH_AUTH_SOCK</code> of the MiniGrip server process.</p>}
          </fieldset>
        </div>
      )}

      {tab === 'options' && (
        <div className="form-grid">
          <label className="check wide">
            <input type="checkbox" checked={c.ssl} onChange={(e) => set('ssl', e.target.checked)} /> Use SSL/TLS
          </label>
          <label className="check wide" style={{ opacity: c.ssl ? 1 : 0.5 }}>
            <input type="checkbox" disabled={!c.ssl} checked={c.sslVerify} onChange={(e) => set('sslVerify', e.target.checked)} /> Verify server certificate
          </label>
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
