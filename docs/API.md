# Local API reference — Index Studio 1.0.0

Base URL: `http://127.0.0.1:4010/api/v1`

The server listens only on `127.0.0.1`. Normal data routes need no token or sign-in. Browser requests must use the exact app origin; unexpected Host/Origin headers and cross-site requests are rejected. All mutations require `Content-Type: application/json` and a JSON object (send `{}` for empty actions). Local scripts such as curl work without an Origin header. Entry deletions are soft deletes. Internal `/control` and `/shutdown` routes are reserved for the launcher and require its private control token.

All class data endpoints use the active profile by default. To address a specific class without changing the active profile, send `X-Index-Profile: my-index` or add `?profile=my-index`. A profile ID or class code is accepted.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/profiles` | List profiles and the currently active profile ID |
| POST | `/profiles` | Create a blank profile or clone an existing one |
| PATCH | `/profiles/{id}` | Rename, star, archive, or restore a profile |
| POST | `/profiles/{id}/activate` | Make a profile the default active class |
| GET | `/health` | Version, URL, and data path |
| GET | `/status` | Progress and data-quality counts |
| GET | `/meta` | Distinct keywords, books, statuses and preferences |
| GET | `/notes` | List notes (`?includeArchived=true` includes archived notes) |
| POST | `/notes` | Save a plain-text note |
| POST | `/notes/{id}/archive` | Archive a note |
| GET | `/settings/books` | Configured book numbers (`?includeArchived=true` includes archived books) |
| POST | `/settings/books` | Add a book number and optional label |
| PATCH | `/settings/books/{id}` | Edit, reorder, archive, or restore a book |
| GET | `/settings/preferences` | Most recently used book and page values |
| POST | `/settings/preferences/clear` | Clear remembered book and page values |
| GET, POST | `/settings/backups` | Read or set automatic backup interval and retention limit |
| GET | `/keywords` | List keywords; `?q=` searches names and aliases (up to 30 results); `?includeArchived=true` includes archived keywords when not searching |
| POST | `/keywords/{id}/archive` | Archive a keyword, aliases and entry links |
| POST | `/keywords/{name}/restore` | Restore by URL-encoded keyword name |
| POST | `/keywords` | Create a canonical keyword |
| POST | `/keywords/{id}/aliases` | Add one or more aliases to a canonical keyword |
| POST | `/keywords/merge` | Merge selected keywords; retired names become aliases |
| GET | `/entries` | List/search/filter entries |
| POST | `/entries` | Create one entry |
| GET | `/entries/recent` | Get the most recently created entries, optionally by keyword |
| POST | `/entries/batch` | Create multiple entries atomically |
| POST | `/entries/bulk` | Change status for selected entry IDs |
| GET | `/entries/{id}` | Retrieve one entry |
| PATCH | `/entries/{id}` | Update an entry |
| DELETE | `/entries/{id}` | Soft-delete an entry |
| POST | `/imports/csv` | Dry-run or commit historical CSV text |
| POST | `/imports/json` | Dry-run or commit a complete Index Studio JSON backup |
| GET | `/imports` | Recent import jobs |
| GET | `/backups` | List database backup points |
| POST | `/backups` | Create a SQLite backup |
| POST | `/backups/restore` | Restore one backup point; creates a pre-restore safety backup first |
| GET | `/exports/csv` | Download six-column compatibility CSV |
| GET | `/exports/json` | Download a complete JSON backup |

## Profiles

Create a blank class profile:

```json
{
  "code": "SEC504",
  "displayName": "SEC504",
  "printTitle": "SEC504 Master Index",
  "workbookLabel": "Workbook Labs"
}
```

`displayName` defaults to the class code. To copy the entries and settings from another profile, include `"cloneFromId": "my-index"`. Set `starred` or `archived` with `PATCH /profiles/{id}`. The active profile cannot be archived; activate another profile first. Profiles have no permanent-delete endpoint.

## Create an entry

```json
{
  "keyword": "network",
  "keywords": ["network", "tcp"],
  "primaryKeyword": "network",
  "concept": "Example concept",
  "details": "Multiline notes are supported.",
  "detailsDocument": null,
  "bookNumber": "401.1",
  "pageNumber": "20",
  "tags": ["example"]
}
```

`keyword` remains supported for legacy clients. When `keywords` is supplied, it may contain one or more values; a previously unseen value is created as a keyword. `primaryKeyword` chooses the canonical keyword used for six-column CSV output.

## Create multiple entries

Send up to 500 entries in one request to `POST /entries/batch`:

```json
{
  "entries": [
    {
      "keywords": ["network", "tcp"],
      "primaryKeyword": "network",
      "concept": "TCP three-way handshake",
      "details": "SYN, SYN-ACK, ACK",
      "bookNumber": "401.1",
      "pageNumber": "20",
      "tags": ["example"]
    },
    {
      "keyword": "windows",
      "concept": "Windows event logging",
      "details": "Review important event IDs.",
      "bookNumber": "401.2",
      "pageNumber": "45",
      "tags": []
    }
  ]
}
```

The HTTP body must be an object with an `entries` array; a raw array is rejected. The operation is atomic: if any entry is invalid, the response identifies its one-based position and no entries from the request are saved. A successful response contains `items` in request order and a `created` count.

## Get recent entries

Get the 10 most recently created entries:

```text
GET /entries/recent?limit=10
```

Get the 5 most recently created entries having the `network` keyword:

```text
GET /entries/recent?limit=5&keyword=network
```

The keyword filter is case-insensitive, recognizes keyword aliases, and matches any keyword attached to an entry (not just its primary keyword). `limit` is capped at 2,500. The response uses the normal list shape: `items`, `total`, `limit`, and `offset`.

Pasted images use the optional `detailsDocument` field. It is a versioned node list containing text nodes and inline image nodes. Image nodes accept PNG, JPEG, WebP, or GIF data URLs and an integer `lines` height from `1` through `50`; the editor provides quick presets for `5`, `7`, and `10`. The server derives the searchable `details` text from its text nodes. Complete JSON and SQLite backups preserve images; compatibility CSV exports contain the plain text only.

```json
{
  "version": 1,
  "nodes": [
    { "type": "text", "text": "Before the screenshot\n" },
    {
      "type": "image",
      "dataUrl": "data:image/png;base64,...",
      "naturalWidth": 800,
      "naturalHeight": 600,
      "lines": 5
    },
    { "type": "text", "text": "After the screenshot" }
  ]
}
```

## Move an entry to trash

```bash
curl -X DELETE -H 'Content-Type: application/json' -d '{}' \
  'http://127.0.0.1:4010/api/v1/entries/<entry-id>'
