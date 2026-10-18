// Column completion for the console, DataGrip-style: unqualified names offer the columns of the
// tables the current statement reads or writes (FROM, JOIN, UPDATE, INSERT INTO), ranked above
// tables and keywords. `alias.` / `table.` completion is left to @codemirror/lang-sql.
import { syntaxTree } from '@codemirror/language';
import { statementAt } from '@shared/split.js';

const TOKEN = /(`(?:[^`]|``)*`|"(?:[^"]|"")*"|\[[^\]]*\]|'(?:[^'\\]|''|\\.)*'?|--[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[A-Za-z_$ -￿][\w$ -￿]*|\d[\w.]*|\S)/g;
const NOT_ALIAS = new Set(('where join inner left right full cross outer natural straight_join on using group order limit having ' +
  'union intersect except set values select offset window returning lateral as fetch for into default partition').split(' '));
const REF_START = new Set(['from', 'join', 'update', 'into', 'straight_join']);

function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN)) {
    const t = m[0];
    if (t.startsWith('--') || t.startsWith('/*') || (t[0] === '#' && t.length > 1)) continue;
    const quoted = /^[`"[]/.test(t);
    const ident = quoted || /^[A-Za-z_$ -￿]/.test(t);
    out.push({
      text: t,
      at: m.index,
      ident,
      name: quoted ? t.slice(1, -1).replace(/``|""/g, (q) => q[0]) : t,
      kw: !quoted && ident ? t.toLowerCase() : null,
    });
  }
  return out;
}

// [{ schema, table, alias }] referenced by a statement. Subqueries are skipped, not scoped.
export function tableRefs(text) {
  const toks = tokenize(text);
  const refs = [];
  for (let i = 0; i < toks.length; i++) {
    if (!REF_START.has(toks[i].kw)) continue;
    const list = toks[i].kw === 'from';
    let j = i + 1;
    for (;;) {
      const t = toks[j];
      if (!t?.ident || (t.kw && NOT_ALIAS.has(t.kw))) break;
      let schema = null, table = t.name;
      j++;
      if (toks[j]?.text === '.' && toks[j + 1]?.ident) {
        schema = table;
        table = toks[j + 1].name;
        j += 2;
      }
      if (toks[j]?.kw === 'as') j++;
      let alias = null;
      if (toks[j]?.ident && !(toks[j].kw && NOT_ALIAS.has(toks[j].kw))) alias = toks[j++].name;
      refs.push({ schema, table, alias });
      if (!list || toks[j]?.text !== ',') break;
      j++;
    }
  }
  return refs;
}

const BARE = /^[a-z_][a-z0-9_$]*$/;
const ident = (n, dialect, quote) => (BARE.test(n) || (dialect === 'mysql' && /^\w+$/.test(n)) ? n : quote(n));

// No FROM yet (`SELECT na|`): every column of the schema, below tables and keywords, with its tables as info.
function allColumns(schema, from, dialect, quote) {
  const byName = new Map();
  for (const [t, cols] of Object.entries(schema)) {
    for (const c of cols) {
      const o = byName.get(c.name);
      if (o) o.tables.push(t);
      else byName.set(c.name, { c, tables: [t] });
    }
  }
  const options = [...byName.values()].map(({ c, tables }) => ({
    label: ident(c.name, dialect, quote),
    type: 'property',
    detail: c.type,
    info: tables.length > 3 ? `${tables.slice(0, 3).join(', ')} +${tables.length - 3}` : tables.join(', '),
    boost: -1,
  }));
  return { from, options, validFor: /^[\w$\u00a0-\uffff]*$/ };
}

// schema: { table: [{ name, type, pk }] } for the console's schema; quote: identifier quoting
export function columnSource({ schema, defaultSchema, dialect, quote }) {
  const tables = new Map(Object.keys(schema || {}).map((t) => [t.toLowerCase(), t]));
  return (ctx) => {
    if (!tables.size) return null;
    const word = ctx.matchBefore(/[\w$ -￿]*/);
    if (!word.text && !ctx.explicit) return null;
    if (ctx.state.sliceDoc(word.from - 1, word.from) === '.') return null;
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (/String|Comment|QuotedIdentifier/.test(node.name)) return null;

    const doc = ctx.state.doc.toString();
    const st = statementAt(doc, word.from, dialect);
    if (!st) return null;
    const before = tokenize(doc.slice(st.start, word.from));
    const prev = before[before.length - 1];
    // a table name goes here, not a column
    if (prev && (REF_START.has(prev.kw) || prev.kw === 'table' || prev.kw === 'as')) return null;

    const refs = tableRefs(st.text).filter((r) => (!r.schema || r.schema === defaultSchema) && tables.has(r.table.toLowerCase()));
    if (!refs.length) return word.text.length > 1 ? allColumns(schema, word.from, dialect, quote) : null;
    const count = new Map();
    for (const r of refs) for (const c of schema[tables.get(r.table.toLowerCase())]) count.set(c.name, (count.get(c.name) || 0) + 1);

    const id = (n) => ident(n, dialect, quote);
    const options = [];
    const seen = new Set();
    for (const r of refs) {
      const tname = tables.get(r.table.toLowerCase());
      const owner = r.alias || r.table;
      for (const c of schema[tname]) {
        // same name in two tables of the statement: offer it qualified, like DataGrip does
        const label = count.get(c.name) > 1 ? `${id(owner)}.${id(c.name)}` : id(c.name);
        if (seen.has(label)) continue;
        seen.add(label);
        options.push({
          label,
          type: c.pk ? 'constant' : 'property',
          detail: c.type,
          info: refs.length > 1 || r.alias ? `${tname}${r.alias ? ' ' + r.alias : ''}` : undefined,
          boost: 2,
          section: refs.length > 1 ? { name: owner, rank: refs.indexOf(r) } : undefined,
        });
      }
    }
    return { from: word.from, options, validFor: /^[\w$. -￿]*$/ };
  };
}
