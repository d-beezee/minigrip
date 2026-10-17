// SSH local port forward: 127.0.0.1:<random> -> (via ssh host) -> dstHost:dstPort
import { Client } from 'ssh2';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';

const expandHome = (p) => (p?.startsWith('~') ? os.homedir() + p.slice(1) : p);

export function openTunnel(ssh, dstHost, dstPort, onClose) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let ready = false;

    const opts = {
      host: ssh.host,
      port: Number(ssh.port) || 22,
      username: ssh.user,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
    };
    try {
      if (ssh.auth === 'key') {
        opts.privateKey = ssh.privateKey?.trim() ? ssh.privateKey : fs.readFileSync(expandHome(ssh.keyPath || '~/.ssh/id_rsa'));
        if (ssh.passphrase) opts.passphrase = ssh.passphrase;
      } else if (ssh.auth === 'agent') {
        opts.agent = process.env.SSH_AUTH_SOCK;
        if (!opts.agent) throw new Error('SSH agent not available (SSH_AUTH_SOCK not set)');
      } else {
        opts.password = ssh.password;
      }
    } catch (e) {
      return reject(new Error('SSH: ' + e.message));
    }

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
      if (!ready) reject(new Error('SSH: ' + e.message));
    });
    conn.connect(opts);
  });
}
