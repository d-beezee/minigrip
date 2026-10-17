// SSH local port forward: 127.0.0.1:<random> -> (via ssh host) -> dstHost:dstPort
import ssh2 from 'ssh2';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

const { Client, utils } = ssh2; // CommonJS package: named exports aren't detected for all members

const expandHome = (p) => (p?.startsWith('~') ? os.homedir() + p.slice(1) : p);

const DEFAULT_KEYS = ['id_rsa', 'id_ecdsa', 'id_ed25519'].map((k) => `~/.ssh/${k}`);

// Resolve the effective OpenSSH settings for a host (~/.ssh/config, Include, Match, defaults) via `ssh -G`.
// Falls back to the default identity files when the ssh binary isn't available.
function resolveOpenSsh(host, user, port) {
  return new Promise((resolve) => {
    const args = ['-G'];
    if (user) args.push('-l', user);
    if (port) args.push('-p', String(port));
    args.push(host);
    execFile('ssh', args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ hostname: host, user, port, identityFiles: DEFAULT_KEYS, identitiesOnly: false });
      const cfg = { identityFiles: [] };
      for (const line of stdout.split('\n')) {
        const i = line.indexOf(' ');
        if (i < 0) continue;
        const k = line.slice(0, i).toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === 'identityfile') cfg.identityFiles.push(v);
        else if (['hostname', 'user', 'port', 'identityagent', 'identitiesonly'].includes(k)) cfg[k] = v;
      }
      resolve({
        hostname: cfg.hostname || host,
        user: user || cfg.user,
        port: Number(port) || Number(cfg.port) || 22,
        identityFiles: cfg.identityFiles.length ? cfg.identityFiles : DEFAULT_KEYS,
        identityAgent: cfg.identityagent,
        identitiesOnly: cfg.identitiesonly === 'yes',
      });
    });
  });
}

function agentSocket(identityAgent) {
  if (identityAgent && identityAgent.toLowerCase() === 'none') return null;
  if (identityAgent && identityAgent !== 'SSH_AUTH_SOCK') {
    return expandHome(identityAgent.replace(/^\$\{?SSH_AUTH_SOCK\}?$/, process.env.SSH_AUTH_SOCK || ''));
  }
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  return process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : null;
}

// Readable, parseable private keys (encrypted ones only when a passphrase is given).
function loadKeys(files, passphrase) {
  const keys = [];
  for (const f of files) {
    const p = expandHome(f.replace(/%d/g, os.homedir()));
    let data;
    try { data = fs.readFileSync(p); } catch { continue; }
    const parsed = utils.parseKey(data, passphrase || undefined);
    if (parsed instanceof Error) continue;
    keys.push({ path: p, key: data });
  }
  return keys;
}

// Build the connection options and the list of auth methods for each mode.
async function connectOptions(ssh) {
  const base = { readyTimeout: 15000, keepaliveInterval: 10000 };

  if (ssh.auth === 'key') {
    const key = ssh.privateKey?.trim() ? ssh.privateKey : fs.readFileSync(expandHome(ssh.keyPath || '~/.ssh/id_rsa'));
    return { ...base, host: ssh.host, port: Number(ssh.port) || 22, username: ssh.user, privateKey: key, passphrase: ssh.passphrase || undefined };
  }
  if (ssh.auth === 'password') {
    return { ...base, host: ssh.host, port: Number(ssh.port) || 22, username: ssh.user, password: ssh.password };
  }

  // 'agent': OpenSSH config + agent, like `ssh` and DataGrip — agent first, then the configured / default key files.
  const cfg = await resolveOpenSsh(ssh.host, ssh.user, ssh.port);
  if (!cfg.user) throw new Error('no user given and none found in ~/.ssh/config');
  const agent = agentSocket(cfg.identityAgent);
  const keys = loadKeys(cfg.identityFiles, ssh.passphrase);
  const methods = [];
  if (agent) methods.push({ type: 'agent', username: cfg.user, agent });
  for (const k of keys) methods.push({ type: 'publickey', username: cfg.user, key: k.key });
  if (!methods.length) {
    throw new Error(`no SSH agent and no usable key in ${cfg.identityFiles.join(', ')}`);
  }
  return {
    ...base,
    host: cfg.hostname,
    port: cfg.port,
    username: cfg.user,
    authHandler: (methodsLeft, partial, next) => {
      const m = methods.shift();
      if (!m) return next(false);
      next(m);
    },
    tried: [agent ? 'agent' : null, ...keys.map((k) => k.path)].filter(Boolean),
  };
}

export async function openTunnel(ssh, dstHost, dstPort, onClose) {
  let opts;
  try {
    opts = await connectOptions(ssh);
  } catch (e) {
    throw new Error('SSH: ' + e.message);
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let ready = false;

    conn.on('ready', () => {
      ready = true;
      const server = net.createServer((sock) => {
        conn.forwardOut('127.0.0.1', sock.remotePort || 0, dstHost, Number(dstPort), (err, stream) => {
          if (err) return sock.destroy();
          sock.pipe(stream).pipe(sock);
          stream.on('error', () => sock.destroy());
          sock.on('error', () => stream.end());
        });
      });
      server.on('error', (e) => reject(new Error('SSH tunnel: ' + e.message)));
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: server.address().port,
          close() {
            server.close();
            conn.end();
          },
        });
      });
      conn.on('close', () => {
        server.close();
        onClose?.();
      });
    });
    conn.on('error', (e) => {
      if (ready) return;
      const tried = opts.tried?.length && /authentication methods failed/i.test(e.message) ? ` (tried: ${opts.tried.join(', ')})` : '';
      reject(new Error('SSH: ' + e.message + tried));
    });
    conn.connect(opts);
  });
}
