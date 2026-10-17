import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api.js';
import Sidebar from './Sidebar.jsx';
import Console from './Console.jsx';
import ConnectionDialog from './ConnectionDialog.jsx';
import ImportDialog from './ImportDialog.jsx';
import { Icon, ContextMenu, Modal, useDrag, TYPE_LABEL } from './ui.jsx';

const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toLocaleTimeString([], { hour12: false });
const q = (type, id) => (type === 'postgres' ? '"' + id.replace(/"/g, '""') + '"' : '`' + id.replace(/`/g, '``') + '`');
const WRITE_RE = /^\s*(insert|update|delete|drop|alter|truncate|create|replace|rename|grant|revoke|merge)\b/im;

const EXPORT_FORMATS = [
  ['csv', 'CSV', 'download'],
  ['tsv', 'TSV', 'download'],
  ['json', 'JSON', 'download'],
  ['sql', 'SQL INSERT statements', 'download'],
  ['markdown', 'Markdown table', 'download'],
];

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

const newTabObj = (p = {}) => ({ id: uid(), title: 'console', connId: null, schema: null, sql: '', results: [], log: [], active: 'output', running: false, ...p });

export default function App() {
  const [connections, setConnections] = useState([]);
  const [connState, setConnState] = useState({});
  const [tabs, setTabs] = useState(() => {
    const saved = loadJson('mg.tabs', []);
    return saved.length ? saved.map((t) => newTabObj(t)) : [newTabObj()];
  });
  const [activeId, setActiveId] = useState(() => localStorage.getItem('mg.active'));
  const [schemaLists, setSchemaLists] = useState({});
  const [completions, setCompletions] = useState({});
  const [connDialog, setConnDialog] = useState(null);
  const [importTarget, setImportTarget] = useState(null);
  const [menu, setMenu] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [sideW, setSideW] = useState(() => Number(localStorage.getItem('mg.side')) || 300);
  const [filter, setFilter] = useState('');
  const sidebar = useRef();
  const editorRef = useRef(null);

  const tab = tabs.find((t) => t.id === activeId) || tabs[0];
  const conn = connections.find((c) => c.id === tab?.connId);

  /* ------------------------------------------------------------ persistence */

  useEffect(() => {
    localStorage.setItem('mg.tabs', JSON.stringify(tabs.map(({ id, title, connId, schema, sql }) => ({ id, title, connId, schema, sql }))));
  }, [tabs]);
  useEffect(() => { tab && localStorage.setItem('mg.active', tab.id); }, [tab?.id]);

  const toast = useCallback((kind, text) => {
    const id = uid();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 8000 : 4000);
  }, []);

  const refreshConnections = useCallback(async () => {
    const list = await api.connections();
    setConnections(list);
    return list;
  }, []);

  useEffect(() => {
    refreshConnections().catch((e) => toast('err', 'Cannot reach the MiniGrip server: ' + e.message));
  }, []);

  const patchTab = (id, patch) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)));

  /* ------------------------------------------------------------ connections */

  const connect = useCallback(async (id) => {
    setConnState((s) => ({ ...s, [id]: { status: 'connecting' } }));
    try {
      const r = await api.connect(id);
      setConnState((s) => ({ ...s, [id]: { status: 'connected', ...r } }));
      return r;
    } catch (e) {
      setConnState((s) => ({ ...s, [id]: { status: 'error', error: e.message } }));
      toast('err', e.message);
      return null;
    }
  }, [toast]);

  async function disconnect(id) {
    await api.disconnect(id).catch(() => {});
    setConnState((s) => ({ ...s, [id]: { status: 'idle' } }));
    sidebar.current?.collapse(id);
    setCompletions((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith(id))));
  }

  async function loadSchemas(id) {
    try {
      const r = await api.schemas(id);
      setSchemaLists((s) => ({ ...s, [id]: r.schemas }));
      return r;
    } catch { return null; }
  }

  // Schema list + autocompletion for the active console.
  useEffect(() => {
    if (!conn || connState[conn.id]?.status !== 'connected') return;
    if (!schemaLists[conn.id]) loadSchemas(conn.id);
    const schema = tab.schema || connState[conn.id]?.schema;
    if (!schema) return;
    const key = conn.id + '|' + schema;
    if (completions[key] !== undefined) return;
    setCompletions((c) => ({ ...c, [key]: null }));
    api.completion(conn.id, schema).then((m) => setCompletions((c) => ({ ...c, [key]: m }))).catch(() => {});
  }, [conn?.id, tab?.schema, connState[conn?.id]?.status]);

  /* ------------------------------------------------------------ tabs & queries */

  function openTab(p) {
    const t = newTabObj(p);
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    return t;
  }

  function closeTab(id) {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (!next.length) next.push(newTabObj({ connId: ts[i]?.connId }));
      if (id === tab.id) setActiveId(next[Math.max(0, i - 1)].id);
      return next;
    });
  }

  function addHistory(connId, sql, ok) {
    const h = loadJson('mg.history', []);
    h.unshift({ connId, sql, ok, time: Date.now() });
    localStorage.setItem('mg.history', JSON.stringify(h.slice(0, 300)));
  }

  async function run(t, sql, base = 0) {
    const c = connections.find((x) => x.id === t.connId);
    if (!c) {
      toast('err', 'Choose a data source for this console first');
      return;
    }
    if (!sql.trim()) return;
    if (c.readOnly && WRITE_RE.test(sql) && !window.confirm(`"${c.name}" is marked as protected.\nRun data-modifying statements anyway?`)) return;

    patchTab(t.id, (o) => ({ running: true, log: [...o.log, { kind: 'info', time: now(), text: `[${c.name}${t.schema ? ' · ' + t.schema : ''}] running ${sql.length > 60 ? 'script' : 'statement'}…` }] }));
    if (connState[c.id]?.status !== 'connected') await connect(c.id);
    try {
      const r = await api.query(c.id, { sql, schema: t.schema || undefined, maxRows: 2000 });
      const log = [];
      let firstSet = null;
      let setIdx = 0;
      let error = null;
      for (const x of r.results) {
        if (x.error) {
          error = x;
          log.push({ kind: 'err', time: now(), sql: x.sql, text: x.error.message + (x.error.detail ? ' — ' + x.error.detail : '') + (x.error.hint ? ' (hint: ' + x.error.hint + ')' : '') });
        } else if (x.columns) {
          if (firstSet === null) firstSet = setIdx;
          setIdx++;
          log.push({ kind: 'ok', time: now(), sql: x.sql, text: `${x.total.toLocaleString()} row${x.total === 1 ? '' : 's'} retrieved in ${x.ms} ms${x.truncated ? ' (showing first ' + x.rows.length.toLocaleString() + ')' : ''}` });
        } else {
          log.push({ kind: 'ok', time: now(), sql: x.sql, text: `${x.affected ?? 0} row${x.affected === 1 ? '' : 's'} affected in ${x.ms} ms${x.insertId ? ' · insert id ' + x.insertId : ''}` });
        }
      }
      patchTab(t.id, (o) => ({
        running: false,
        results: r.results,
        active: error ? 'output' : firstSet ?? 'output',
        log: [...o.log, ...log],
        // USE / SET search_path moves this console to the new schema
        schema: /^\s*(use|set\s+search_path)\b/im.test(sql) ? r.schema : o.schema,
      }));
      addHistory(c.id, sql, !error);
      if (error && error.offset != null) {
        const pos = base + error.offset + (error.error.position ? error.error.position - 1 : 0);
        setTimeout(() => editorRef.current?.focusAt(pos), 0);
      }
      if (/^\s*(create|drop|alter|rename)\b/im.test(sql)) {
        sidebar.current?.refresh(c.id, t.schema || connState[c.id]?.schema);
        setCompletions((cc) => Object.fromEntries(Object.entries(cc).filter(([k]) => !k.startsWith(c.id))));
      }
    } catch (e) {
      patchTab(t.id, (o) => ({ running: false, active: 'output', log: [...o.log, { kind: 'err', time: now(), text: e.message }] }));
      addHistory(c.id, sql, false);
    }
  }

  async function cancel(t) {
    try {
      await api.cancel(t.connId);
      patchTab(t.id, (o) => ({ log: [...o.log, { kind: 'info', time: now(), text: 'Cancel requested' }] }));
    } catch (e) {
      toast('err', 'Cancel failed: ' + e.message);
    }
  }

  async function download(c, kind, body, label) {
    toast('info', `Exporting ${label}…`);
    try {
      const r = await api.download(c.id, kind, body);
      toast('ok', `Saved ${r.name} (${(r.size / 1024).toFixed(1)} KB)`);
    } catch (e) {
      toast('err', 'Export failed: ' + e.message);
    }
  }

  /* ------------------------------------------------------------ tree actions */

  const qualified = (c, s, name) => `${q(c.type, s)}.${q(c.type, name)}`;

  function openTable(c, s, o) {
    const sql = `SELECT * FROM ${qualified(c, s, o.name)} LIMIT 500;`;
    const t = openTab({ title: o.name, connId: c.id, schema: s, sql });
    run(t, sql);
  }

  async function showDdl(c, s, o) {
    try {
      const { ddl } = await api.ddl(c.id, s, o.name, o.type);
      openTab({ title: `DDL ${o.name}`, connId: c.id, schema: s, sql: ddl });
    } catch (e) {
      toast('err', e.message);
    }
  }

  function exportItems(c, schema, sql, table) {
    return [
      { header: 'Export all rows as' },
      ...EXPORT_FORMATS.map(([f, label, icon]) => ({
        label, icon,
        onClick: () => download(c, 'export', { sql, schema, format: f, table }, label),
      })),
    ];
  }

  function showMenu(e, ctx) {
    const { conn: c, schema: s, object: o } = ctx;
    const items = [];
    const live = connState[c.id]?.status === 'connected';
    if (ctx.kind === 'conn') {
      items.push(
        { label: 'New console', icon: 'console', onClick: () => openTab({ connId: c.id, title: c.name }) },
        live
          ? { label: 'Disconnect', icon: 'unplug', onClick: () => disconnect(c.id) }
          : { label: 'Connect', icon: 'plug', onClick: () => sidebar.current?.expand(c.id) },
        { label: 'Refresh', icon: 'refresh', disabled: !live, onClick: () => sidebar.current?.refresh(c.id) },
        { sep: true },
        { label: 'Run SQL script…', icon: 'play', onClick: () => setImportTarget({ conn: c, schema: connState[c.id]?.schema || c.database, mode: 'sql' }) },
        { sep: true },
        { label: 'Edit…', icon: 'edit', onClick: () => setConnDialog(c) },
        { label: 'Duplicate', icon: 'copy', onClick: () => setConnDialog({ ...c, id: undefined, name: c.name + ' copy', hasPassword: false, ssh: { ...c.ssh, hasPassword: false, hasPrivateKey: false, hasPassphrase: false } }) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: () => removeConnection(c) },
      );
    } else if (ctx.kind === 'schema') {
      items.push(
        { label: 'New console here', icon: 'console', onClick: () => openTab({ connId: c.id, schema: s, title: s }) },
        { label: 'Refresh', icon: 'refresh', onClick: () => sidebar.current?.refresh(c.id, s) },
        { sep: true },
        { label: 'Import data into new table…', icon: 'upload', onClick: () => setImportTarget({ conn: c, schema: s, mode: 'data' }) },
        { label: 'Run SQL script…', icon: 'play', onClick: () => setImportTarget({ conn: c, schema: s, mode: 'sql' }) },
        { header: 'Dump schema to .sql' },
        { label: 'Structure and data', icon: 'download', onClick: () => download(c, 'dump', { schema: s }, `${s} dump`) },
        { label: 'Structure only', icon: 'download', onClick: () => download(c, 'dump', { schema: s, data: false }, `${s} structure`) },
        { label: 'Data only', icon: 'download', onClick: () => download(c, 'dump', { schema: s, ddl: false }, `${s} data`) },
      );
    } else if (ctx.kind === 'object') {
      const isRoutine = o.type === 'function' || o.type === 'procedure';
      const name = qualified(c, s, o.name);
      if (!isRoutine) {
        items.push(
          { label: 'Open data', icon: 'table', hint: 'double-click', onClick: () => openTable(c, s, o) },
          { label: 'New console with SELECT', icon: 'console', onClick: () => openTab({ connId: c.id, schema: s, title: o.name, sql: `SELECT *\nFROM ${name}\nWHERE 1 = 1\nLIMIT 100;` }) },
        );
      }
      items.push({ label: 'Show DDL', icon: 'wrench', onClick: () => showDdl(c, s, o) });
      if (!isRoutine) {
        items.push(...exportItems(c, s, `SELECT * FROM ${name}`, o.name));
        items.push({ sep: true });
        if (o.type === 'table') items.push({ label: 'Import data…', icon: 'upload', onClick: () => setImportTarget({ conn: c, schema: s, table: o.name, mode: 'data' }) });
        if (o.type === 'table') items.push({ label: 'Dump table to .sql', icon: 'download', onClick: () => download(c, 'dump', { schema: s, tables: [o.name] }, `${o.name} dump`) });
      }
      items.push(
        { sep: true },
        { label: 'Copy name', icon: 'copy', onClick: () => navigator.clipboard?.writeText(o.name) },
        { label: 'Copy qualified name', icon: 'copy', onClick: () => navigator.clipboard?.writeText(name) },
      );
    } else if (ctx.kind === 'column') {
      items.push(
        { label: 'Copy name', icon: 'copy', onClick: () => navigator.clipboard?.writeText(ctx.column.name) },
        { label: 'Insert into console', icon: 'console', onClick: () => editorRef.current?.insert(q(c.type, ctx.column.name)) },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  async function removeConnection(c) {
    if (!window.confirm(`Delete the connection "${c.name}"?\nThis removes the saved settings, not the database.`)) return;
    await api.remove(c.id);
    setConnState((s) => ({ ...s, [c.id]: undefined }));
    await refreshConnections();
  }

  function guessTable(sql) {
    const m = sql.match(/\bfrom\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)/i);
    return m ? m[1].replace(/[`"]/g, '') : 'result';
  }

  /* ------------------------------------------------------------ native menu (Electron) */

  const menuHandler = useRef();
  menuHandler.current = (action) => {
    switch (action) {
      case 'new-connection': return setConnDialog({});
      case 'new-console': return openTab({ connId: tab?.connId, schema: tab?.schema, title: conn?.name || 'console' });
      case 'close-console': return tab && closeTab(tab.id);
      case 'run': return editorRef.current?.run(false);
      case 'run-all': return editorRef.current?.run(true);
      case 'cancel': return tab?.running && cancel(tab);
      case 'history': return setHistoryOpen(true);
      case 'run-script':
        if (conn) setImportTarget({ conn, schema: tab.schema || cs?.schema || conn.database, mode: 'sql' });
        else toast('err', 'Choose a data source for this console first');
    }
  };
  useEffect(() => window.minigrip?.onMenu((a) => menuHandler.current(a)), []);

  /* ------------------------------------------------------------ layout */

  const dragSide = useDrag((e) => {
    const w = Math.max(200, Math.min(600, e.clientX));
    setSideW(w);
    localStorage.setItem('mg.side', w);
  });

  const cs = conn ? connState[conn.id] : null;
  const completion = conn ? completions[conn.id + '|' + (tab.schema || cs?.schema)] : null;
  const schemaOptions = conn ? schemaLists[conn.id] || [] : [];

  return (
    <div className="app" style={{ '--side': sideW + 'px' }}>
      <header className="toolbar">
        <div className="brand">
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#3574f0" /><ellipse cx="16" cy="10" rx="9" ry="3.5" fill="#fff" /><path d="M7 10v12c0 2 4 3.5 9 3.5s9-1.5 9-3.5V10M7 16c0 2 4 3.5 9 3.5s9-1.5 9-3.5" fill="none" stroke="#fff" strokeWidth="2.5" /></svg>
          <span>MiniGrip</span>
        </div>
        <button className="btn sm ghost" onClick={() => setConnDialog({})}><Icon name="plus" /> Data source</button>
        <div className="tb-sep" />

        <div className="ctx-select" style={{ '--c': conn?.color || 'var(--dim)' }}>
          <span className="conn-dot" style={{ background: conn?.color || 'transparent', borderColor: conn?.color || 'var(--dim)' }} />
          <select value={tab.connId || ''} title="Data source for this console"
            onChange={(e) => patchTab(tab.id, { connId: e.target.value || null, schema: null })}>
            <option value="">— no data source —</option>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="ctx-select">
          <Icon name="schema" size={14} className="dim" />
          <select value={tab.schema || ''} disabled={!conn} title="Default schema for this console"
            onFocus={() => conn && loadSchemas(conn.id)}
            onChange={(e) => patchTab(tab.id, { schema: e.target.value || null })}>
            <option value="">{cs?.schema ? `${cs.schema} (default)` : 'default schema'}</option>
            {schemaOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            {tab.schema && !schemaOptions.includes(tab.schema) && <option value={tab.schema}>{tab.schema}</option>}
          </select>
        </div>

        <button className="btn sm run" disabled={!conn || tab.running} onClick={() => editorRef.current?.run(false)} title="Run statement at cursor (Ctrl+Enter)">
          <Icon name="play" /> Run
        </button>
        <button className="btn sm ghost" disabled={!conn || tab.running} onClick={() => editorRef.current?.run(true)} title="Run all (Ctrl+Shift+Enter)">
          <Icon name="playAll" /> Run all
        </button>
        <button className="btn sm ghost danger-ghost" disabled={!tab.running} onClick={() => cancel(tab)} title="Cancel running query">
          <Icon name="stop" />
        </button>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => setHistoryOpen(true)}><Icon name="history" /> History</button>
        <button className="btn sm ghost" disabled={!conn} onClick={() => setImportTarget({ conn, schema: tab.schema || cs?.schema || conn.database, mode: 'sql' })}>
          <Icon name="upload" /> Run script
        </button>
      </header>

      <aside className="sidebar">
        <div className="side-head">
          <span>Database Explorer</span>
          <span className="spacer" />
          <button className="icon-btn" title="New data source" onClick={() => setConnDialog({})}><Icon name="plus" /></button>
        </div>
        <div className="side-search">
          <Icon name="filter" size={14} />
          <input placeholder="Filter objects…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {filter && <button className="icon-btn" onClick={() => setFilter('')}><Icon name="close" size={12} /></button>}
        </div>
        <Sidebar
          ref={sidebar}
          connections={connections}
          connState={connState}
          filter={filter}
          actions={{ connect, menu: showMenu, openTable, showDdl, newConnection: () => setConnDialog({}) }}
        />
      </aside>
      <div className="vsplit" onMouseDown={dragSide} />

      <main className="main">
        <div className="tabbar">
          {tabs.map((t) => {
            const tc = connections.find((c) => c.id === t.connId);
            return (
              <div key={t.id} className={'tab' + (t.id === tab.id ? ' on' : '')} onClick={() => setActiveId(t.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
                onDoubleClick={() => setRenaming(t.id)}
                style={{ '--tc': tc?.color || 'transparent' }}>
                <Icon name={t.title.startsWith('DDL ') ? 'wrench' : 'console'} size={14} />
                {renaming === t.id ? (
                  <input className="tab-rename" autoFocus defaultValue={t.title} onClick={(e) => e.stopPropagation()}
                    onFocus={(e) => e.target.select()}
                    onBlur={(e) => { if (e.target.value.trim()) patchTab(t.id, { title: e.target.value.trim() }); setRenaming(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setRenaming(null); }} />
                ) : <span className="tab-title">{t.title}</span>}
                {t.running && <Icon name="refresh" size={12} className="spin" />}
                <button className="tab-x" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} title="Close"><Icon name="close" size={12} /></button>
              </div>
            );
          })}
          <button className="icon-btn tab-add" title="New console" onClick={() => openTab({ connId: tab?.connId, schema: tab?.schema, title: conn?.name || 'console' })}>
            <Icon name="plus" />
          </button>
        </div>
        {tab && (
          <Console
            key={tab.id}
            tab={tab}
            conn={conn}
            completion={completion}
            editorRef={editorRef}
            onChange={(p) => patchTab(tab.id, p)}
            onRun={(sql, base) => run(tab, sql, base)}
            onCancel={() => cancel(tab)}
            onSetActive={(a) => patchTab(tab.id, { active: a })}
            onExport={(e, r) => setMenu({ x: e.clientX, y: e.clientY, items: exportItems(conn, tab.schema, r.sql, guessTable(r.sql)) })}
          />
        )}
      </main>

      <footer className="statusbar">
        {conn ? (
          <>
            <span className={'st-dot ' + (cs?.status || 'idle')} />
            <span>{conn.name}</span>
            <span className="dim">{TYPE_LABEL[conn.type]}{cs?.version ? ' ' + cs.version : ''}</span>
            {conn.ssh?.enabled && <span className="dim"><Icon name="lock" size={12} /> SSH {conn.ssh.host}</span>}
            {(tab.schema || cs?.schema) && <span className="dim">schema: {tab.schema || cs?.schema}</span>}
            {cs?.status === 'error' && <span className="st-err" title={cs.error}>{cs.error}</span>}
          </>
        ) : <span className="dim">No data source selected</span>}
        <span className="spacer" />
        <span className="dim">{tabs.length} console{tabs.length === 1 ? '' : 's'}</span>
      </footer>

      {connDialog && (
        <ConnectionDialog
          initial={connDialog.id || connDialog.name ? connDialog : null}
          onClose={() => setConnDialog(null)}
          onSaved={async (saved) => {
            setConnDialog(null);
            setConnState((s) => ({ ...s, [saved.id]: { status: 'idle' } }));
            sidebar.current?.collapse(saved.id);
            await refreshConnections();
            toast('ok', `Saved "${saved.name}"`);
            if (!tab.connId) patchTab(tab.id, { connId: saved.id, title: saved.name });
          }}
        />
      )}
      {importTarget && (
        <ImportDialog
          target={importTarget}
          onClose={() => setImportTarget(null)}
          onDone={() => {
            sidebar.current?.refresh(importTarget.conn.id, importTarget.schema);
            setCompletions((cc) => Object.fromEntries(Object.entries(cc).filter(([k]) => !k.startsWith(importTarget.conn.id))));
          }}
        />
      )}
      {historyOpen && (
        <HistoryDialog
          connections={connections}
          onClose={() => setHistoryOpen(false)}
          onPick={(h) => {
            setHistoryOpen(false);
            if (tab.connId === h.connId || !tab.connId) {
              if (!tab.connId) patchTab(tab.id, { connId: h.connId });
              setTimeout(() => editorRef.current?.insert(h.sql), 0);
            } else openTab({ connId: h.connId, sql: h.sql, title: 'history' });
          }}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={'toast ' + t.kind} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            <Icon name={t.kind === 'err' ? 'warn' : t.kind === 'ok' ? 'check' : 'refresh'} className={t.kind === 'info' ? 'spin' : ''} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryDialog({ connections, onClose, onPick }) {
  const [f, setF] = useState('');
  const all = loadJson('mg.history', []);
  const list = all.filter((h) => !f || h.sql.toLowerCase().includes(f.toLowerCase())).slice(0, 150);
  const name = (id) => connections.find((c) => c.id === id)?.name || 'deleted connection';
  return (
    <Modal title="Query history" onClose={onClose} width={760}
      footer={<><span className="dim">{all.length} entries kept in this browser</span><span className="spacer" />
        <button className="btn" onClick={() => { localStorage.removeItem('mg.history'); onClose(); }}>Clear</button>
        <button className="btn primary" onClick={onClose}>Close</button></>}>
      <div className="side-search boxed">
        <Icon name="filter" size={14} />
        <input autoFocus placeholder="Search history…" value={f} onChange={(e) => setF(e.target.value)} />
      </div>
      <div className="history">
        {list.map((h, i) => (
          <button key={i} className="hist-item" onClick={() => onPick(h)}>
            <div className="hist-meta">
              <Icon name={h.ok ? 'check' : 'warn'} size={12} className={h.ok ? 'ok' : 'err'} />
              <span>{name(h.connId)}</span>
              <span className="dim">{new Date(h.time).toLocaleString()}</span>
            </div>
            <code>{h.sql.length > 400 ? h.sql.slice(0, 400) + '…' : h.sql}</code>
          </button>
        ))}
        {!list.length && <div className="dim" style={{ padding: 20, textAlign: 'center' }}>No queries yet</div>}
      </div>
    </Modal>
  );
}
