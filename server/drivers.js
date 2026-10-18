// Database drivers with a common interface:
//   query(sql, params) -> [{ columns:[{name,type}], rows:[[...]] } | { affected, insertId, command }]
//   cancel(), close(), useSchema(name)
//   schemas(), objects(schema), columns(schema, table), ddl(schema, name, type), completion(schema)
//   q(ident) quotes an identifier, lit(value) renders a SQL literal
//   origins(columns) -> [{ schema, table, column } | null]: where each result column comes from
//   ph(n) is the n-th (1-based) bind placeholder
import os from 'node:os';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { prepareValue } from 'pg/lib/utils.js';

// Keep temporal types as the server's text instead of JS Dates (no timezone surprises).
for (const oid of [1082, 1083, 1114, 1184, 1186, 1266]) pg.types.setTypeParser(oid, (v) => v);

const PG_TYPES = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text',
  114: 'json', 142: 'xml', 700: 'float4', 701: 'float8', 1042: 'bpchar', 1043: 'varchar', 1082: 'date',
  1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1266: 'timetz', 1700: 'numeric',
  2950: 'uuid', 3802: 'jsonb', 1007: 'int4[]', 1009: 'text[]', 1016: 'int8[]', 1015: 'varchar[]',
};

const MYSQL_ALIASES = {
  long: 'int', longlong: 'bigint', short: 'smallint', tiny: 'tinyint', int24: 'mediumint',
  var_string: 'varchar', string: 'char', newdecimal: 'decimal', tiny_blob: 'tinyblob',
  medium_blob: 'mediumblob', long_blob: 'longblob', newdate: 'date',
};

function mysqlTypeName(f) {
  const t = (Object.entries(mysql.Types).find(([, v]) => v === f.columnType)?.[0] || String(f.columnType)).toLowerCase();
  return MYSQL_ALIASES[t] || t;
}

// [table, column, type, pk] rows -> { table: [{ name, type, pk }] } for the editor's autocompletion
function completionMap(rows) {
  const out = {};
  for (const [t, name, type, pk] of rows) (out[t] ??= []).push({ name, type, pk: !!pk });
  return out;
}

const sslOpt = (cfg) => (cfg.ssl ? { rejectUnauthorized: !!cfg.sslVerify } : undefined);

/* ------------------------------------------------------------------ MySQL / MariaDB */

