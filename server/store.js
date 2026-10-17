// Saved connections, persisted as JSON on disk.
// Secrets (passwords, private keys, passphrases) never leave the server:
// the API returns `hasX` flags instead, and an absent field on update keeps the stored value.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Read lazily: Electron sets MINIGRIP_DATA to its userData folder before first use.
const dataDir = () => process.env.MINIGRIP_DATA || path.join(process.cwd(), 'data');
const file = () => path.join(dataDir(), 'connections.json');

const SECRETS = [['password'], ['ssh', 'password'], ['ssh', 'privateKey'], ['ssh', 'passphrase']];

function load() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(list, null, 2), { mode: 0o600 });
}

const get = (obj, p) => p.reduce((o, k) => (o == null ? undefined : o[k]), obj);
const set = (obj, p, v) => {
  let o = obj;
  for (const k of p.slice(0, -1)) o = o[k] ??= {};
  o[p.at(-1)] = v;
};

export function publicView(c) {
  const copy = structuredClone(c);
  copy.ssh ??= {};
  for (const p of SECRETS) {
    const key = p.at(-1);
    const flag = 'has' + key[0].toUpperCase() + key.slice(1);
    set(copy, [...p.slice(0, -1), flag], !!get(c, p));
    set(copy, p, undefined);
  }
  return JSON.parse(JSON.stringify(copy)); // drops undefined fields
}

// Fill secrets missing from `incoming` with those of `existing`.
export function mergeSecrets(incoming, existing) {
  const out = structuredClone(incoming);
  if (!existing) return out;
  for (const p of SECRETS) {
    if (get(out, p) === undefined && get(existing, p) !== undefined) set(out, p, get(existing, p));
  }
  return out;
}

export const store = {
  list: () => load(),
  get: (id) => load().find((c) => c.id === id),
  create(data) {
    const list = load();
    const c = { ...data, id: crypto.randomUUID() };
    list.push(c);
    save(list);
    return c;
  },
  update(id, data) {
    const list = load();
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return null;
    list[i] = { ...mergeSecrets(data, list[i]), id };
    save(list);
    return list[i];
  },
  remove(id) {
    save(load().filter((c) => c.id !== id));
  },
};
