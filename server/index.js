import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { store, publicView, mergeSecrets } from './store.js';
import { openSession, getSession, closeSession, hasSession, closeAll } from './session.js';
import { splitSql } from '../shared/split.js';
import { displayValue, formatResult, dumpSchema, importData, runScript, MIME, EXT } from './io.js';
import { editInfo, applyChanges } from './edit.js';

const app = express();
let TOKEN = null;
// When a token is set (Electron), every API call must carry it: other local processes can't use the API.
app.use('/api', (req, res, next) => {
  if (TOKEN && req.get('x-minigrip-token') !== TOKEN) return res.status(401).json({ error: { message: 'Unauthorized' } });
  next();
});
app.use(express.json({ limit: '300mb' }));

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({ error: errorInfo(e) });
  }
};

function errorInfo(e) {
  return {
    message: e.message || String(e),
    code: e.code,
    detail: e.detail,
    hint: e.hint,
    position: e.position ? Number(e.position) : undefined,
  };
}

function cfgOf(id) {
  const c = store.get(id);
  if (!c) throw Object.assign(new Error('Connection not found'), { status: 404 });
  return c;
}

const session = (req) => getSession(req.params.id, cfgOf(req.params.id));

// ---------------------------------------------------------------- connections

app.get('/api/connections', wrap(() =>
  store.list().map((c) => ({ ...publicView(c), connected: hasSession(c.id) }))));

app.post('/api/connections', wrap((req) => publicView(store.create(req.body))));

app.put('/api/connections/:id', wrap(async (req) => {
  const c = store.update(req.params.id, req.body);
  if (!c) throw Object.assign(new Error('Connection not found'), { status: 404 });
  await closeSession(c.id); // settings changed: reconnect on next use
  return publicView(c);
}));

app.delete('/api/connections/:id', wrap(async (req) => {
  await closeSession(req.params.id);
  store.remove(req.params.id);
  return { ok: true };
}));

app.post('/api/test', wrap(async (req) => {
  const { id, ...cfg } = req.body;
  const full = mergeSecrets(cfg, id ? store.get(id) : null);
  const t0 = Date.now();
  const s = await openSession(full);
  const version = s.driver.version;
  await s.close();
  return { ok: true, version, ms: Date.now() - t0 };
}));

app.post('/api/connections/:id/connect', wrap(async (req) => {
  const s = await session(req);
  return { version: s.driver.version, dialect: s.driver.dialect, schema: s.schema };
}));

app.post('/api/connections/:id/disconnect', wrap(async (req) => {
  await closeSession(req.params.id);
  return { ok: true };
}));

// ---------------------------------------------------------------- queries

app.post('/api/connections/:id/query', wrap(async (req) => {
  const { sql, schema, maxRows = 1000 } = req.body;
  const s = await session(req);
  return s.exec(async (d) => {
    await s.ensureSchema(schema);
    const stmts = splitSql(sql, d.dialect);
    const results = [];
    for (const st of stmts) {
      const t0 = performance.now();
      try {
        const rs = await d.query(st.text);
        const ms = Math.round(performance.now() - t0);
        for (const r of rs) {
          if (r.columns) {
            const total = r.rows.length;
            results.push({
              sql: st.text,
              ms,
              columns: r.columns.map(({ name, type }) => ({ name, type })),
              edit: await editInfo(d, r.columns, st.text).catch((e) => ({ readOnly: e.message })),
              rows: r.rows.slice(0, maxRows).map((row) => row.map(displayValue)),
              total,
              truncated: total > maxRows,
            });
          } else {
            results.push({ sql: st.text, ms, affected: r.affected, insertId: r.insertId, info: r.info, command: r.command });
          }
        }
        if (/^\s*(use|set\s+search_path)\b/i.test(st.text)) await s.refreshSchema();
      } catch (e) {
        results.push({ sql: st.text, ms: Math.round(performance.now() - t0), error: errorInfo(e), offset: st.start });
        break;
      }
    }
    return { results, schema: s.schema };
  });
}));

