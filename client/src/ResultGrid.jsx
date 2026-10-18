import { useMemo, useRef, useState, useEffect } from 'react';
import { Icon, Modal, ContextMenu } from './ui.jsx';

const ROW_H = 24;
const NUM_W = 52;
const DEFAULT = Object.freeze({ $default: true }); // "use the column default" in pending edits

const isNumType = (t) => /int|long|short|tiny|float|double|decimal|numeric|newdecimal|real|year/i.test(t || '');
const isDefault = (v) => v === DEFAULT || (v && typeof v === 'object' && v.$default);
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

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
  [cols.join('\t'), ...rows.map((r) => r.map((v) => (v == null || isDefault(v) ? '' : String(v).replace(/[\t\n]/g, ' '))).join('\t'))].join('\n');

const EMPTY = { edits: {}, added: [], deleted: new Set() };

export default function ResultGrid({ result, dialect, onExport, onSubmit }) {
  const [widths, setWidths] = useState(() => initialWidths(result));
  const [sort, setSort] = useState(null); // { col, dir }
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState(null); // { r, c } in view coordinates
  const [scroll, setScroll] = useState({ top: 0, h: 400 });
  const [viewer, setViewer] = useState(null);
  const [copied, setCopied] = useState('');
  // Pending changes, keyed by row index into rows (result rows, then added rows):
  // edits { [row]: { [col]: value } }, added [[value | undefined = default]], deleted Set<row>
  const [pending, setPending] = useState(EMPTY);
  const [editing, setEditing] = useState(null); // { row, c, text }
  const [menu, setMenu] = useState(null);
  const [saving, setSaving] = useState(false);
  const box = useRef();
  const skipBlur = useRef(false); // the cell input is leaving through Enter / Escape / Tab, not a click away
  const submitRef = useRef();

  const edit = result.edit;
  const editable = !!(onSubmit && edit && !edit.readOnly);
  const canEdit = (c) => editable && edit.cols[c] != null;
  const base = result.rows.length;

  useEffect(() => {
    setWidths(initialWidths(result));
    setSort(null);
    setSel(null);
    setPending(EMPTY);
    setEditing(null);
    if (box.current) box.current.scrollTop = 0;
  }, [result]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // current value of a cell, pending edits included
  const valueAt = (i, c) => {
    if (has(pending.edits[i], c)) return pending.edits[i][c];
    return i < base ? result.rows[i][c] : pending.added[i - base][c];
  };

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
    // added rows always sit at the bottom, outside filter and sort
    return rows.concat(pending.added.map((r, k) => ({ r, i: base + k })));
  }, [result, filter, sort, pending.added]);

  const changeCount = Object.values(pending.edits).reduce((n, e) => n + Object.keys(e).length, 0) + pending.added.length + pending.deleted.size;

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

  function moveTo(r, c) {
    r = Math.max(0, Math.min(view.length - 1, r));
    c = Math.max(0, Math.min(result.columns.length - 1, c));
    setSel({ r, c });
    const el = box.current;
    const y = r * ROW_H;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW_H * 2 > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H * 2 - el.clientHeight;
  }

  /* ------------------------------------------------------------ editing */

  function setCell(i, c, v) {
    setPending((p) => {
      const orig = i < base ? result.rows[i][c] : undefined;
      const row = { ...p.edits[i] };
      // back to the loaded value: no longer a change
      if (i < base && !isDefault(v) && (v === orig || (v !== null && orig !== null && String(v) === String(orig)))) delete row[c];
      else row[c] = v;
      const edits = { ...p.edits };
      if (Object.keys(row).length) edits[i] = row; else delete edits[i];
      return { ...p, edits };
    });
  }

  function startEdit(r, c, text) {
    const row = view[r];
    if (!row || !canEdit(c) || pending.deleted.has(row.i)) return false;
    const v = valueAt(row.i, c);
    const cur = v === null || v === undefined || isDefault(v) ? '' : String(v);
    if (text === undefined && cur.includes('\n')) {
      setViewer({ row: row.i, c });
      return true;
    }
    skipBlur.current = false;
    setEditing({ row: row.i, c, text: text ?? cur });
    return true;
  }

  function commitEdit(move) {
    if (!editing) return;
    skipBlur.current = true;
    const v = valueAt(editing.row, editing.c);
    // unchanged text keeps the value, so leaving a NULL / default cell empty keeps it NULL / default
    if (editing.text !== (v === null || v === undefined || isDefault(v) ? '' : String(v))) setCell(editing.row, editing.c, editing.text);
    setEditing(null);
    box.current?.focus();
    if (move && sel) moveTo(sel.r + move[0], sel.c + move[1]);
  }

  function cancelEdit() {
    skipBlur.current = true;
    setEditing(null);
    box.current?.focus();
  }

  function setSelected(v) {
    if (!sel) return;
    const row = view[sel.r];
    if (!row || !canEdit(sel.c) || pending.deleted.has(row.i)) return;
    if (isDefault(v) && row.i < base && dialect === 'sqlite') return;
    setCell(row.i, sel.c, v);
  }

  function addRow() {
    if (!editable) return;
    setPending((p) => ({ ...p, added: [...p.added, result.columns.map(() => undefined)] }));
    setSel({ r: view.length, c: Math.max(0, edit.cols.findIndex((n) => n != null)) });
    setTimeout(() => { box.current.scrollTop = box.current.scrollHeight; box.current.focus(); }, 0);
  }

  // New row with the selected row's values, keys left to their defaults
  function cloneRow() {
    if (!editable || !sel || !view[sel.r]) return;
    const i = view[sel.r].i;
    const keys = edit.noKey ? [] : edit.key;
    const row = result.columns.map((_, c) => (edit.cols[c] == null || keys.includes(c) ? undefined : valueAt(i, c)));
    setPending((p) => ({ ...p, added: [...p.added, row] }));
    setSel({ r: view.length, c: sel.c });
    setTimeout(() => { box.current.scrollTop = box.current.scrollHeight; }, 0);
  }

  function deleteRow() {
    if (!editable || !sel) return;
    const row = view[sel.r];
    if (!row) return;
    setPending((p) => {
      if (row.i >= base) {
        // a row that was never saved just goes away; later added rows shift down
        const k = row.i - base;
        const edits = {};
        for (const [i, e] of Object.entries(p.edits)) {
          const n = Number(i);
          if (n < row.i) edits[n] = e;
          else if (n > row.i) edits[n - 1] = e;
        }
        return { ...p, edits, added: p.added.filter((_, j) => j !== k) };
      }
      const deleted = new Set(p.deleted);
      if (deleted.has(row.i)) deleted.delete(row.i); else deleted.add(row.i);
      return { ...p, deleted };
    });
  }

  // Revert the selected cell, or the whole row from the row header
  function revertSelected(wholeRow) {
    if (!sel) return;
    const row = view[sel.r];
    if (!row) return;
    if (row.i >= base) return deleteRow();
    setPending((p) => {
      const deleted = new Set(p.deleted);
      deleted.delete(row.i);
      const edits = { ...p.edits };
      if (wholeRow || !has(edits[row.i], sel.c)) delete edits[row.i];
      else {
        const e = { ...edits[row.i] };
        delete e[sel.c];
        if (Object.keys(e).length) edits[row.i] = e; else delete edits[row.i];
      }
      return { ...p, edits, deleted };
    });
  }

  function buildChanges() {
    const keyOf = (i) => Object.fromEntries(edit.key.map((c) => [edit.cols[c], result.rows[i][c]]));
    const changes = [];
    for (const i of [...pending.deleted].sort((a, b) => a - b)) changes.push({ op: 'delete', key: keyOf(i) });
    for (const [k, e] of Object.entries(pending.edits)) {
      const i = Number(k);
      if (i >= base || pending.deleted.has(i)) continue;
      changes.push({ op: 'update', key: keyOf(i), set: Object.fromEntries(Object.entries(e).map(([c, v]) => [edit.cols[c], v])) });
    }
    pending.added.forEach((r, k) => {
      const values = {};
      r.forEach((_, c) => {
        const v = valueAt(base + k, c);
        if (edit.cols[c] != null && v !== undefined && !isDefault(v)) values[edit.cols[c]] = v;
      });
      changes.push({ op: 'insert', values });
    });
    return changes;
  }

  async function submit() {
    if (!changeCount || saving) return;
    setSaving(true);
    try {
      if (await onSubmit(result, buildChanges())) setPending(EMPTY);
    } finally {
      setSaving(false);
    }
  }

  submitRef.current = submit;

  function revertAll() {
    setPending(EMPTY);
    setEditing(null);
  }

  /* ------------------------------------------------------------ keyboard & menus */

  function onKey(e) {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (editable && mod && e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (editable && e.altKey && e.key === 'Insert') { e.preventDefault(); addRow(); return; }
    if (!sel) return;
    if (!view[sel.r]) return;
    if (mod && e.key === 'c') {
      const v = valueAt(view[sel.r].i, sel.c);
      copy(v === null || v === undefined || isDefault(v) ? '' : String(v), 'Cell copied');
      e.preventDefault();
      return;
    }
    if (editable) {
      if (mod && (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'y')) { e.preventDefault(); deleteRow(); return; }
      if (mod && e.key === 'd') { e.preventDefault(); cloneRow(); return; }
      if (mod && e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); setSelected(null); return; }
      if (mod && e.altKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); setSelected(DEFAULT); return; }
      if (mod && e.altKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); revertSelected(false); return; }
      if (e.key === 'F2' || (e.key === 'Enter' && !e.shiftKey)) {
        // Enter, F2 and Alt+Enter all edit, as in DataGrip
        e.preventDefault();
        if (startEdit(sel.r, sel.c) || e.key === 'F2') return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); startEdit(sel.r, sel.c, ''); return; }
      // typing on a cell starts editing it with that character, like a spreadsheet
      if (e.key.length === 1 && !mod && !e.altKey) { if (startEdit(sel.r, sel.c, e.key)) e.preventDefault(); return; }
    }
    const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageDown: [20, 0], PageUp: [-20, 0], Tab: [0, e.shiftKey ? -1 : 1] }[e.key];
    if (mv) {
      e.preventDefault();
      moveTo(sel.r + mv[0], sel.c + mv[1]);
    }
    if (e.key === 'Enter') setViewer({ row: view[sel.r].i, c: sel.c });
  }

  function cellMenu(e, r, c) {
    e.preventDefault();
    setSel({ r, c });
    box.current?.focus();
    const row = view[r];
    const v = valueAt(row.i, c);
    const gone = pending.deleted.has(row.i);
    const ok = canEdit(c) && !gone;
    const changed = has(pending.edits[row.i], c);
    const items = [
      { label: 'Copy value', icon: 'copy', hint: 'Ctrl+C', onClick: () => copy(v === null || v === undefined || isDefault(v) ? '' : String(v), 'Cell copied') },
      { label: 'Open value…', icon: 'view', hint: 'Shift+Enter', onClick: () => setViewer({ row: row.i, c }) },
    ];
    if (editable) {
      items.push(
        { sep: true },
        { label: 'Edit', icon: 'edit', hint: 'F2', disabled: !ok, onClick: () => startEdit(r, c) },
        { label: 'Set NULL', icon: 'close', hint: 'Ctrl+Alt+N', disabled: !ok, onClick: () => setCell(row.i, c, null) },
        { label: 'Set DEFAULT', icon: 'refresh', hint: 'Ctrl+Alt+D', disabled: !ok || (row.i < base && dialect === 'sqlite'), onClick: () => setCell(row.i, c, DEFAULT) },
        { label: 'Revert', icon: 'history', hint: 'Ctrl+Alt+Z', disabled: !changed && !gone && row.i < base, onClick: () => revertSelected(false) },
        { sep: true },
        { label: 'Add row', icon: 'plus', hint: 'Alt+Insert', onClick: addRow },
        { label: 'Clone row', icon: 'copy', hint: 'Ctrl+D', disabled: gone, onClick: cloneRow },
        { label: gone ? 'Restore row' : 'Delete row', icon: 'trash', hint: 'Ctrl+Y', danger: !gone, onClick: deleteRow },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  const names = result.columns.map((c) => c.name);
  const viewerCol = viewer && result.columns[viewer.c];

  return (
    <div className="grid-wrap">
      <div className="grid-toolbar">
        <span className="grid-meta">
          <b>{view.length.toLocaleString()}</b>{filter ? ` of ${result.rows.length.toLocaleString()}` : ''} row{view.length === 1 ? '' : 's'}
          {result.truncated && <span className="warn-chip" title="Export re-runs the query and includes every row">first {result.rows.length.toLocaleString()} of {result.total.toLocaleString()}</span>}
          <span className="dim"> · {result.ms} ms</span>
        </span>
        {editable && (
          <span className="edit-tools">
            <button className="icon-btn" title="Add row (Alt+Insert)" onClick={addRow}><Icon name="plus" /></button>
            <button className="icon-btn" title="Delete row (Ctrl+Y)" disabled={!sel} onClick={deleteRow}><Icon name="minus" /></button>
            {changeCount > 0 && <>
              <span className="pending-chip">{changeCount} pending change{changeCount === 1 ? '' : 's'}</span>
              <button className="btn sm ghost" onClick={revertAll} title="Discard all pending changes"><Icon name="history" /> Revert</button>
              <button className="btn sm primary" onClick={submit} disabled={saving} title={`Save to ${edit.table} (Ctrl+Enter)`}>
                {saving ? <Icon name="refresh" className="spin" /> : <Icon name="check" />} Submit
              </button>
            </>}
          </span>
        )}
        {onSubmit && edit?.readOnly && <span className="ro-chip" title={'Result set is read-only: ' + edit.readOnly}><Icon name="lock" size={12} /> read-only</span>}
        {editable && edit.noKey && <span className="warn-chip" title={`${edit.table} has no primary key: rows are matched by all their values, and a change that would hit more than one row is refused`}>no primary key</span>}
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
                title={`${col.name} · ${col.type}${editable && !canEdit(i) ? '\nRead-only (not a column of ' + edit.table + ')' : ''}\nClick to sort`}
                onClick={() => setSort((s) => (s?.col !== i ? { col: i, dir: 1 } : s.dir === 1 ? { col: i, dir: -1 } : null))}>
                {editable && !edit.noKey && edit.key.includes(i) && <Icon name="key" size={11} className="hkey" />}
                <span className="hname">{col.name}</span>
                <span className="htype">{col.type}</span>
                {sort?.col === i && <span className="sort-ind">{sort.dir === 1 ? '▲' : '▼'}</span>}
                <span className="col-resize" onMouseDown={(e) => resizeCol(e, i)} onClick={(e) => e.stopPropagation()} />
              </div>
            ))}
          </div>
          {view.slice(first, last).map(({ r, i: orig }, k) => {
            const ri = first + k;
            const added = orig >= base;
            const gone = pending.deleted.has(orig);
            return (
              <div key={ri} className={'grow' + (ri % 2 ? ' odd' : '') + (sel?.r === ri ? ' selrow' : '') + (added ? ' added' : '') + (gone ? ' deleted' : '')}
                style={{ top: (ri + 1) * ROW_H, width: totalW }}>
                <div className="gcell num" style={{ width: NUM_W }}>{added ? '+' : orig + 1}</div>
                {r.map((_, c) => {
                  const v = valueAt(orig, c);
                  const isEd = editing?.row === orig && editing.c === c;
                  const dflt = v === undefined || isDefault(v);
                  return (
                    <div key={c}
                      className={'gcell' + (v === null ? ' null' : '') + (dflt ? ' dflt' : '') + (isNumType(result.columns[c].type) ? ' right' : '')
                        + (has(pending.edits[orig], c) ? ' changed' : '') + (sel?.r === ri && sel?.c === c ? ' sel' : '') + (isEd ? ' editing' : '')}
                      style={{ width: widths[c] }}
                      onMouseDown={() => { if (!isEd) { if (editing) commitEdit(); setSel({ r: ri, c }); } }}
                      onContextMenu={(e) => cellMenu(e, ri, c)}
                      onDoubleClick={() => { if (!startEdit(ri, c)) setViewer({ row: orig, c }); }}>
                      {isEd ? (
                        <input className="cell-input" autoFocus value={editing.text}
                          onChange={(e) => setEditing((x) => ({ ...x, text: e.target.value }))}
                          onBlur={() => !skipBlur.current && commitEdit()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Escape') cancelEdit();
                            else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { commitEdit(); setTimeout(() => submitRef.current(), 0); }
                            else if (e.key === 'Enter') { e.preventDefault(); commitEdit(e.shiftKey ? [-1, 0] : [1, 0]); }
                            else if (e.key === 'Tab') { e.preventDefault(); commitEdit([0, e.shiftKey ? -1 : 1]); }
                          }} />
                      ) : v === null ? 'NULL' : dflt ? '<default>' : String(v)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {!result.rows.length && !pending.added.length && <div className="grid-empty">Query returned no rows{editable ? ' · Alt+Insert adds one' : ''}</div>}
      </div>

      {viewer && (
        <ValueViewer col={viewerCol} value={valueAt(viewer.row, viewer.c)}
          editable={canEdit(viewer.c) && !pending.deleted.has(viewer.row)}
          onSave={(text) => { setCell(viewer.row, viewer.c, text); setViewer(null); box.current?.focus(); }}
          onClose={() => { setViewer(null); box.current?.focus(); }} />
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function ValueViewer({ col, value, editable, onSave, onClose }) {
  const isNull = value === null || value === undefined || isDefault(value);
  let text = isNull ? '' : String(value);
  let json = false;
  if (/^\s*[[{]/.test(text)) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); json = true; } catch { /* not JSON */ }
  }
  const [draft, setDraft] = useState(text);
  const save = () => {
    // pretty-printed JSON goes back compact, as long as it still parses
    let out = draft;
    if (json) { try { out = JSON.stringify(JSON.parse(draft)); } catch { /* keep as typed */ } }
    onSave(out);
  };
  return (
    <Modal title={`${col.name} — ${col.type}${json ? ' (JSON)' : ''}`} onClose={onClose} width={680}
      footer={<>
        <span className="dim">{value === null ? 'NULL' : isDefault(value) || value === undefined ? 'DEFAULT' : `${String(value).length.toLocaleString()} chars`}</span>
        <span className="spacer" />
        <button className="btn" onClick={() => navigator.clipboard?.writeText(editable ? draft : text)}><Icon name="copy" /> Copy</button>
        {editable ? <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={draft === text} onClick={save}>Apply</button>
        </> : <button className="btn primary" onClick={onClose}>Close</button>}
      </>}>
      {editable ? (
        <textarea className="value-edit" autoFocus value={draft} spellCheck={false} placeholder={value === null ? 'NULL' : ''}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (draft !== text) save(); } }} />
      ) : (
        <pre className="value-view">{value === null ? <span className="null">NULL</span> : text}</pre>
      )}
    </Modal>
  );
}
