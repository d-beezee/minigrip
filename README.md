# MiniGrip

A small DataGrip-style SQL client for the desktop: Electron + React (Vite + CodeMirror), with the Node backend
running inside the Electron main process on a random localhost port, protected by a per-launch token.

## Features
- **MySQL, MariaDB, PostgreSQL** (`mysql2`, `pg`)
- **SSH tunnel** per connection: password, private key (file path or pasted, with passphrase) or SSH agent
- **Saved connections** in `data/connections.json` (file mode 600). Secrets never go back to the browser.
- **Database explorer**: schemas, tables, views, routines, columns (PK, types), DDL, filtering
- **Query consoles** in tabs, persisted in the browser: `Ctrl+Enter` runs the statement at the cursor or the selection,
  `Ctrl+Shift+Enter` runs everything. Autocompletion of tables/columns, per-console schema, cancel, query history
- **Results grid**: virtualized, sort, filter, resize columns, value viewer (JSON pretty-print), copy as TSV
- **Export**: query results or tables to CSV, TSV, JSON, SQL INSERT, Markdown (re-runs the query, so all rows are included);
  dump schema or table to `.sql` (structure and/or data)
- **Import**: CSV/TSV/JSON into an existing or new table (single transaction), run `.sql` scripts
  (handles quotes, comments, `$$` bodies and MySQL `DELIMITER`)

## Run
```bash
npm install
npm run app        # build the UI and open the desktop app
npm run app:dev    # Vite with hot reload + Electron
npm run dist:linux # AppImage + .deb in release/   (dist:win, dist:mac on those systems)
```
Saved connections live in the app's userData folder (File > Open Data Folder).
The old browser mode still works: `npm run web` serves http://127.0.0.1:4870.

## Notes
- Passwords are stored in plain text in `connections.json` (file mode 600). In browser mode the API has no auth: keep `HOST=127.0.0.1`.
- One live DB session per saved connection, shared by its consoles (`USE`, transactions and temp tables persist).
- Results show the first 2000 rows; exports have no limit but are built in memory.
- PostgreSQL lists the schemas of the configured database only (one database per connection).

## Releases
Publishing a GitHub release runs `.github/workflows/release.yml`: it builds the `.deb`, `.AppImage` and Windows
`.exe` installer for the release tag (version taken from the tag, e.g. `v1.2.0`) and attaches them to the release.