async function mysqlDriver(cfg, host, port) {
  const opts = {
    host,
    port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || undefined,
    ssl: sslOpt(cfg),
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    rowsAsArray: true,
    connectTimeout: 15000,
    charset: 'utf8mb4',
  };
  const conn = await mysql.createConnection(opts);
  const [[[version]]] = await conn.query('SELECT VERSION()');
  let alive = true;
  conn.on('error', () => (alive = false));
  conn.on('end', () => (alive = false));

  const toResult = (rows, fields) =>
    Array.isArray(rows)
      ? {
          columns: fields.map((f) => ({
            name: f.name,
            type: mysqlTypeName(f),
            org: f.orgTable ? { schema: f.schema, table: f.orgTable, column: f.orgName } : undefined,
          })),
          rows,
        }
      : { affected: rows.affectedRows, insertId: rows.insertId || undefined, info: rows.info || undefined };

  const d = {
    dialect: 'mysql',
    version,
    get alive() { return alive; },
    async query(sql, params) {
      const [rows, fields] = await conn.query(sql, params);
      // CALL and friends return several result sets: fields is then an array of arrays
      if (Array.isArray(fields) && fields.length && (Array.isArray(fields[0]) || fields[0] === undefined)) {
        return rows.map((r, i) => toResult(r, fields[i]));
      }
      return [toResult(rows, fields)];
    },
    async scalarRows(sql, params) {
      const [rows] = await conn.query(sql, params);
      return rows;
    },
    async cancel() {
      const c = await mysql.createConnection({ ...opts, database: undefined });
      try { await c.query('KILL QUERY ' + conn.threadId); } finally { await c.end(); }
    },
    async close() { try { await conn.end(); } catch { conn.destroy(); } },
    async useSchema(s) { await conn.query('USE ' + d.q(s)); },
    async currentSchema() { return (await d.scalarRows('SELECT DATABASE()'))[0][0]; },
    q: (id) => '`' + String(id).replace(/`/g, '``') + '`',
    ph: () => '?',
    async origins(cols) { return cols.map((c) => c.org || null); },
    lit(v) {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number' || typeof v === 'bigint') return String(v);
      if (typeof v === 'boolean') return v ? '1' : '0';
      if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
      if (typeof v === 'object') v = JSON.stringify(v);
      return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\0/g, '\\0') + "'";
    },
    textType: 'TEXT',
    async schemas() {
      return (await d.scalarRows('SELECT schema_name FROM information_schema.schemata ORDER BY schema_name')).map((r) => r[0]);
    },
    async objects(schema) {
      const rows = await d.scalarRows(
        `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`, [schema]);
      const routines = await d.scalarRows(
        `SELECT routine_name, routine_type FROM information_schema.routines WHERE routine_schema = ? ORDER BY routine_name`, [schema]);
      return [
        ...rows.map(([name, t]) => ({ name, type: t === 'VIEW' || t === 'SYSTEM VIEW' ? 'view' : 'table' })),
        ...routines.map(([name, t]) => ({ name, type: t.toLowerCase() })),
      ];
    },
    async columns(schema, table) {
      const rows = await d.scalarRows(
        `SELECT column_name, column_type, is_nullable, column_key, column_default, extra
           FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [schema, table]);
      return rows.map(([name, type, nullable, key, def, extra]) => ({
        name, type, nullable: nullable === 'YES', pk: key === 'PRI', default: def, extra,
      }));
    },
    async ddl(schema, name, type) {
      const kind = { view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION' }[type] || 'TABLE';
      const rows = await d.scalarRows(`SHOW CREATE ${kind} ${d.q(schema)}.${d.q(name)}`);
      return rows[0][kind === 'TABLE' || kind === 'VIEW' ? 1 : 2] + ';';
    },
    async completion(schema) {
      const rows = await d.scalarRows(
        `SELECT table_name, column_name, column_type, column_key = 'PRI'
           FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position`, [schema]);
      return completionMap(rows);
    },
    async insertBatch(schema, table, cols, rows) {
      const sql = `INSERT INTO ${d.q(schema)}.${d.q(table)} (${cols.map(d.q).join(', ')}) VALUES ?`;
      await conn.query(sql, [rows]);
    },
  };
  return d;
}

/* ------------------------------------------------------------------ PostgreSQL */

async function pgDriver(cfg, host, port) {
  const opts = {
    host,
    port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || 'postgres',
    ssl: sslOpt(cfg) || false,
    connectionTimeoutMillis: 15000,
    application_name: 'MiniGrip',
  };
  const client = new pg.Client(opts);
  await client.connect();
  let alive = true;
  client.on('error', () => (alive = false));
  client.on('end', () => (alive = false));
  const version = (await client.query('SHOW server_version')).rows[0].server_version;

  const toResult = (r) =>
    r.fields?.length
      ? {
          columns: r.fields.map((f) => ({
            name: f.name,
            type: PG_TYPES[f.dataTypeID] || String(f.dataTypeID),
            org: f.tableID ? { tableID: f.tableID, columnID: f.columnID } : undefined,
          })),
          rows: r.rows,
          command: r.command,
        }
      : { affected: r.rowCount ?? 0, command: r.command };

  const d = {
    dialect: 'postgres',
    version,
    get alive() { return alive; },
    async query(sql, params) {
      const r = await client.query({ text: sql, values: params, rowMode: 'array' });
      return (Array.isArray(r) ? r : [r]).map(toResult);
    },
    async scalarRows(sql, params) {
      return (await client.query({ text: sql, values: params, rowMode: 'array' })).rows;
    },
    async cancel() {
      const c = new pg.Client(opts);
      await c.connect();
      try { await c.query('SELECT pg_cancel_backend($1)', [client.processID]); } finally { await c.end(); }
    },
    async close() { await client.end().catch(() => {}); },
    async useSchema(s) { await client.query('SET search_path TO ' + d.q(s) + ', public'); },
    async currentSchema() { return (await d.scalarRows('SELECT current_schema()'))[0][0]; },
    q: (id) => '"' + String(id).replace(/"/g, '""') + '"',
    ph: (n) => '$' + n,
    // The wire protocol only gives table oid + attnum: resolve them to names.
    async origins(cols) {
      const oids = [...new Set(cols.filter((c) => c.org).map((c) => c.org.tableID))];
      if (!oids.length) return cols.map(() => null);
      const rows = await d.scalarRows(
        `SELECT c.oid, n.nspname, c.relname, a.attnum, a.attname
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE c.oid = ANY($1::oid[]) AND a.attnum > 0`, [oids]);
      const map = new Map(rows.map(([oid, schema, table, num, column]) => [oid + ':' + num, { schema, table, column }]));
      return cols.map((c) => (c.org && map.get(c.org.tableID + ':' + c.org.columnID)) || null);
    },
    lit(v) {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number' || typeof v === 'bigint') return String(v);
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      if (Buffer.isBuffer(v)) return "'\\x" + v.toString('hex') + "'";
      if (typeof v === 'object') v = prepareValue(v); // arrays -> {..}, objects -> json
      return "'" + String(v).replace(/'/g, "''") + "'";
    },
    textType: 'text',
    async schemas() {
      return (await d.scalarRows(
        `SELECT nspname FROM pg_namespace
          WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'
          ORDER BY nspname IN ('pg_catalog', 'information_schema'), nspname <> 'public', nspname`)).map((r) => r[0]);
    },
    async objects(schema) {
      const rows = await d.scalarRows(
        `SELECT c.relname, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' ELSE 'table' END
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          ORDER BY c.relname`, [schema]);
      const routines = await d.scalarRows(
        `SELECT p.proname, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY p.proname`, [schema]);
      return [...rows, ...routines].map(([name, type]) => ({ name, type }));
    },
    async columns(schema, table) {
      const rows = await d.scalarRows(
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                COALESCE((SELECT true FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)), false),
                pg_get_expr(ad.adbin, ad.adrelid)
           FROM pg_attribute a
           LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`, [schema, table]);
      return rows.map(([name, type, nullable, pk, def]) => ({ name, type, nullable, pk, default: def }));
    },
    async ddl(schema, name, type) {
      const reg = d.q(schema) + '.' + d.q(name);
      if (type === 'view' || type === 'matview') {
        const [[def]] = await d.scalarRows('SELECT pg_get_viewdef($1::regclass, true)', [reg]);
        return `CREATE ${type === 'matview' ? 'MATERIALIZED ' : ''}VIEW ${reg} AS\n${def.trim().replace(/;$/, '')};`;
      }
      if (type === 'function' || type === 'procedure') {
        const rows = await d.scalarRows(
          `SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = $1 AND p.proname = $2`, [schema, name]);
        return rows.map((r) => r[0].trim() + ';').join('\n\n');
      }
      const cols = await d.columns(schema, name);
      const seqs = new Set();
      const lines = cols.map((c) => {
        const m = c.default?.match(/nextval\('([^']+)'/);
        if (m) seqs.add(m[1]);
        return `  ${d.q(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default != null ? ' DEFAULT ' + c.default : ''}`;
      });
      const cons = await d.scalarRows(
        `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY contype = 'p' DESC, conname`, [reg]);
      for (const [cn, def] of cons) lines.push(`  CONSTRAINT ${d.q(cn)} ${def}`);
      const idx = await d.scalarRows(
        `SELECT indexdef FROM pg_indexes i
          WHERE schemaname = $1 AND tablename = $2
            AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = i.indexname AND c.conrelid = $3::regclass)`, [schema, name, reg]);
      let out = [...seqs].map((s) => `CREATE SEQUENCE IF NOT EXISTS ${s};\n`).join('');
      out += `CREATE TABLE ${reg} (\n${lines.join(',\n')}\n);`;
      for (const [def] of idx) out += `\n${def};`;
      return out;
    },
    async completion(schema) {
      const rows = await d.scalarRows(
        `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
                EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey))
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY c.relname, a.attnum`, [schema]);
      return completionMap(rows);
    },
    async insertBatch(schema, table, cols, rows) {
      const params = [];
      const tuples = rows.map((r) => '(' + r.map((v) => (params.push(v), '$' + params.length)).join(', ') + ')');
      await client.query(`INSERT INTO ${d.q(schema)}.${d.q(table)} (${cols.map(d.q).join(', ')}) VALUES ${tuples.join(', ')}`, params);
    },
  };
  return d;
}