```

This hides the entry from active lists and exports but retains its database row. There is no entry restore endpoint or permanent-delete endpoint in 1.0.0. Restore an earlier SQLite backup to recover deleted entries; that replaces the current database and first makes a safety backup.

## Add aliases

```json
{
  "aliases": ["networking", "net"]
}
```

Send this body to `POST /keywords/{id}/aliases`. Alias names are checked against existing primary names and aliases, and aliases resolve to the canonical keyword in searches and entry creation.

## Automatic backups

Send `POST /settings/backups` with an interval in minutes and a retention limit:

```json
{
  "intervalMinutes": 5,
  "maxBackups": 14
}
```

Set `intervalMinutes` to `0` to turn automatic backups off. The API accepts integer intervals from `1` to `10080` minutes when enabled, or `0` to disable backups; `maxBackups` must be an integer from `1` to `100`. Defaults are `1440` minutes and `14` automatic backups. Automatic backups are stored separately from manual and import safety backups; only automatic backups are pruned to the configured maximum.

## Restore a backup point

First use `GET /backups`, then send its filename to the restore endpoint:

```json
{ "filename": "2026-08-16T12-00-00-000Z_auto.sqlite" }
```

Restoration replaces the live database, but the current data is automatically saved as a `pre-restore` backup first.

## Merge keywords

```json
{
  "sourceIds": ["keyword-id-one", "keyword-id-two"],
  "primaryId": "keyword-id-two"
}
```

The server creates an automatic SQLite backup, rewrites affected entries to the chosen primary keyword, and keeps each retired keyword as an alias.

## Update safely

Include the last-read `revision` in a PATCH body. A stale revision returns HTTP 409 rather than overwriting a newer edit.

## List filters

`GET /entries` accepts `q`, `keyword`, `bookNumber`, `status`, `sort`, `direction`, `limit`, and `offset` query parameters. Status values are `draft`, `review`, and `final`. `limit` is capped at 2,500.

## Import CSV or JSON

`POST /imports/csv` accepts the six-column historical CSV format:

```json
{
  "filename": "entries.csv",
  "csv": "Keyword,Concept/Data,...",
  "dryRun": true
}
```

Set `dryRun` to `false` to commit. Exact repeated rows are skipped, identity collisions are reported but preserved, and a pre-import backup is created automatically.

`POST /imports/json` accepts the complete JSON file from `GET /exports/json` without modification:

```json
{
  "filename": "my-index-index-backup.json",
  "json": "{\"format\":\"index-studio-backup\",\"version\":3,...}",
  "dryRun": true
}
```

JSON import preserves active entry IDs, timestamps, revisions, multiple keywords, keyword aliases, books, and rich-details images. By default, existing entry IDs are skipped and entries are not removed. Set `"updateExisting": true` in the request object to replace the fields of matching active entry IDs with the backup values; use a dry run first. A pre-import SQLite backup is made before committing. The CLI import command uses the default skip-existing behavior. Both formats provide the same dry-run report before any data is written.

## Notes, archived keywords and bulk status

Send `{"body":"Remember to review this topic"}` to `POST /notes`. Empty notes are rejected; the body limit is 1,048,576 UTF-8 bytes. Send `{}` to `POST /notes/{id}/archive`. Archived notes can be read with `includeArchived=true`; there is no note edit or restore endpoint.

Send `{}` to `POST /keywords/{id}/archive`. The keyword, aliases and links are saved in the profile's `index-archived.json`. Entries remain active; a `placeholder` keyword is assigned when necessary. The placeholder cannot be archived. Restore with `{}` sent to `/keywords/{URL-encoded-name}/restore`. A name now used as another keyword's alias can cause HTTP 409. Merging keywords is a separate action and keeps retired names as aliases.

Send `{"ids":["entry-id"],"status":"review"}` to `POST /entries/bulk`. Allowed statuses are `draft`, `review`, and `final`; the response contains `changed`.

## Backup coverage and request limits

JSON exports contain active entries, books, active keywords and aliases, preferences and status counts. JSON import restores entries, books and aliases; it does not restore exported preferences or status counts. JSON exports omit notes, soft-deleted entries and the separate archived-keyword file. SQLite backups preserve the profile database, including notes, but omit `index-archived.json` and the profile registry. For complete recovery, stop the app and copy the whole data folder.

The HTTP request body limit is 30,000,000 bytes. `POST /settings/preferences/clear` currently clears all workspace preferences, including automatic backup settings; backup settings then return to their defaults.
