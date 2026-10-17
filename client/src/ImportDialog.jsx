import { useState, useRef } from 'react';
import { api } from './api.js';
import { Modal, Field, Icon, fmtBytes } from './ui.jsx';

const guessFormat = (name) => {
  const ext = name.split('.').pop().toLowerCase();
  return { tsv: 'tsv', tab: 'tsv', json: 'json', sql: 'sql', txt: 'csv' }[ext] || 'csv';
};

// Import CSV/TSV/JSON into a table, or run a .sql script.
export default function ImportDialog({ target, onClose, onDone }) {
  const { conn, schema, table: fixedTable, mode } = target; // mode: 'data' | 'sql'
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [format, setFormat] = useState(mode === 'sql' ? 'sql' : 'csv');
  const [table, setTable] = useState(fixedTable || '');
  const [opts, setOpts] = useState({ header: true, delimiter: '', createTable: !fixedTable, truncate: false, emptyAsNull: true, stopOnError: true });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [drag, setDrag] = useState(false);
  const input = useRef();

  async function choose(f) {
    if (!f) return;
    setFile(f);
    setResult(null);
    const fmt = mode === 'sql' ? 'sql' : guessFormat(f.name);
    setFormat(fmt === 'sql' && mode !== 'sql' ? 'csv' : fmt);
    if (!fixedTable && mode !== 'sql') setTable(f.name.replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_').toLowerCase());
    setText(await f.text());
  }

  const lines = text ? text.split('\n', 6).slice(0, 5) : [];
  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.importData(conn.id, { schema, table, text, format, ...opts });
      setResult({ ok: !r.errors?.length, ...r });
      onDone?.(r);
    } catch (e) {
      setResult({ ok: false, error: e.message });
    } finally {
      setBusy(false);
    }
  }

  const isSql = format === 'sql';
  const canRun = text && (isSql || table.trim()) && !busy;

  return (
    <Modal
      title={mode === 'sql' ? `Run SQL script — ${conn.name}` : `Import data — ${schema}${fixedTable ? '.' + fixedTable : ''}`}
      onClose={onClose}
      width={600}
      footer={
        <>
          <span className="dim">{conn.name} · {schema}</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>{result?.ok ? 'Close' : 'Cancel'}</button>
          <button className="btn primary" disabled={!canRun} onClick={run}>
            {busy ? <><Icon name="refresh" className="spin" /> Working…</> : isSql ? <><Icon name="play" /> Run script</> : <><Icon name="upload" /> Import</>}
          </button>
        </>
      }
    >
      <div
        className={'dropzone' + (drag ? ' over' : '') + (file ? ' has' : '')}
        onClick={() => input.current.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); choose(e.dataTransfer.files[0]); }}
      >
        <input ref={input} type="file" hidden accept={mode === 'sql' ? '.sql,.txt' : '.csv,.tsv,.txt,.json'} onChange={(e) => choose(e.target.files[0])} />
        <Icon name="upload" size={22} />
        {file ? (
          <div><b>{file.name}</b><span className="dim"> · {fmtBytes(file.size)}</span><div className="dim small">Click to choose another file</div></div>
        ) : (
          <div><b>Drop a file here</b> or click to browse<div className="dim small">{mode === 'sql' ? '.sql script' : 'CSV, TSV or JSON (array of objects)'}</div></div>
        )}
      </div>

      {file && mode !== 'sql' && (
        <div className="form-grid">
          <Field label="Format">
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="csv">CSV</option>
              <option value="tsv">TSV</option>
              <option value="json">JSON</option>
            </select>
          </Field>
          <Field label="Target table">
            <input value={table} disabled={!!fixedTable} onChange={(e) => setTable(e.target.value)} />
          </Field>
          {format !== 'json' && (
            <>
              <Field label="Delimiter" hint="Empty = auto (comma / tab)">
                <input value={opts.delimiter} maxLength={2} onChange={(e) => setOpt('delimiter', e.target.value)} placeholder={format === 'tsv' ? '\\t' : ','} />
              </Field>
              <label className="check" style={{ alignSelf: 'end' }}>
                <input type="checkbox" checked={opts.header} onChange={(e) => setOpt('header', e.target.checked)} /> First row is header
              </label>
            </>
          )}
          <label className="check wide"><input type="checkbox" checked={opts.createTable} onChange={(e) => setOpt('createTable', e.target.checked)} /> Create the table if it doesn't exist (all columns as text)</label>
          <label className="check wide"><input type="checkbox" checked={opts.truncate} onChange={(e) => setOpt('truncate', e.target.checked)} /> Delete existing rows first</label>
          <label className="check wide"><input type="checkbox" checked={opts.emptyAsNull} onChange={(e) => setOpt('emptyAsNull', e.target.checked)} /> Empty values become NULL</label>
          <p className="note wide">Rows are inserted in one transaction: on any error nothing is imported.</p>
        </div>
      )}

      {file && mode === 'sql' && (
        <div className="form-grid">
          <label className="check wide"><input type="checkbox" checked={opts.stopOnError} onChange={(e) => setOpt('stopOnError', e.target.checked)} /> Stop at the first error</label>
        </div>
      )}

      {lines.length > 0 && (
        <pre className="preview">{lines.map((l) => (l.length > 140 ? l.slice(0, 140) + '…' : l)).join('\n')}</pre>
      )}

      {result && (
        <div className={'status-line ' + (result.ok ? 'ok' : 'err')}>
          <Icon name={result.ok ? 'check' : 'warn'} />
          <span>
            {result.error
              ? result.error
              : isSql
                ? <>Executed {result.executed} of {result.total} statements.{result.errors.map((e) => <div key={e.index} className="small">#{e.index}: {e.message}</div>)}</>
                : <>Imported {result.inserted.toLocaleString()} rows into {table}{result.created ? ' (table created)' : ''}.</>}
          </span>
        </div>
      )}
    </Modal>
  );
}