/* ------------------------------------------------------------------ SQLite */

// node:sqlite is synchronous and can't be interrupted, so the database lives in a child process:
// a long query doesn't block the API, and cancel() kills the process. Passed with -e so it also
// runs from inside an asar; ELECTRON_RUN_AS_NODE turns the Electron binary into plain Node.
const SQLITE_CHILD = `
const { DatabaseSync } = require('node:sqlite');
let db, openError;
try { db = new DatabaseSync(process.env.MINIGRIP_SQLITE_FILE); } catch (e) { openError = e; }
const conv = (v) =>
  typeof v === 'bigint' ? (v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : String(v)) : v;
// Expressions have no declared type: take the storage class of the first non-null value.
const valueType = (rows, i) => {
  const v = rows.find((r) => r[i] !== null)?.[i];
  return v === undefined ? '' : typeof v === 'bigint' ? 'integer' : typeof v === 'number' ? 'real' : typeof v === 'string' ? 'text' : 'blob';
};
const DML = /^(INSERT|UPDATE|DELETE|REPLACE|WITH)$/;
function run(sql, params = []) {
  if (openError) throw openError;
  const st = db.prepare(sql);
  const cols = st.columns();
  if (cols.length) {
    st.setReturnArrays(true);
    st.setReadBigInts(true);
    const rows = st.all(...params);
    return {
      columns: cols.map((c, i) => ({
        name: c.name,
        type: c.type ? c.type.toLowerCase() : valueType(rows, i),
        org: c.table ? { schema: c.database, table: c.table, column: c.column } : undefined,
      })),
      rows: rows.map((r) => r.map(conv)),
    };
  }
  const r = st.run(...params);
  const command = (sql.match(/^\\s*(\\w+)/) || [])[1]?.toUpperCase();
  return {
    affected: DML.test(command) ? Number(r.changes) : 0, // changes() keeps the last DML count across DDL
    insertId: /^(INSERT|REPLACE)$/.test(command) ? conv(r.lastInsertRowid) : undefined,
    command,
  };
}
process.on('message', ({ id, sql, params }) => {
  try {
    process.send({ id, result: run(sql, params) });
  } catch (e) {
    process.send({ id, error: { message: e.message, code: e.errstr || e.code } });
  }
});
process.on('disconnect', () => process.exit());
`;

