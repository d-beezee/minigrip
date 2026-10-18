import { useMemo, useRef, useState, useEffect } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql as sqlLang, MySQL, MariaSQL, PostgreSQL, SQLite } from '@codemirror/lang-sql';
import { keymap, EditorView } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { statementAt } from '@shared/split.js';
import ResultGrid from './ResultGrid.jsx';
import { columnSource } from './completion.js';
import { Icon, useDrag } from './ui.jsx';

const DIALECT = { mysql: MySQL, mariadb: MariaSQL, postgres: PostgreSQL, sqlite: SQLite };

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px', backgroundColor: 'var(--editor)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--editor)', color: 'var(--gutter)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.035)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#214283 !important' },
  '.cm-tooltip-autocomplete': { backgroundColor: 'var(--panel-2)', border: '1px solid var(--border)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#2e436e' },
  '.cm-flash': { backgroundColor: 'rgba(53,116,240,0.22)', transition: 'background-color .6s' },
}, { dark: true });

// { table: [{ name, type, pk }] } -> lang-sql's namespace, with column types shown next to the names
const toNamespace = (completion) =>
  Object.fromEntries(Object.entries(completion || {}).map(([t, cols]) => [t, cols.map((c) => ({
    label: c.name, type: c.pk ? 'constant' : 'property', detail: c.type,
  }))]));

const quoter = (dialect) => (id) =>
  dialect === 'mysql' || dialect === 'mariadb' ? '`' + id.replace(/`/g, '``') + '`' : '"' + id.replace(/"/g, '""') + '"';

export default function Console({ tab, conn, completion, schemaName, onChange, onRun, onCancel, onExport, onSubmitEdits, onSetActive, editorRef }) {
  const viewRef = useRef(null);
  const [split, setSplit] = useState(() => Number(localStorage.getItem('mg.split')) || 0.48);
  const wrap = useRef();

  const dialect = conn?.type || 'postgres';
  const splitDialect = dialect === 'mariadb' ? 'mysql' : dialect;

  // Which text to run: selection, statement under cursor, or whole script.
  const pick = (all) => {
    const v = viewRef.current;
    if (!v) return null;
    const doc = v.state.doc.toString();
    const { from, to } = v.state.selection.main;
    if (all) return { sql: doc, base: 0 };
    if (from !== to) return { sql: doc.slice(from, to), base: from };
    const st = statementAt(doc, from, splitDialect);
    if (!st) return null;
    v.dispatch({ selection: { anchor: st.start, head: st.start + st.text.length } });
    setTimeout(() => v.dispatch({ selection: { anchor: from } }), 350);
    return { sql: st.text, base: st.start };
  };

  useEffect(() => {
    editorRef.current = {
      run: (all) => { const p = pick(all); if (p) onRun(p.sql, p.base); },
      insert: (text) => {
        const v = viewRef.current;
        if (!v) return;
        const { from, to } = v.state.selection.main;
        v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
        v.focus();
      },
      focusAt: (offset) => {
        const v = viewRef.current;
        if (!v) return;
        const pos = Math.min(offset, v.state.doc.length);
        v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        v.focus();
      },
    };
  });

  const extensions = useMemo(() => {
    const lang = sqlLang({ dialect: DIALECT[dialect], schema: toNamespace(completion), upperCaseKeywords: true });
    return [
      lang,
      lang.language.data.of({ autocomplete: columnSource({ schema: completion, defaultSchema: schemaName, dialect: splitDialect, quote: quoter(dialect) }) }),
      theme,
      EditorView.lineWrapping,
      Prec.highest(keymap.of([
        { key: 'Mod-Enter', run: () => { editorRef.current?.run(false); return true; } },
        { key: 'Shift-Mod-Enter', run: () => { editorRef.current?.run(true); return true; } },
      ])),
    ];
  }, [dialect, completion, schemaName]);

  const startDrag = useDrag((e) => {
    const r = wrap.current.getBoundingClientRect();
    const v = Math.max(0.15, Math.min(0.85, (e.clientY - r.top) / r.height));
    setSplit(v);
    localStorage.setItem('mg.split', v);
  });

  const sets = tab.results.filter((r) => r.columns);
  const active = tab.active ?? 'output';
  const activeResult = typeof active === 'number' ? sets[active] : null;

  return (
    <div className="console" ref={wrap}>
      <div className="editor-pane" style={{ height: `${split * 100}%` }}>
        <CodeMirror
          value={tab.sql}
          height="100%"
          theme="dark"
          extensions={extensions}
          basicSetup={{ foldGutter: false, highlightActiveLineGutter: true, autocompletion: true }}
          onChange={(v) => onChange({ sql: v })}
          onCreateEditor={(v) => { viewRef.current = v; }}
          placeholder={conn ? `-- ${conn.name}\n-- Ctrl+Enter runs the statement under the cursor, Ctrl+Shift+Enter runs everything` : '-- Choose a data source for this console in the toolbar'}
        />
      </div>
      <div className="hsplit" onMouseDown={startDrag} />
      <div className="results-pane">
        <div className="result-tabs">
          <button className={'rtab' + (active === 'output' ? ' on' : '')} onClick={() => onSetActive('output')}>
            <Icon name="output" size={14} /> Output
            {tab.log.some((l) => l.kind === 'err') && <span className="err-dot" />}
          </button>
          {sets.map((r, i) => (
            <button key={i} className={'rtab' + (active === i ? ' on' : '')} onClick={() => onSetActive(i)} title={r.sql}>
              <Icon name="table" size={14} /> {sets.length > 1 ? `Result ${i + 1}` : 'Result'}
              <span className="count">{r.total.toLocaleString()}</span>
            </button>
          ))}
          <span className="spacer" />
          {tab.running && (
            <button className="btn sm danger-ghost" onClick={onCancel}><Icon name="stop" size={14} /> Cancel query</button>
          )}
        </div>
        <div className="result-body">
          {tab.running && <div className="running-bar" />}
          {activeResult ? (
            <ResultGrid result={activeResult} dialect={splitDialect} onExport={(e) => onExport(e, activeResult)} onSubmit={onSubmitEdits} />
          ) : (
            <OutputLog log={tab.log} running={tab.running} />
          )}
        </div>
      </div>
    </div>
  );
}

function OutputLog({ log, running }) {
  const ref = useRef();
  useEffect(() => { ref.current && (ref.current.scrollTop = ref.current.scrollHeight); }, [log.length]);
  if (!log.length && !running) {
    return (
      <div className="output-empty">
        <div className="kbd-hints">
          <div><kbd>Ctrl</kbd><kbd>Enter</kbd><span>Run statement at cursor (or selection)</span></div>
          <div><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Enter</kbd><span>Run whole console</span></div>
          <div><kbd>Ctrl</kbd><kbd>Space</kbd><span>Complete tables and columns</span></div>
          <div><kbd>Double-click</kbd><span>a table in the tree to open its data</span></div>
        </div>
      </div>
    );
  }
  return (
    <div className="output" ref={ref}>
      {log.map((l, i) => (
        <div key={i} className={'log-line ' + l.kind}>
          <span className="log-time">{l.time}</span>
          <span className="log-msg">
            {l.sql && <code className="log-sql">{l.sql.length > 160 ? l.sql.slice(0, 160) + '…' : l.sql}</code>}
            <span>{l.text}</span>
          </span>
        </div>
      ))}
      {running && <div className="log-line info"><span className="log-time" /><span className="log-msg"><Icon name="refresh" size={12} className="spin" /> running…</span></div>}
    </div>
  );
}
