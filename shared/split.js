// SQL script splitter shared by server and client.
// Understands quotes, comments, Postgres dollar-quoting and the MySQL DELIMITER command.
// Returns [{ text, start, end }] with offsets into the original string.

export function splitSql(sql, dialect = 'mysql') {
  const isPg = dialect === 'postgres';
  const out = [];
  const n = sql.length;
  let delimiter = ';';
  let start = 0;
  let codeStart = -1; // offset of first non-comment, non-space char of the current statement
  let i = 0;

  const push = (end) => {
    if (codeStart >= 0) {
      const text = sql.slice(codeStart, end).trim();
      if (text) out.push({ text, start: codeStart, end });
    }
    codeStart = -1;
  };

  const lineStart = (k) => k === 0 || sql[k - 1] === '\n';

  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    // line comments
    if ((c === '-' && c2 === '-') || (c === '#' && !isPg)) {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? n : j + 1;
      continue;
    }
    // block comments
    if (c === '/' && c2 === '*') {
      const j = sql.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    // MySQL client-side DELIMITER command (only at the start of a statement)
    if (!isPg && codeStart < 0 && lineStart(i) && /^delimiter\s/i.test(sql.slice(i, i + 10))) {
      const j = sql.indexOf('\n', i);
      const line = sql.slice(i, j < 0 ? n : j).trim();
      const m = line.match(/^delimiter\s+(\S+)/i);
      if (m) delimiter = m[1];
      i = j < 0 ? n : j + 1;
      start = i;
      continue;
    }

    if (codeStart < 0) codeStart = i;

    // quoted strings / identifiers
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < n) {
        const ch = sql[i];
        if (ch === '\\' && !isPg && c !== '`') { i += 2; continue; }
        if (ch === c) {
          if (sql[i + 1] === c) { i += 2; continue; } // doubled quote
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Postgres dollar-quoted strings: $$...$$ or $tag$...$tag$
    if (c === '$' && isPg) {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        const tag = m[0];
        const j = sql.indexOf(tag, i + tag.length);
        i = j < 0 ? n : j + tag.length;
        continue;
      }
    }

    if (sql.startsWith(delimiter, i)) {
      push(i);
      i += delimiter.length;
      start = i;
      continue;
    }
    i++;
  }
  push(n);
  return out;
}

// The statement containing (or just before) the cursor offset.
export function statementAt(sql, offset, dialect) {
  const stmts = splitSql(sql, dialect);
  if (!stmts.length) return null;
  let best = null;
  for (const s of stmts) {
    if (s.start <= offset) best = s;
    if (offset <= s.end + 1 && offset >= s.start) return s;
  }
  return best || stmts[0];
}
