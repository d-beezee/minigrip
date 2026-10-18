// Electron passes a per-launch token through the preload bridge.
const auth = () => (window.minigrip?.token ? { 'x-minigrip-token': window.minigrip.token } : {});

async function req(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { ...auth(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || res.statusText);
    Object.assign(err, data.error);
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  connections: () => req('GET', '/connections'),
  create: (c) => req('POST', '/connections', c),
  update: (id, c) => req('PUT', `/connections/${id}`, c),
  remove: (id) => req('DELETE', `/connections/${id}`),
  test: (c) => req('POST', '/test', c),
  connect: (id) => req('POST', `/connections/${id}/connect`),
  disconnect: (id) => req('POST', `/connections/${id}/disconnect`),
  query: (id, body) => req('POST', `/connections/${id}/query`, body),
  edit: (id, body) => req('POST', `/connections/${id}/edit`, body),
  cancel: (id) => req('POST', `/connections/${id}/cancel`),
  schemas: (id) => req('GET', `/connections/${id}/schemas`),
  objects: (id, schema) => req('GET', `/connections/${id}/objects?schema=${enc(schema)}`),
  columns: (id, schema, table) => req('GET', `/connections/${id}/columns?schema=${enc(schema)}&table=${enc(table)}`),
  ddl: (id, schema, name, type) => req('GET', `/connections/${id}/ddl?schema=${enc(schema)}&name=${enc(name)}&type=${enc(type)}`),
  completion: (id, schema) => req('GET', `/connections/${id}/completion?schema=${enc(schema)}`),
  importData: (id, body) => req('POST', `/connections/${id}/import`, body),
  download: (id, kind, body) => download(`/connections/${id}/${kind}`, body),
};

// POST and save the response as a file.
async function download(url, body) {
  const res = await fetch('/api' + url, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || res.statusText);
  }
  const name = res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || 'export';
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return { name, size: blob.size };
}
