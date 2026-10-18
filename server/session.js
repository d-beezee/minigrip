// One live session (DB connection + optional SSH tunnel) per saved connection.
// Work on a session is serialized, so `USE`, transactions and temp tables behave like a console.
import { createDriver, defaultPort } from './drivers.js';
import { openTunnel } from './tunnel.js';

export async function openSession(cfg) {
  let tunnel = null;
  let dead = false;
  let host = cfg.host || '127.0.0.1';
  let port = Number(cfg.port) || defaultPort(cfg.type);
  if (cfg.ssh?.enabled && cfg.type !== 'sqlite') {
    tunnel = await openTunnel(cfg.ssh, host, port, () => (dead = true));
    host = '127.0.0.1';
    port = tunnel.port;
  }
  let driver;
  try {
    driver = await createDriver(cfg, host, port);
  } catch (e) {
    tunnel?.close();
    throw e;
  }

  let chain = Promise.resolve();
  let schema = await driver.currentSchema().catch(() => null);

  const session = {
    driver,
    get alive() { return !dead && driver.alive; },
    get schema() { return schema; },
    // Run fn(driver) exclusively on this session.
    exec(fn) {
      const p = chain.then(() => fn(driver));
      chain = p.catch(() => {});
      return p;
    },
    async ensureSchema(s) {
      if (s && s !== schema) {
        await driver.useSchema(s);
        schema = s;
      }
    },
    async refreshSchema() {
      schema = await driver.currentSchema().catch(() => schema);
    },
    async close() {
      await driver.close();
      tunnel?.close();
    },
  };
  return session;
}

const sessions = new Map(); // connection id -> Promise<session>

export async function getSession(id, cfg) {
  let p = sessions.get(id);
  if (p) {
    const s = await p.catch(() => null);
    if (s?.alive) return s;
    sessions.delete(id);
    s?.close().catch(() => {});
  }
  p = openSession(cfg);
  sessions.set(id, p);
  p.catch(() => sessions.delete(id));
  return p;
}

export function hasSession(id) {
  return sessions.has(id);
}

export async function closeSession(id) {
  const p = sessions.get(id);
  sessions.delete(id);
  const s = await p?.catch(() => null);
  await s?.close().catch(() => {});
}

export async function closeAll() {
  await Promise.all([...sessions.keys()].map(closeSession));
}
