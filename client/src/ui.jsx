import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/* ------------------------------------------------------------------ icons (inline SVG, 16px) */

const P = {
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  play: 'M5 3.5v9l7.5-4.5z',
  playAll: 'M3 3.5v9l6-4.5zM9 3.5v9l6-4.5z',
  stop: 'M4 4h8v8H4z',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3',
  chevron: 'M6 4l4 4-4 4',
  close: 'M4 4l8 8M12 4l-8 8',
  download: 'M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10',
  upload: 'M8 10.5v-8M4.5 6L8 2.5 11.5 6M3 13.5h10',
  table: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 6.5v6',
  view: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M5 9h6M5 11h4',
  fn: 'M10.5 3c-2 0-2 1.5-2.3 3.5L7.5 11c-.3 1.6-.8 2-2.3 2M5.5 7h5',
  column: 'M4 3v10M4 8h7',
  key: 'M10 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8.2 7.8L3 13M5 11l1.5 1.5',
  schema: 'M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z',
  db: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
  console: 'M2.5 3.5h11v9h-11zM5 7l2 1.5L5 10M8.5 10.5h3',
  history: 'M3 8a5 5 0 1 0 1.5-3.5M3 3v2.5h2.5M8 5.5V8l2 1.5',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  filter: 'M2.5 3.5h11L9.5 8.5v4l-3-1.5v-2.5z',
  edit: 'M3 13l.5-2.5L10.5 3.5l2 2L5.5 12.5zM9 5l2 2',
  trash: 'M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5',
  plug: 'M6 2.5v3M10 2.5v3M4.5 5.5h7v2a3.5 3.5 0 0 1-7 0zM8 11v2.5',
  unplug: 'M3 3l10 10M6 2.5v3M10 2.5v3M11.5 7.5v-2h-4M4.5 5.5v2A3.5 3.5 0 0 0 10 10.4M8 11v2.5',
  lock: 'M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2',
  output: 'M3 4h10M3 7h10M3 10h6M3 13h8',
  check: 'M3.5 8.5l3 3 6-7',
  warn: 'M8 2.5l6 10.5H2zM8 6.5v3M8 11.2v.3',
  wrench: 'M10 2.5a3 3 0 0 0-2.7 4.3L3 11.1 4.9 13l4.3-4.3A3 3 0 0 0 13.5 6l-1.8 1.8-1.8-.3-.3-1.8z',
};

export function Icon({ name, size = 16, className = '', style }) {
  return (
    <svg className={'icon ' + className} style={style} width={size} height={size} viewBox="0 0 16 16"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] || ''} />
    </svg>
  );
}

/* ------------------------------------------------------------------ modal */

export function Modal({ title, onClose, children, footer, width = 560 }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-label={title}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} title="Close"><Icon name="close" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ context menu */

export function ContextMenu({ menu, onClose }) {
  const ref = useRef();
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 4),
      y: Math.min(menu.y, window.innerHeight - r.height - 4),
    });
  }, [menu]);
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    const key = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return (
    <div className="ctx" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {menu.items.filter(Boolean).map((it, i) =>
        it.sep ? <div key={i} className="ctx-sep" /> : it.header ? <div key={i} className="ctx-header">{it.header}</div> : (
          <button key={i} className={'ctx-item' + (it.danger ? ' danger' : '')} disabled={it.disabled}
            onClick={() => { onClose(); it.onClick(); }}>
            <span className="ctx-icon">{it.icon && <Icon name={it.icon} />}</span>
            <span>{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
          </button>
        ))}
    </div>
  );
}

/* ------------------------------------------------------------------ split pane drag handle */

export function useDrag(onMove) {
  return (e) => {
    e.preventDefault();
    const move = (ev) => onMove(ev);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('dragging');
    };
    document.body.classList.add('dragging');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
}

export function Field({ label, children, hint, wide }) {
  return (
    <label className={'field' + (wide ? ' wide' : '')}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

export const TYPE_LABEL = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite' };
