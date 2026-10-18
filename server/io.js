// Import / export helpers.
import { stringify } from 'csv-stringify/sync';
import { parse } from 'csv-parse/sync';
import { splitSql } from '../shared/split.js';

// Value as shown in the grid / CSV.
export function displayValue(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return '0x' + v.toString('hex');
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/* ------------------------------------------------------------------ export */

export function formatResult(driver, result, format, { table = 'exported', header = true } = {}) {
  const names = result.columns.map((c) => c.name);
  switch (format) {
    case 'csv':
    case 'tsv':
      return stringify(result.rows.map((r) => r.map((v) => displayValue(v) ?? '')), {
        header,
        columns: names,
        delimiter: format === 'tsv' ? '\t' : ',',
        bom: format === 'csv',
      });
    case 'json':
      return JSON.stringify(
        result.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, jsonValue(r[i])]))),
        null,
        2,
      );
    case 'sql':
      return insertStatements(driver, table, names, result.rows);
    case 'markdown': {
      const esc = (v) => String(displayValue(v) ?? 'NULL').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      return [
        '| ' + names.join(' | ') + ' |',
        '| ' + names.map(() => '---').join(' | ') + ' |',
        ...result.rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |'),
      ].join('\n') + '\n';
    }
    default:
      throw new Error('Unknown format: ' + format);
  }
}

function jsonValue(v) {
  if (Buffer.isBuffer(v)) return '0x' + v.toString('hex');
  return v ?? null;
}

export function insertStatements(driver, table, names, rows, batch = 100) {
  // already-quoted names pass through; "schema.table" is quoted part by part
  const target = /[`"]/.test(table) ? table : table.split('.').map(driver.q).join('.');
  const head = `INSERT INTO ${target} (${names.map(driver.q).join(', ')}) VALUES\n`;
  let out = '';
  for (let i = 0; i < rows.length; i += batch) {
    out += head + rows.slice(i, i + batch).map((r) => '  (' + r.map(driver.lit).join(', ') + ')').join(',\n') + ';\n';
  }
  return out;
}

export const MIME = {
  csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  sql: 'application/sql', markdown: 'text/markdown',
};
export const EXT = { csv: 'csv', tsv: 'tsv', json: 'json', sql: 'sql', markdown: 'md' };

// Dump DDL and/or data of a schema's tables (or a subset) as a SQL script.
export async function dumpSchema(driver, schema, { tables, ddl = true, data = true, views = true }) {
  const objs = await driver.objects(schema);
  const pick = (o) => !tables?.length || tables.includes(o.name);
  const tbls = objs.filter((o) => o.type === 'table' && pick(o));
  const vws = views ? objs.filter((o) => (o.type === 'view' || o.type === 'matview') && pick(o)) : [];
  let out = `-- MiniGrip dump of ${schema} (${driver.dialect} ${driver.version})\n-- ${new Date().toISOString()}\n\n`;
  if (driver.dialect === 'mysql') out += 'SET FOREIGN_KEY_CHECKS = 0;\n\n';
  for (const t of tbls) {
    out += `-- Table ${t.name}\n`;
    if (ddl) out += (await driver.ddl(schema, t.name, 'table')) + '\n\n';
    if (data) {
      const [res] = await driver.query(`SELECT * FROM ${driver.q(schema)}.${driver.q(t.name)}`);
      if (res.rows.length) {
        // MySQL's SHOW CREATE TABLE and SQLite's DDL are unqualified, so keep INSERTs unqualified too (restore into any database)
        const target = driver.dialect !== 'postgres' ? driver.q(t.name) : driver.q(schema) + '.' + driver.q(t.name);
        out += insertStatements(driver, target, res.columns.map((c) => c.name), res.rows) + '\n';
      }
    }
  }
  if (ddl) for (const v of vws) out += `-- View ${v.name}\n${await driver.ddl(schema, v.name, v.type)}\n\n`;
  if (driver.dialect === 'mysql') out += 'SET FOREIGN_KEY_CHECKS = 1;\n';
  return out;
}

/* ------------------------------------------------------------------ import */

// Parse CSV/TSV/JSON text into { names, rows }.
export function parseData(text, { format, delimiter, header = true }) {
  if (format === 'json') {
    let data = JSON.parse(text);
    if (!Array.isArray(data)) data = [data];
    const names = [...new Set(data.flatMap((o) => Object.keys(o)))];
    const rows = data.map((o) => names.map((n) => {
      const v = o[n];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v ?? null;
    }));
    return { names, rows };
  }
  const recs = parse(text, {
    delimiter: delimiter || (format === 'tsv' ? '\t' : ','),
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  if (!recs.length) return { names: [], rows: [] };
  const names = header ? recs.shift().map((s) => s.trim()) : null;
  return { names, rows: recs };
}

export async function importData(driver, schema, table, text, opts) {
  const { names, rows } = parseData(text, opts);
  if (!rows.length) return { inserted: 0 };

  let existing = null;
  try {
    existing = await driver.columns(schema, table);
    if (!existing.length) existing = null;
  } catch {
    existing = null;
  }

  let cols;
  if (!existing) {
    if (!opts.createTable) throw new Error(`Table ${schema}.${table} does not exist (enable "create table")`);
    cols = names || rows[0].map((_, i) => 'col' + (i + 1));
    await driver.query(
      `CREATE TABLE ${driver.q(schema)}.${driver.q(table)} (${cols.map((c) => driver.q(c) + ' ' + driver.textType).join(', ')})`);
  } else if (names) {
    const byLower = new Map(existing.map((c) => [c.name.toLowerCase(), c.name]));
    const unknown = names.filter((n) => !byLower.has(n.toLowerCase()));
    if (unknown.length) throw new Error('Columns not in table: ' + unknown.join(', '));
    cols = names.map((n) => byLower.get(n.toLowerCase()));
  } else {
    cols = existing.slice(0, rows[0].length).map((c) => c.name);
  }

  const width = cols.length;
  const clean = rows.map((r) => {
    const out = r.slice(0, width);
    while (out.length < width) out.push(null);
    return opts.emptyAsNull === false ? out : out.map((v) => (v === '' ? null : v));
  });

  const batch = Math.max(1, Math.min(1000, Math.floor(30000 / width)));
  await driver.query(driver.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN');
  try {
    if (opts.truncate && existing) await driver.query(`DELETE FROM ${driver.q(schema)}.${driver.q(table)}`);
    for (let i = 0; i < clean.length; i += batch) {
      try {
        await driver.insertBatch(schema, table, cols, clean.slice(i, i + batch));
      } catch (e) {
        e.message = `Rows ${i + 1}-${Math.min(i + batch, clean.length)}: ${e.message}`;
        throw e;
      }
    }
    await driver.query('COMMIT');
  } catch (e) {
    await driver.query('ROLLBACK').catch(() => {});
    throw e;
  }
  return { inserted: clean.length, created: !existing, columns: cols };
}

export async function runScript(driver, text, { stopOnError = true } = {}) {
  const stmts = splitSql(text, driver.dialect);
  const errors = [];
  let executed = 0;
  for (const [i, s] of stmts.entries()) {
    try {
      await driver.query(s.text);
      executed++;
    } catch (e) {
      errors.push({ index: i + 1, message: e.message, sql: s.text.slice(0, 200) });
      if (stopOnError) break;
    }
  }
  return { total: stmts.length, executed, errors };
}
