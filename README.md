# Index Studio 1.0.0

Local index editor designed for SANS classes with multiple profiles, search, notes, pasted images, print previews, CSV/JSON import and export, SQLite backups, and an API

## Windows, macOS and Linux

Install Node.js 24 or newer from [nodejs.org](https://nodejs.org/en/download). A browser is also required.

From this source folder, run `npm run setup` once, then `npm run launch`. Setup installs the locked dependencies and builds the app. Stop with `npm run stop` and check it with `npm run status`. Platform shortcuts are documented in [the launcher guide](launchers/README.md). Index Studio runs by default at port `4010`. The sibling `ready-to-run/index-studio-1.0.0/` folder contains the built app if you prefer to skip source setup.

## Your files

Storage is separate from the application:

| Platform | Default data folder |
|---|---|
| macOS | `~/Library/Application Support/Index Studio` |
| Ubuntu/Linux | `${XDG_DATA_HOME:-~/.local/share}/index-studio` |
| Windows | `%LOCALAPPDATA%\Index Studio` |

Profiles, databases, backups, the server log, and a private launcher control token live here. Replacing the application folder does not erase them. Set `INDEX_APP_DATA_DIR` to choose another folder, and `INDEX_APP_PORT` to change the port (1024–65535). Use the same settings for start, stop and CLI commands. Set `INDEX_APP_NO_OPEN=1` for a headless launch. Don't run the app with sudo.

The workspace's old `data/`, `seed/`, `exports/` and `private/` files are excluded from releases and are never automatically read by a new installation. To use an existing installation's storage explicitly, run `node server/index.mjs --data-dir /path/to/old/data`. Back it up first. Existing profile-aware storage is preserved; older single-database storage is copied into the initial profile with the original left intact.

In the app, rename **My Index** or create a profile, configure your books, then add entries or import your own files. Imports offer a dry run and create a safety backup before committing. Automatic database backups default to daily with 14 automatic backups retained while the server is running. In Data & backups, configure the interval and retention; the API accepts intervals of 1–10080 minutes (0 disables them) and retention of 1–100. Clearing remembered book/page preferences also resets automatic backup settings in 1.0.0. Manual and import backups are retained until you remove them.

## Entries, notes and keywords

Use **Add entry** to enter a concept, one or more keywords, book and page references, details and tags. Entries support draft, review and final status. The editor supports pasted images with 5, 7 and 10 line height presets and custom integer heights from 1 to 50 lines; oversized images may need reducing to fit. Use **Entries** to search and edit saved entries. Soft-delete hides an entry; there is no individual restore action in this version, so take a backup before deleting material you may need.

Notes are separate plain-text records that can be saved and archived. The API can list archived notes, but provides no note edit or restore action. In **Settings**, add or archive books, add keyword aliases, merge keywords, or archive and restore selected keywords. Archiving a keyword saves its original aliases and entry links in `index-archived.json` inside that profile's data folder. Entries without another keyword receive `placeholder`; that keyword cannot be archived.

## Print and export

Open **Print preview** to choose the index or workbook scope and a layout, review pages, print through the browser, or download standalone HTML. The main index hides labs by default; change the scope to include them. CSV is a six-column compatibility export and contains plain text, so it does not preserve images or multiple keyword links. JSON preserves active entries, images, books and active keyword aliases.

## Imports and recovery

Use **Data & backups** to select CSV or an Index Studio JSON export and run a dry check before committing. CSV skips repeated rows and reports invalid rows; committing imports the valid rows. JSON rejects an import with invalid entries. Matching JSON entry IDs are skipped by default. Enable **Update entries already in this backup** only when you intend to replace matching entries with the backup values. Committed imports make a SQLite safety backup first.

JSON exports omit notes, deleted entries and archived keywords. Import restores entries, books and aliases, but does not apply exported preferences or status counts. SQLite backup points include notes and deleted rows in that profile database, but omit the separate `index-archived.json` and `profiles.json` registry. For a complete backup, stop the app and copy the entire data folder, including all profiles and archive files, to another location. Restoring a SQLite backup replaces the profile database and creates a pre-restore safety backup first.

## Local API and command line

The API is available at `http://127.0.0.1:4010/api/v1` without a login or API key. For example:

```bash
curl http://127.0.0.1:4010/api/v1/status
curl -H 'Content-Type: application/json' \
  -d '{"keyword":"example","concept":"My entry","bookNumber":"1","pageNumber":"1"}' \
  http://127.0.0.1:4010/api/v1/entries
```

Write requests must send a JSON object with `Content-Type: application/json`, including `{}` for empty actions. See [API.md](docs/API.md). Browser requests must come from the exact app origin. Ordinary local scripts do not need an Origin header. Only internal launcher control routes require a private token; normal data routes never do.

```bash
node server/index.mjs import entries.csv
node server/index.mjs import entries.csv --commit
node server/index.mjs import backup.json --commit
node server/index.mjs add --json entry.json
node server/index.mjs export --format json --out index-backup.json
node server/index.mjs backup
```

Imports are dry runs unless `--commit` is supplied. Add `--profile MY-INDEX` to target a profile. Exports without `--out` go into the private data folder.

## Security defaults

The server binds only to IPv4 loopback (`127.0.0.1`); there is no option to expose it on all interfaces. It rejects unexpected Host and Origin headers and cross-origin browser requests, including reads and downloads. JSON-only writes prevent form submissions. Responses apply a content security policy, frame protection, no-store caching, and same-origin resource restrictions. New Unix storage folders use mode 700 and files use 600.

Router port forwarding to a LAN address cannot reach a loopback-only listener. Deliberately configured proxies, tunnels or forwarding software can expose local services, so don't put this app behind them. Other programs running on your computer can use the API by design. Files and backups are not encrypted.

## Troubleshooting

- If a launcher reports missing or old Node.js, install Node.js 24 or newer, reopen the terminal and check `node --version`.
- If the browser does not open, visit the printed `http://127.0.0.1:4010` URL yourself. Use the configured port if you changed it.
- If the port is busy, stop the other copy or choose `INDEX_APP_PORT` and use the same value for start, stop and CLI commands.
- On Linux or macOS, run source launchers with `bash` if the extracted file is not executable. For example, use `bash launchers/linux/start.sh` or `bash launchers/macos/Start.command` from this source folder.
- Keep the source folders together. After replacing the source, run `npm run setup` again. Use the same data-directory setting to retain your profiles.

## Working from source?

```bash
npm run setup
npm run launch
```

Run these commands from this source folder. Setup installs the pinned dependencies and builds the app. It needs internet access once. After setup, the app runs offline. Check it with `npm run status` and stop it with `npm run stop`. These commands work on Windows, macOS and Linux. For clickable source setup and startup files, see [the platform launchers](launchers/README.md).

## Project layout

| Folder | Contents |
|---|---|
| `src/` | Browser UI and print layouts |
| `server/` | Local HTTP server, SQLite storage and security |
| `scripts/` | Setup, launch and release tools |
| `launchers/` | macOS, Linux and Windows launchers |
| `docs/` | User, API, security and development guides |
| `config/` | Exact source-file release allowlist |
| `tests/` | Automated checks and fictional fixtures |
| `releases/` | Generated by `npm run release`; not included in the clean source snapshot |

Local `data/`, `seed/`, `exports/`, `private/` and `docs/archive/` are excluded from both downloads. They retain existing personal files and historical notes. The app does not load these automatically. `dist/` and `node_modules/` are generated locally.

See [the development guide](docs/DEVELOPMENT.md) for build, test and release commands.

## GitHub releases

This source folder is the Git repository. Built downloads belong in GitHub Releases. The prepared `v1.0.0` tag triggers a workflow that publishes the ready-to-run archive and checksum after the platform checks pass. See [publishing instructions](docs/DEVELOPMENT.md#publish-v100-to-github).
