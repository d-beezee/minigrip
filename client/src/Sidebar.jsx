import { useState, useImperativeHandle, forwardRef, useCallback, useEffect } from 'react';
import { api } from './api.js';
import { Icon, TYPE_LABEL } from './ui.jsx';

const GROUPS = [
  ['tables', 'tables', (o) => o.type === 'table', 'table'],
  ['views', 'views', (o) => o.type === 'view' || o.type === 'matview', 'view'],
  ['routines', 'routines', (o) => o.type === 'function' || o.type === 'procedure', 'fn'],
];

// Lazy-loaded tree: connection > schema > group > object > column.
// `cache` maps node key -> { loading, error, data }.
const Sidebar = forwardRef(function Sidebar({ connections, connState, actions, filter }, ref) {
  const [open, setOpen] = useState({});
  const [cache, setCache] = useState({});
  const [selected, setSelected] = useState(null);

  const load = useCallback(async (key, fn) => {
    setCache((c) => ({ ...c, [key]: { ...c[key], loading: true, error: null } }));
    try {
      const data = await fn();
      setCache((c) => ({ ...c, [key]: { data } }));
      return data;
    } catch (e) {
      setCache((c) => ({ ...c, [key]: { error: e.message } }));
    }
  }, []);

  const loaders = {
    conn: (id) => load(id, async () => {
      const r = await actions.connect(id);
      if (!r) throw new Error('Not connected');
      const s = await api.schemas(id);
      // auto-expand the current schema the first time
      if (s.current) setOpen((o) => (o[`${id}|${s.current}`] === undefined ? { ...o, [`${id}|${s.current}`]: true, [`${id}|${s.current}|tables`]: true } : o));
      return s;
    }),
    schema: (id, schema) => load(`${id}|${schema}`, () => api.objects(id, schema)),
    table: (id, schema, table) => load(`${id}|${schema}|t|${table}`, () => api.columns(id, schema, table)),
  };

  useImperativeHandle(ref, () => ({
    refresh(id, schema) {
      if (schema) loaders.schema(id, schema);
      else {
        setCache((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith(id))));
        loaders.conn(id);
      }
    },
    collapse(id) {
      setOpen((o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith(id))));
      setCache((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith(id))));
    },
    expand(id) {
      setOpen((o) => ({ ...o, [id]: true }));
      loaders.conn(id);
    },
  }));

  // schemas opened by auto-expand (current schema) still need their objects
  useEffect(() => {
    for (const [k, v] of Object.entries(open)) {
      const parts = k.split('|');
      if (v && parts.length === 2 && !cache[k]) loaders.schema(parts[0], parts[1]);
    }
  }, [open, cache]);

  function toggle(key, loader) {
    const willOpen = !open[key];
    setOpen((o) => ({ ...o, [key]: willOpen }));
    if (willOpen && loader && !cache[key]?.data) loader();
  }

  // Schemas and objects are expanded when their own node is opened (schema loads objects).
  function schemaKey(id, s) { return `${id}|${s}`; }

  const f = filter.trim().toLowerCase();
  const match = (name) => !f || name.toLowerCase().includes(f);

  const row = (key, depth, { icon, label, extra, expandable, isOpen, onToggle, onDouble, onContext, color, className = '', title }) => (
    <div
      key={key}
      className={'tree-row ' + className + (selected === key ? ' sel' : '')}
      style={{ paddingLeft: 6 + depth * 14 }}
      title={title}
      onClick={() => { setSelected(key); }}
      onDoubleClick={onDouble || onToggle}
      onContextMenu={(e) => { e.preventDefault(); setSelected(key); onContext?.(e); }}
    >
      <span className={'twisty' + (isOpen ? ' open' : '')} onClick={(e) => { e.stopPropagation(); onToggle?.(); }}>
        {expandable && <Icon name="chevron" size={12} />}
      </span>
      {color !== undefined && <span className="conn-dot" style={{ background: color || 'transparent', borderColor: color || 'var(--dim)' }} />}
      <Icon name={icon} className={'ti ti-' + icon} />
      <span className="tree-label">{label}</span>
      {extra && <span className="tree-extra">{extra}</span>}
    </div>
  );

  const status = (key, depth, entry) => {
    if (entry?.loading) return <div key={key + '~'} className="tree-msg" style={{ paddingLeft: 26 + depth * 14 }}><Icon name="refresh" className="spin" size={12} /> loading…</div>;
    if (entry?.error) return <div key={key + '~'} className="tree-msg err" style={{ paddingLeft: 26 + depth * 14 }} title={entry.error}><Icon name="warn" size={12} /> {entry.error}</div>;
    return null;
  };

  const out = [];
  for (const c of connections) {
    const cs = connState[c.id] || {};
    const isOpen = !!open[c.id];
    out.push(row(c.id, 0, {
      icon: 'db',
      color: c.color || '',
      label: c.name,
      extra: <>
        {c.ssh?.enabled && <Icon name="lock" size={12} className="dim" />}
        <span className={'type-badge sm t-' + c.type}>{TYPE_LABEL[c.type]}</span>
      </>,
      className: 'conn' + (cs.status === 'connected' ? ' live' : ''),
      title: `${c.user}@${c.host}:${c.port}${c.database ? '/' + c.database : ''}${c.ssh?.enabled ? ` via ssh ${c.ssh.user}@${c.ssh.host}` : ''}`,
      expandable: true,
      isOpen,
      onToggle: () => toggle(c.id, () => loaders.conn(c.id)),
      onContext: (e) => actions.menu(e, { kind: 'conn', conn: c }),
    }));
    if (!isOpen) continue;
    const ce = cache[c.id];
    const st = status(c.id, 1, ce);
    if (st) out.push(st);
    for (const s of ce?.data?.schemas || []) {
      const sk = schemaKey(c.id, s);
      const sOpen = !!open[sk];
      const se = cache[sk];
      out.push(row(sk, 1, {
        icon: 'schema',
        label: s,
        extra: s === ce.data.current ? <span className="tag">current</span> : null,
        expandable: true,
        isOpen: sOpen,
        onToggle: () => toggle(sk, () => loaders.schema(c.id, s)),
        onContext: (e) => actions.menu(e, { kind: 'schema', conn: c, schema: s }),
      }));
      if (!sOpen) continue;
      const sst = status(sk, 2, se);
      if (sst) out.push(sst);
      if (!se?.data) continue;
      for (const [g, label, pred, gIcon] of GROUPS) {
        const items = se.data.filter(pred).filter((o) => match(o.name));
        if (!items.length && (g !== 'tables' || f)) continue;
        const gk = `${sk}|${g}`;
        const gOpen = open[gk] ?? (!!f);
        out.push(row(gk, 2, {
          icon: gIcon, label, extra: <span className="count">{items.length}</span>, expandable: true, isOpen: gOpen,
          className: 'group',
          onToggle: () => setOpen((o) => ({ ...o, [gk]: !gOpen })),
        }));
        if (!gOpen) continue;
        for (const o of items) {
          const ok = `${sk}|t|${o.name}`;
          const isRoutine = g === 'routines';
          const oOpen = !!open[ok];
          const ctx = { kind: 'object', conn: c, schema: s, object: o };
          out.push(row(ok + '|' + o.type, 3, {
            icon: gIcon,
            label: o.name,
            extra: o.type === 'matview' ? <span className="tag">mat</span> : isRoutine ? <span className="tag">{o.type === 'procedure' ? 'proc' : 'fn'}</span> : null,
            expandable: !isRoutine,
            isOpen: oOpen,
            onToggle: isRoutine ? undefined : () => toggle(ok, () => loaders.table(c.id, s, o.name)),
            onDouble: () => (isRoutine ? actions.showDdl(c, s, o) : actions.openTable(c, s, o)),
            onContext: (e) => actions.menu(e, ctx),
          }));
          if (!oOpen) continue;
          const oe = cache[ok];
          const ost = status(ok, 4, oe);
          if (ost) out.push(ost);
          for (const col of oe?.data || []) {
            out.push(row(`${ok}|c|${col.name}`, 4, {
              icon: col.pk ? 'key' : 'column',
              label: col.name,
              extra: <span className="coltype">{col.type}{col.nullable ? '' : ' · not null'}</span>,
              className: 'col' + (col.pk ? ' pk' : ''),
              title: `${col.name} ${col.type}${col.default != null ? ' default ' + col.default : ''}${col.extra ? ' ' + col.extra : ''}`,
              onContext: (e) => actions.menu(e, { kind: 'column', conn: c, schema: s, object: o, column: col }),
            }));
          }
        }
      }
    }
  }

  return (
    <div className="tree" tabIndex={0}>
      {out}
      {!connections.length && (
        <div className="empty-tree">
          <Icon name="db" size={28} />
          <p>No data sources yet.</p>
          <button className="btn primary" onClick={actions.newConnection}><Icon name="plus" /> New connection</button>
        </div>
      )}
    </div>
  );
});

export default Sidebar;