async function sqliteDriver(cfg) {
  const file = String(cfg.file || '').trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (!file) throw new Error('Choose a database file');
  const child = spawn(process.execPath, ['-e', SQLITE_CHILD], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MINIGRIP_SQLITE_FILE: file },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    serialization: 'advanced', // keeps Uint8Array and BigInt
    windowsHide: true,
  });
  const pending = new Map();
  let seq = 0;
  let alive = true;
  let fatal = null;
  const fail = (e) => {
    alive = false;
    fatal ??= e;
    for (const p of pending.values()) p.reject(fatal);
    pending.clear();
  };
  child.on('message', ({ id, result, error }) => {
    const p = pending.get(id);
    pending.delete(id);
    if (error) p?.reject(Object.assign(new Error(error.message), { code: error.code }));
    else p?.resolve(result);
  });
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Connection closed')));
  const call = (sql, params) => {
    if (!alive) return Promise.reject(fatal);
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      child.send({ id, sql, params });
    });
  };
  const fromChild = (r) => (r.rows ? { ...r, rows: r.rows.map((row) => row.map((v) => (v instanceof Uint8Array ? Buffer.from(v) : v))) } : r);
  let version;
  try {
    version = (await call('SELECT sqlite_version()')).rows[0][0];
  } catch (e) {
    child.kill('SIGKILL');
    throw e;
  }

  const d = {
    dialect: 'sqlite',
    version,
    get alive() { return alive; },
    async query(sql, params) {
      return [fromChild(await call(sql, params))];
    },
    async scalarRows(sql, params) {
      return fromChild(await call(sql, params)).rows;
    },
    // SQLite can't be interrupted from outside: drop the connection instead (reopened on next use).
    async cancel() {
      fail(new Error('Query cancelled (connection closed)'));
      child.kill('SIGKILL');
    },
    async close() { child.kill('SIGKILL'); },
    async useSchema() {}, // no USE: unqualified names resolve across all attached databases
    async currentSchema() { return 'main'; },
    q: (id) => '"' + String(id).replace(/"/g, '""') + '"',
    ph: () => '?',
    async origins(cols) { return cols.map((c) => c.org || null); },
    lit(v) {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number' || typeof v === 'bigint') return String(v);
      if (typeof v === 'boolean') return v ? '1' : '0';
      if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
      if (typeof v === 'object') v = JSON.stringify(v);
      return "'" + String(v).replace(/'/g, "''") + "'";
    },
    textType: 'TEXT',
    async schemas() {
      return (await d.scalarRows('PRAGMA database_list')).map((r) => r[1]).filter((n) => n !== 'temp');
    },
    async objects(schema) {
      const rows = await d.scalarRows(
        `SELECT name, type FROM ${d.q(schema)}.sqlite_master
          WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`);
      return rows.map(([name, type]) => ({ name, type }));
    },
    async columns(schema, table) {
      const rows = await d.scalarRows(
        'SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid', [table, schema]);
      return rows.map(([name, type, notnull, def, pk, hidden]) => ({
        name, type: type.toLowerCase(), nullable: !notnull, pk: pk > 0, default: def,
        extra: hidden === 2 || hidden === 3 ? 'generated' : undefined,
      }));
    },
    async ddl(schema, name, type) {
      // a table comes with its indexes (triggers are left out, like MySQL's SHOW CREATE TABLE)
      const rows = await d.scalarRows(
        type === 'table'
          ? `SELECT sql FROM ${d.q(schema)}.sqlite_master WHERE tbl_name = ? AND type IN ('table', 'index') AND sql IS NOT NULL
              ORDER BY type = 'table' DESC, name`
          : `SELECT sql FROM ${d.q(schema)}.sqlite_master WHERE name = ? AND sql IS NOT NULL`, [name]);
      if (!rows.length) throw new Error(`${name} not found in ${schema}`);
      return rows.map((r) => r[0].trim() + ';').join('\n');
    },
    async completion(schema) {
      const rows = await d.scalarRows(
        `SELECT m.name, p.name, lower(p.type), p.pk > 0 FROM ${d.q(schema)}.sqlite_master m JOIN pragma_table_info(m.name, ?) p
          WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY m.name, p.cid`, [schema]);
      return completionMap(rows);
    },
    async insertBatch(schema, table, cols, rows) {
      const tuple = '(' + cols.map(() => '?').join(', ') + ')';
      await call(`INSERT INTO ${d.q(schema)}.${d.q(table)} (${cols.map(d.q).join(', ')}) VALUES ${rows.map(() => tuple).join(', ')}`,
        rows.flat());
    },
  };
  return d;
}

export function createDriver(cfg, host, port) {
  if (cfg.type === 'sqlite') return sqliteDriver(cfg);
  return cfg.type === 'postgres' ? pgDriver(cfg, host, port) : mysqlDriver(cfg, host, port);
}

export const defaultPort = (type) => (type === 'postgres' ? 5432 : 3306);
