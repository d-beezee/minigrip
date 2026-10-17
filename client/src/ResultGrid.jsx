import { useMemo, useRef, useState, useEffect } from 'react';
import { Icon, Modal } from './ui.jsx';

const ROW_H = 24;
const NUM_W = 52;

const isNumType = (t) => /int|long|short|tiny|float|double|decimal|numeric|newdecimal|real|year/i.test(t || '');

function initialWidths(result) {
  return result.columns.map((col, i) => {
    let len = col.name.length + (col.type?.length || 0) + 3;
    for (const r of result.rows.slice(0, 80)) {
      const v = r[i];
      len = Math.max(len, v === null ? 4 : String(v).length);
    }
    return Math.max(60, Math.min(360, len * 7.4 + 22));
  });
}

const toTsv = (cols, rows) =>
  [cols.join('\t'), ...rows.map((r) => r.map((v) => (v === null ? '' : String(v).replace(/[\t\n]/g, ' '))).join('\t'))].join('\n');

export default function ResultGrid({ result, onExport }) {
  const [widths, setWidths] = useState(() => initialWidths(result));
  const [sort, setSort] = useState(null); // { col, dir }
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState(null); // { r, c } in view coordinates
  const [scroll, setScroll] = useState({ top: 0, h: 400 });
  const [viewer, setViewer] = useState(null);
  const [copied, setCopied] = useState('');
  const box = useRef();

  useEffect(() => {
    setWidths(initialWidths(result));
    setSort(null);
    setSel(null);
    if (box.current) box.current.scrollTop = 0;
  }, [result]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view = useMemo(() => {
    let rows = result.rows.map((r, i) => ({ r, i }));
    const f = filter.trim().toLowerCase();
    if (f) rows = rows.filter(({ r }) => r.some((v) => v !== null && String(v).toLowerCase().includes(f)));
    if (sort) {
      const { col, dir } = sort;
      const num = isNumType(result.columns[col].type);
      rows.sort((a, b) => {
        const x = a.r[col], y = b.r[col];
        if (x === y) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        const cmp = num ? Number(x) - Number(y) : String(x).localeCompare(String(y), undefined, { numeric: true });
        return cmp * dir;
      });
    }
    return rows;
  }, [result, filter, sort]);

  const totalW = NUM_W + widths.reduce((a, b) => a + b, 0);
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - 10);
  const last = Math.min(view.length, Math.ceil((scroll.top + scroll.h) / ROW_H) + 10);

  function resizeCol(e, i) {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, w0 = widths[i];
    const move = (ev) => setWidths((ws) => ws.map((w, j) => (j === i ? Math.max(40, w0 + ev.clientX - x0) : w)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('dragging-col'); };
    document.body.classList.add('dragging-col');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function flash(msg) {
    setCopied(msg);
    setTimeout(() => setCopied(''), 1200);
  }

  function copy(text, msg) {
    navigator.clipboard?.writeText(text).then(() => flash(msg));
  }

  function onKey(e) {
    if (!sel) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'c') {
      const v = view[sel.r]?.r[sel.c];
      copy(v === null ? '' : String(v), 'Cell copied');
      e.preventDefault();
      return;
    }
    const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageDown: [20, 0], PageUp: [-20, 0] }[e.key];
    if (mv) {
      e.preventDefault();
      const r = Math.max(0, Math.min(view.length - 1, sel.r + mv[0]));
      const c = Math.max(0, Math.min(result.columns.length - 1, sel.c + mv[1]));
      setSel({ r, c });
      const el = box.current;
      const y = r * ROW_H;
      if (y < el.scrollTop) el.scrollTop = y;
      else if (y + ROW_H * 2 > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H * 2 - el.clientHeight;
    }
    if (e.key === 'Enter') {
      const v = view[sel.r]?.r[sel.c];
      setViewer({ col: result.columns[sel.c], value: v });
    }
  }

  const names = result.columns.map((c) => c.name);

  return (
    <div className="grid-wrap">
      <div className="grid-toolbar">
        <span className="grid-meta">
          <b>{view.length.toLocaleString()}</b>{filter ? ` of ${result.rows.length.toLocaleString()}` : ''} row{view.length === 1 ? '' : 's'}
          {result.truncated && <span className="warn-chip" title="Export re-runs the query and includes every row">first {result.rows.length.toLocaleString()} of {result.total.toLocaleString()}</span>}
          <span className="dim"> · {result.ms} ms</span>
        </span>
        <span className="spacer" />
        {copied && <span className="copied"><Icon name="check" size={12} /> {copied}</span>}
        <div className="search">
          <Icon name="filter" size={14} />
          <input placeholder="Filter rows…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button className="btn sm ghost" title="Copy visible rows as TSV (paste into a spreadsheet)"
          onClick={() => copy(toTsv(names, view.map((x) => x.r)), `${view.length} rows copied`)}>
          <Icon name="copy" /> Copy
        </button>
        <button className="btn sm ghost" onClick={(e) => onExport(e)}><Icon name="download" /> Export</button>
      </div>

      <div className="grid" ref={box} tabIndex={0} onKeyDown={onKey}
        onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}>
        <div style={{ width: totalW, height: (view.length + 1) * ROW_H, position: 'relative' }}>
          <div className="grid-head" style={{ width: totalW }}>
            <div className="gcell num head" style={{ width: NUM_W }} />
            {result.columns.map((col, i) => (
              <div key={i} className={'gcell head' + (sort?.col === i ? ' sorted' : '')} style={{ width: widths[i] }}
                title={`${col.name} · ${col.type}\nClick to sort`}
                onClick={() => setSort((s) => (s?.col !== i ? { col: i, dir: 1 } : s.dir === 1 ? { col: i, dir: -1 } : null))}>
                <span className="hname">{col.name}</span>
                <span className="htype">{col.type}</span>
                {sort?.col === i && <span className="sort-ind">{sort.dir === 1 ? '▲' : '▼'}</span>}
                <span className="col-resize" onMouseDown={(e) => resizeCol(e, i)} onClick={(e) => e.stopPropagation()} />
              </div>
            ))}
          </div>
          {view.slice(first, last).map(({ r, i: orig }, k) => {
            const ri = first + k;
            return (
              <div key={ri} className={'grow' + (ri % 2 ? ' odd' : '') + (sel?.r === ri ? ' selrow' : '')}
                style={{ top: (ri + 1) * ROW_H, width: totalW }}>
                <div className="gcell num" style={{ width: NUM_W }}>{orig + 1}</div>
                {r.map((v, c) => (
                  <div key={c}
                    className={'gcell' + (v === null ? ' null' : '') + (isNumType(result.columns[c].type) ? ' right' : '') + (sel?.r === ri && sel?.c === c ? ' sel' : '')}
                    style={{ width: widths[c] }}
                    onMouseDown={() => setSel({ r: ri, c })}
                    onDoubleClick={() => setViewer({ col: result.columns[c], value: v })}>
                    {v === null ? 'NULL' : String(v)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {!result.rows.length && <div className="grid-empty">Query returned no rows</div>}
      </div>

      {viewer && <ValueViewer {...viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

function ValueViewer({ col, value, onClose }) {
  let text = value === null ? '' : String(value);
  let json = false;
  if (/^\s*[[{]/.test(text)) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); json = true; } catch { /* not JSON */ }
  }
  return (
    <Modal title={`${col.name} — ${col.type}${json ? ' (JSON)' : ''}`} onClose={onClose} width={680}
      footer={<>
        <span className="dim">{value === null ? 'NULL' : `${String(value).length.toLocaleString()} chars`}</span>
        <span className="spacer" />
        <button className="btn" onClick={() => navigator.clipboard?.writeText(value === null ? '' : String(value))}><Icon name="copy" /> Copy</button>
        <button className="btn primary" onClick={onClose}>Close</button>
      </>}>
      <pre className="value-view">{value === null ? <span className="null">NULL</span> : text}</pre>
    </Modal>
  );
}