// Save pending grid edits: [{ op: 'update', key, set } | { op: 'insert', values } | { op: 'delete', key }]
app.post('/api/connections/:id/edit', wrap(async (req) => {
  const { schema, table, changes } = req.body;
  if (!changes?.length) return { statements: [] };
  const s = await session(req);
  return s.exec((d) => applyChanges(d, schema, table, changes));
}));

app.post('/api/connections/:id/cancel', wrap(async (req) => {
  const s = await session(req);
  await s.driver.cancel();
  return { ok: true };
}));

// ---------------------------------------------------------------- introspection

app.get('/api/connections/:id/schemas', wrap(async (req) => {
  const s = await session(req);
  return s.exec(async (d) => ({ schemas: await d.schemas(), current: s.schema }));
}));

app.get('/api/connections/:id/objects', wrap(async (req) => {
  const s = await session(req);
  return s.exec((d) => d.objects(req.query.schema));
}));

app.get('/api/connections/:id/columns', wrap(async (req) => {
  const s = await session(req);
  return s.exec((d) => d.columns(req.query.schema, req.query.table));
}));

app.get('/api/connections/:id/ddl', wrap(async (req) => {
  const s = await session(req);
  return s.exec(async (d) => ({ ddl: await d.ddl(req.query.schema, req.query.name, req.query.type) }));
}));

app.get('/api/connections/:id/completion', wrap(async (req) => {
  const s = await session(req);
  return s.exec((d) => d.completion(req.query.schema));
}));

// ---------------------------------------------------------------- import / export

function sendFile(res, name, format, body) {
  res.setHeader('Content-Type', (MIME[format] || 'text/plain') + '; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\w.-]+/g, '_')}.${EXT[format] || 'txt'}"`);
  res.send(body);
}

// Re-run a query without row limit and download its (first) result set.
app.post('/api/connections/:id/export', wrap(async (req, res) => {
  const { sql, schema, format = 'csv', table, header = true, filename } = req.body;
  const s = await session(req);
  const body = await s.exec(async (d) => {
    await s.ensureSchema(schema);
    const stmts = splitSql(sql, d.dialect);
    if (stmts.length !== 1) throw new Error('Export needs exactly one statement');
    const r = (await d.query(stmts[0].text)).find((x) => x.columns);
    if (!r) throw new Error('Statement returned no result set');
    return formatResult(d, r, format, { table: table || 'exported', header });
  });
  sendFile(res, filename || table || 'result', format, body);
}));

app.post('/api/connections/:id/dump', wrap(async (req, res) => {
  const { schema, tables, ddl = true, data = true } = req.body;
  const s = await session(req);
  const body = await s.exec((d) => dumpSchema(d, schema, { tables, ddl, data }));
  sendFile(res, tables?.length === 1 ? `${schema}_${tables[0]}` : schema, 'sql', body);
}));

app.post('/api/connections/:id/import', wrap(async (req) => {
  const { schema, table, text, format, delimiter, header, createTable, truncate, emptyAsNull, stopOnError } = req.body;
  const s = await session(req);
  return s.exec(async (d) => {
    if (format === 'sql') {
      await s.ensureSchema(schema);
      const r = await runScript(d, text, { stopOnError });
      await s.refreshSchema();
      return r;
    }
    return importData(d, schema, table, text, { format, delimiter, header, createTable, truncate, emptyAsNull });
  });
}));

// ---------------------------------------------------------------- start

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function startServer({ port = 0, host = '127.0.0.1', distDir = path.join(ROOT, 'dist'), token = null } = {}) {
  TOKEN = token;
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      resolve({
        port: server.address().port,
        async close() {
          server.close();
          await closeAll();
        },
      });
    });
    server.on('error', reject);
  });
}

// Standalone: node server/index.js
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const srv = await startServer({ port: Number(process.env.PORT) || 4870, host: process.env.HOST || '127.0.0.1' });
  console.log(`MiniGrip on http://${process.env.HOST || '127.0.0.1'}:${srv.port}`);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await srv.close();
      process.exit(0);
    });
  }
}
