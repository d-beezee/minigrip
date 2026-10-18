// Editing result sets in place, like DataGrip's table editor:
// editInfo() decides whether a result can be edited and which key identifies its rows,
// applyChanges() turns the grid's pending changes into UPDATE / INSERT / DELETE in one transaction.

// Values we can't round-trip through the grid's text (shown as 0x… or JSON).
const NOT_EDITABLE = /blob|binary|bytea|\[\]$|^(geometry|point|linestring|polygon)/i;

// -> { schema, table, key: [result column index], cols: [table column name | null] } or { readOnly: reason }.
// Expression columns (no table behind them) stay read-only; the rest of the row can still be edited.
export async function editInfo(d, columns, sql) {
  if (/\b(union|intersect|except)\b/i.test(sql.replace(/'(?:[^']|'')*'/g, ''))) return { readOnly: 'Results of UNION / INTERSECT / EXCEPT cannot be edited' };
  const org = await d.origins(columns);
  const tables = new Map();
  for (const o of org) if (o) tables.set(o.schema + '\0' + o.table, o);
  if (!tables.size) return { readOnly: 'Result does not come from a table' };
  if (tables.size > 1) return { readOnly: 'Result combines several tables' };
  const { schema, table } = tables.values().next().value;

  const meta = await d.columns(schema, table);
  const byName = new Map(meta.map((c) => [c.name, c]));
  const cols = org.map((o) => (o && byName.has(o.column) && !NOT_EDITABLE.test(byName.get(o.column).type) ? o.column : null));
  const info = { schema, table, cols, types: cols.map((n) => (n ? byName.get(n).type : null)) };
  const named = cols.filter(Boolean);
  if (new Set(named).size !== named.length) return { readOnly: 'The same column appears more than once' };

  const pk = meta.filter((c) => c.pk).map((c) => c.name);
  if (pk.length) {
    const key = pk.map((name) => cols.indexOf(name));
    if (!key.includes(-1)) return { ...info, key };
    return { ...info, readOnly: `Add the primary key (${pk.join(', ')}) to the query to edit`, cols: cols.map(() => null) };
  }
  // No primary key: like DataGrip, rows are found by all their values; applyChanges refuses to touch more than one.
  return { ...info, key: cols.flatMap((n, i) => (n ? [i] : [])), noKey: true };
}

const isDefault = (v) => v && typeof v === 'object' && v.$default;

function build(d, target, ch) {
  const params = [];
  const val = (v) => {
    if (isDefault(v)) return 'DEFAULT';
    params.push(v);
    return d.ph(params.length);
  };
  const where = (key) =>
    Object.entries(key).map(([c, v]) => (v === null ? `${d.q(c)} IS NULL` : `${d.q(c)} = ${val(v)}`)).join(' AND ');

  switch (ch.op) {
    case 'update': {
      const set = Object.entries(ch.set).map(([c, v]) => `${d.q(c)} = ${val(v)}`).join(', ');
      return { sql: `UPDATE ${target} SET ${set} WHERE ${where(ch.key)}`, params, one: true };
    }
    case 'delete':
      return { sql: `DELETE FROM ${target} WHERE ${where(ch.key)}`, params, one: true };
    case 'insert': {
      const cols = Object.keys(ch.values).filter((c) => !isDefault(ch.values[c]));
      if (!cols.length) return { sql: d.dialect === 'mysql' ? `INSERT INTO ${target} () VALUES ()` : `INSERT INTO ${target} DEFAULT VALUES`, params };
      return { sql: `INSERT INTO ${target} (${cols.map(d.q).join(', ')}) VALUES (${cols.map((c) => val(ch.values[c])).join(', ')})`, params };
    }
    default:
      throw new Error('Unknown change ' + ch.op);
  }
}

// The statement with its values inlined, for the console log.
function inline(d, { sql, params }) {
  if (d.dialect === 'postgres') return sql.replace(/\$(\d+)/g, (m, n) => d.lit(params[n - 1]));
  let i = 0;
  return sql.replace(/\?/g, () => d.lit(params[i++]));
}

export async function applyChanges(d, schema, table, changes) {
  const target = d.q(schema) + '.' + d.q(table);
  const stmts = changes.map((ch) => build(d, target, ch));
  const log = stmts.map((st) => inline(d, st));
  await d.query(d.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN');
  try {
    for (const [i, st] of stmts.entries()) {
      const [r] = await d.query(st.sql, st.params);
      if (st.one && r.affected !== 1) {
        throw Object.assign(new Error(r.affected
          ? `${log[i]} would change ${r.affected} rows, not 1: nothing was saved`
          : `Row not found (changed or deleted since it was loaded): ${log[i]}`), { statement: i });
      }
    }
    await d.query('COMMIT');
  } catch (e) {
    await d.query('ROLLBACK').catch(() => {});
    throw e;
  }
  return { statements: log };
}
