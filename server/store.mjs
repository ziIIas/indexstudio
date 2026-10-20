import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fingerprintEntry, mapHistoricalRow, normalizeEntry, parseCsv, stringifyHistoricalCsv, validateEntry, validateHistoricalHeaders } from "./csv.mjs";

const SORT_COLUMNS = { keyword: "keyword", concept: "concept", bookNumber: "book_number", pageNumber: "page_number", status: "status", createdAt: "created_at", updatedAt: "updated_at" };
const statuses = ["draft", "review", "final"];
const now = () => new Date().toISOString();
const normal = (value) => String(value ?? "").trim().toLocaleLowerCase();
const clean = (value) => String(value ?? "").trim();
const safeJson = (value, fallback = []) => { try { return JSON.parse(value); } catch { return fallback; } };
const DEFAULT_BACKUP_SETTINGS = { intervalMinutes: 1440, maxBackups: 14 };
const MAX_BATCH_ENTRIES = 500;
const MAX_JSON_IMPORT_ENTRIES = 100_000;
const DETAIL_IMAGE_DATA = /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i;

function normalizeDetailsDocument(value) {
  if (value == null || value === "") return null;
  const document = typeof value === "string" ? safeJson(value, null) : value;
  if (!document || document.version !== 1 || !Array.isArray(document.nodes) || document.nodes.length > 1000) { const error = new Error("Additional details contain an invalid rich document."); error.statusCode = 422; throw error; }
  let totalBytes = 0;
  const nodes = document.nodes.map((node) => {
    if (node?.type === "text") {
      const text = String(node.text ?? "").replace(/\r\n?/g, "\n");
      totalBytes += Buffer.byteLength(text);
      return { type: "text", text };
    }
    if (node?.type === "image") {
      const dataUrl = String(node.dataUrl ?? "");
      const naturalWidth = Number(node.naturalWidth);
      const naturalHeight = Number(node.naturalHeight);
      const lines = Number(node.lines);
      if (!DETAIL_IMAGE_DATA.test(dataUrl) || !Number.isInteger(naturalWidth) || naturalWidth < 1 || naturalWidth > 100000 || !Number.isInteger(naturalHeight) || naturalHeight < 1 || naturalHeight > 100000 || !Number.isInteger(lines) || lines < 1 || lines > 50) { const error = new Error("Additional details contain an invalid image."); error.statusCode = 422; throw error; }
      totalBytes += Buffer.byteLength(dataUrl);
      return { type: "image", dataUrl, naturalWidth, naturalHeight, lines };
    }
    const error = new Error("Additional details contain an unsupported object."); error.statusCode = 422; throw error;
  });
  if (totalBytes > 24 * 1024 * 1024) { const error = new Error("Images in one entry must total less than 24 MB."); error.statusCode = 413; throw error; }
  return { version: 1, nodes };
}

const plainDetails = (document, fallback = "") => document ? document.nodes.filter((node) => node.type === "text").map((node) => node.text).join("").replaceAll("\u200b", "").trim() : fallback;

function rowToEntry(row) {
  if (!row) return null;
  return { id: row.id, keyword: row.keyword, primaryKeyword: row.keyword, keywords: [row.keyword], concept: row.concept, details: row.details, detailsDocument: row.details_json ? safeJson(row.details_json, null) : null, bookNumber: row.book_number, pageNumber: row.page_number, tags: safeJson(row.tags_json), status: row.status, sourceRow: row.source_row, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
}

export function createStore({ dataDir, backupDir, seedCsvPath = null }) {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  const databasePath = join(dataDir, "index.sqlite");
  // Archive data deliberately lives beside (not inside) the active database.
  // This keeps archived keywords out of normal exports while retaining enough
  // information to restore their aliases and entry memberships exactly.
  const archivePath = join(dataDir, "index-archived.json");
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, keyword TEXT NOT NULL, concept TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', details_json TEXT, book_number TEXT NOT NULL, page_number TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','final')), source_row INTEGER, source_fingerprint TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE IF NOT EXISTS entry_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL, action TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(entry_id) REFERENCES entries(id));
    CREATE TABLE IF NOT EXISTS import_jobs (id TEXT PRIMARY KEY, filename TEXT, total_rows INTEGER NOT NULL, imported_rows INTEGER NOT NULL, skipped_rows INTEGER NOT NULL, invalid_rows INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_source_fingerprint ON entries(source_fingerprint) WHERE source_fingerprint IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_entries_keyword ON entries(keyword COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_entries_book_number ON entries(book_number COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_entries_status_active ON entries(status) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, '${now()}');
  `);

  function readArchive() {
    if (!existsSync(archivePath)) return { format: "index-studio-archive", version: 1, keywords: [] };
    const parsed = safeJson(readFileSync(archivePath, "utf8"), null);
    return parsed?.format === "index-studio-archive" && Array.isArray(parsed.keywords)
      ? { format: "index-studio-archive", version: 1, keywords: parsed.keywords }
      : { format: "index-studio-archive", version: 1, keywords: [] };
  }
  function writeArchive(archive) {
    writeFileSync(archivePath, `${JSON.stringify({ format: "index-studio-archive", version: 1, updatedAt: now(), keywords: archive.keywords }, null, 2)}\n`, "utf8");
  }

  function backupNow(label = "manual") {
    db.exec("PRAGMA wal_checkpoint(FULL)");
    const cleanLabel = String(label).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "backup";
    const createdAt = now();
    const filename = `${createdAt.replace(/[:.]/g, "-")}_${cleanLabel}.sqlite`;
    const destination = join(backupDir, filename);
    copyFileSync(databasePath, destination);
    return { filename, path: destination, createdAt };
  }
  const preferenceMap = () => new Map(db.prepare("SELECT key,value FROM workspace_preferences").all().map((row) => [row.key, row.value]));
  function getBackupSettings() {
    const preferences = preferenceMap();
    const interval = Number(preferences.get("auto_backup_interval_minutes"));
    const max = Number(preferences.get("auto_backup_max_count"));
    return {
      intervalMinutes: Number.isInteger(interval) && interval >= 0 ? interval : DEFAULT_BACKUP_SETTINGS.intervalMinutes,
      maxBackups: Number.isInteger(max) && max >= 1 ? max : DEFAULT_BACKUP_SETTINGS.maxBackups,
      lastBackupAt: preferences.get("auto_backup_last_at") ?? null,
    };
  }
  function updateBackupSettings(payload = {}) {
    const intervalMinutes = Number(payload.intervalMinutes);
    const maxBackups = Number(payload.maxBackups);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 0 || intervalMinutes > 10080) { const error = new Error("Choose a valid automatic backup interval."); error.statusCode = 422; throw error; }
    if (!Number.isInteger(maxBackups) || maxBackups < 1 || maxBackups > 100) { const error = new Error("Choose a backup limit between 1 and 100."); error.statusCode = 422; throw error; }
    const stamp = now(); const save = db.prepare("INSERT INTO workspace_preferences(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at");
    save.run("auto_backup_interval_minutes", String(intervalMinutes), stamp);
    save.run("auto_backup_max_count", String(maxBackups), stamp);
    return getBackupSettings();
  }
  function pruneAutomaticBackups(maxBackups) {
    const files = readdirSync(backupDir).filter((file) => /_auto\.sqlite$/i.test(file)).sort().reverse();
    files.slice(maxBackups).forEach((file) => unlinkSync(join(backupDir, file)));
  }
  function listBackupPoints() {
    return readdirSync(backupDir).filter((file) => file.endsWith(".sqlite")).sort().reverse().map((filename) => {
      const info = statSync(join(backupDir, filename));
      const label = filename.replace(/^.*?_/, "").replace(/\.sqlite$/, "");
      return { filename, createdAt: info.mtime.toISOString(), size: info.size, kind: label };
    });
  }
  function restoreBackup(filename) {
    if (typeof filename !== "string" || filename !== basename(filename) || !filename.endsWith(".sqlite")) { const error = new Error("Choose a valid backup point."); error.statusCode = 422; throw error; }
    const source = join(backupDir, filename);
    if (!existsSync(source)) { const error = new Error("Backup point not found."); error.statusCode = 404; throw error; }
    const safety = backupNow("pre-restore");
    db.close();
    for (const suffix of ["-wal", "-shm"]) { try { unlinkSync(`${databasePath}${suffix}`); } catch (error) { if (error.code !== "ENOENT") throw error; } }
    copyFileSync(source, databasePath);
    return { restored: filename, safetyBackup: safety };
  }
  function runScheduledBackup() {
    const settings = getBackupSettings();
    if (!settings.intervalMinutes) return null;
    const last = settings.lastBackupAt ? Date.parse(settings.lastBackupAt) : 0;
    if (Number.isFinite(last) && Date.now() - last < settings.intervalMinutes * 60_000) return null;
    const backup = backupNow("auto");
    pruneAutomaticBackups(settings.maxBackups);
    db.prepare("INSERT INTO workspace_preferences(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run("auto_backup_last_at", backup.createdAt, backup.createdAt);
    return backup;
  }
  function insertBook(number, label = "", sortOrder = null) {
    const name = clean(number); if (!name) return null;
    const existing = db.prepare("SELECT * FROM books WHERE normalized_number = ?").get(normal(name)); if (existing) return existing;
    const order = sortOrder ?? Number(db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM books").get().value);
    const id = randomUUID(); const timestamp = now();
    db.prepare("INSERT INTO books(id, number, normalized_number, label, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(id, name, normal(name), clean(label), order, timestamp, timestamp);
    return db.prepare("SELECT * FROM books WHERE id = ?").get(id);
  }
  function keywordByNormalized(value) {
    const key = normal(value); if (!key) return null;
    return db.prepare("SELECT k.* FROM keywords k WHERE k.normalized_name=? AND k.merged_into_id IS NULL UNION ALL SELECT k.* FROM keyword_aliases a JOIN keywords k ON k.id=a.keyword_id WHERE a.normalized_alias=? AND k.merged_into_id IS NULL LIMIT 1").get(key, key);
  }
  function ensureKeyword(value) {
    const name = clean(value); if (!name) return null;
    const exact = db.prepare("SELECT * FROM keywords WHERE name=? AND merged_into_id IS NULL").get(name); if (exact) return exact;
    const found = keywordByNormalized(name); if (found) return found;
    const id = randomUUID(); const timestamp = now(); db.prepare("INSERT INTO keywords(id,name,normalized_name,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, name, normal(name), timestamp, timestamp);
    return db.prepare("SELECT * FROM keywords WHERE id=?").get(id);
  }
  function ensureKeywordExact(value) {
    const name = clean(value); if (!name) return null;
    const exact = db.prepare("SELECT * FROM keywords WHERE name=? AND merged_into_id IS NULL").get(name); if (exact) return exact;
    const id = randomUUID(); const timestamp = now(); db.prepare("INSERT INTO keywords(id,name,normalized_name,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, name, normal(name), timestamp, timestamp);
    return db.prepare("SELECT * FROM keywords WHERE id=?").get(id);
  }
  function migrateKeywordModel() {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=2").get()) return;
    const previousCount = Number(db.prepare("SELECT COUNT(*) AS count FROM entries").get().count); if (previousCount) backupNow("pre-keyword-model");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, number TEXT NOT NULL, normalized_number TEXT NOT NULL UNIQUE, label TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspace_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS keywords (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, normalized_name TEXT NOT NULL, merged_into_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(merged_into_id) REFERENCES keywords(id));
        CREATE TABLE IF NOT EXISTS keyword_aliases (id TEXT PRIMARY KEY, keyword_id TEXT NOT NULL, alias TEXT NOT NULL, normalized_alias TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, FOREIGN KEY(keyword_id) REFERENCES keywords(id));
        CREATE TABLE IF NOT EXISTS entry_keywords (entry_id TEXT NOT NULL, keyword_id TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN(0,1)), created_at TEXT NOT NULL, PRIMARY KEY(entry_id,keyword_id), FOREIGN KEY(entry_id) REFERENCES entries(id), FOREIGN KEY(keyword_id) REFERENCES keywords(id));
        CREATE TABLE IF NOT EXISTS keyword_merge_log (id TEXT PRIMARY KEY, target_keyword_id TEXT NOT NULL, source_keyword_ids_json TEXT NOT NULL, backup_filename TEXT, created_at TEXT NOT NULL, FOREIGN KEY(target_keyword_id) REFERENCES keywords(id));
        CREATE INDEX IF NOT EXISTS idx_books_active_order ON books(is_active,sort_order);
        CREATE INDEX IF NOT EXISTS idx_keyword_aliases_keyword_id ON keyword_aliases(keyword_id);
        CREATE INDEX IF NOT EXISTS idx_entry_keywords_keyword_id ON entry_keywords(keyword_id,entry_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_keywords_one_primary ON entry_keywords(entry_id) WHERE is_primary=1;
      `);
      let order = 0;
      for (const row of db.prepare("SELECT DISTINCT book_number AS value FROM entries WHERE trim(book_number)<>'' ORDER BY book_number COLLATE NOCASE").all()) insertBook(row.value, "", order++);
      for (const row of db.prepare("SELECT id,keyword FROM entries WHERE trim(keyword)<>''").all()) { const keyword = ensureKeywordExact(row.keyword); db.prepare("INSERT OR IGNORE INTO entry_keywords(entry_id,keyword_id,is_primary,created_at) VALUES(?,?,1,?)").run(row.id, keyword.id, now()); }
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)").run(now()); db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  migrateKeywordModel();
  function migrateRichDetails() {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=4").get()) return;
    const hasColumn = db.prepare("PRAGMA table_info(entries)").all().some((column) => column.name === "details_json");
    if (!hasColumn && Number(db.prepare("SELECT COUNT(*) AS count FROM entries").get().count)) backupNow("pre-rich-details");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!hasColumn) db.exec("ALTER TABLE entries ADD COLUMN details_json TEXT");
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(4,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  migrateRichDetails();
  function migrateNotes() {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=5").get()) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          archived_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_notes_active_created_at ON notes(created_at DESC) WHERE archived_at IS NULL;
      `);
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(5,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  migrateNotes();
  const noteDto = (row) => row ? ({ id: row.id, body: row.body, createdAt: row.created_at, archivedAt: row.archived_at }) : null;
  function listNotes(includeArchived = false) {
    return db.prepare(`SELECT * FROM notes ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at DESC, rowid DESC`).all().map(noteDto);
  }
  function createNote(payload = {}) {
    const body = String(payload.body ?? "").replace(/\r\n?/g, "\n");
    if (!body.trim()) { const error = new Error("Write something before saving the note."); error.statusCode = 422; throw error; }
    if (Buffer.byteLength(body) > 1024 * 1024) { const error = new Error("A note must be smaller than 1 MB."); error.statusCode = 413; throw error; }
    const id = randomUUID(), createdAt = now();
    db.prepare("INSERT INTO notes(id,body,created_at,archived_at) VALUES(?,?,?,NULL)").run(id, body, createdAt);
    return noteDto(db.prepare("SELECT * FROM notes WHERE id=?").get(id));
  }
  function archiveNote(id) {
    const archivedAt = now();
    const result = db.prepare("UPDATE notes SET archived_at=? WHERE id=? AND archived_at IS NULL").run(archivedAt, id);
    return result.changes ? noteDto(db.prepare("SELECT * FROM notes WHERE id=?").get(id)) : null;
  }
  const bookDto = (row) => ({ id: row.id, number: row.number, label: row.label, sortOrder: row.sort_order, active: Boolean(row.is_active), createdAt: row.created_at, updatedAt: row.updated_at });
  const getBooks = (includeArchived = false) => db.prepare(`SELECT * FROM books ${includeArchived ? "" : "WHERE is_active=1"} ORDER BY is_active DESC,sort_order,number COLLATE NOCASE`).all().map(bookDto);
  const ensureBook = (number) => insertBook(number);
  const keywordDto = (row, matchedAlias = null) => ({ id: row.id, name: row.name, aliases: db.prepare("SELECT alias FROM keyword_aliases WHERE keyword_id=? ORDER BY alias COLLATE NOCASE").all(row.id).map((item) => item.alias), matchedAlias });
  function resolveKeywords(values, primaryValue = null) {
    const tokens = (Array.isArray(values) ? values : String(values ?? "").split(/[,;]+/)).map(clean).filter(Boolean); const unique = [...new Map(tokens.map((token) => [normal(token), token])).values()];
    if (!unique.length) { const error = new Error("Choose at least one keyword."); error.statusCode = 422; throw error; }
    const entries = unique.map(ensureKeyword); const primary = ensureKeyword(clean(primaryValue || unique[0])) || entries[0];
    return [primary, ...entries.filter((item) => item.id !== primary.id)];
  }
  function decorateEntries(rows) {
    const entries = rows.map(rowToEntry); if (!entries.length) return entries; const ids = entries.map((entry) => entry.id);
    const associations = db.prepare(`SELECT ek.entry_id,k.name,ek.is_primary FROM entry_keywords ek JOIN keywords k ON k.id=ek.keyword_id WHERE ek.entry_id IN (${ids.map(() => "?").join(",")}) ORDER BY ek.is_primary DESC,k.name COLLATE NOCASE`).all(...ids);
    const byEntry = new Map(); for (const row of associations) { const list = byEntry.get(row.entry_id) ?? []; list.push(row); byEntry.set(row.entry_id, list); }
    return entries.map((entry) => { const list = byEntry.get(entry.id) ?? []; if (!list.length) return entry; const primary = list.find((item) => item.is_primary)?.name ?? list[0].name; return { ...entry, keyword: primary, primaryKeyword: primary, keywords: list.map((item) => item.name) }; });
  }
  const getEntry = (id, includeDeleted = false) => { const row = db.prepare(`SELECT * FROM entries WHERE id=?${includeDeleted ? "" : " AND deleted_at IS NULL"}`).get(id); return decorateEntries(row ? [row] : [])[0] ?? null; };
  const recordRevision = (entry, action) => entry && db.prepare("INSERT INTO entry_revisions(entry_id,action,snapshot_json,created_at) VALUES(?,?,?,?)").run(entry.id, action, JSON.stringify(entry), now());
  function setEntryKeywords(entryId, keywordRows) { db.prepare("DELETE FROM entry_keywords WHERE entry_id=?").run(entryId); const insert = db.prepare("INSERT INTO entry_keywords(entry_id,keyword_id,is_primary,created_at) VALUES(?,?,?,?)"); keywordRows.forEach((keyword, index) => insert.run(entryId, keyword.id, index === 0 ? 1 : 0, now())); }
  function migrateLegacyKeywordRows() {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=3").get()) return;
    const rows = db.prepare("SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY created_at,source_row,id").all();
    const groups = new Map();
    for (const row of rows) {
      const key = [normal(row.concept), clean(row.details), normal(row.book_number), normal(row.page_number)].join("\u0000");
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    const duplicates = [...groups.values()].filter((group) => group.length > 1);
    if (duplicates.length) backupNow("pre-entry-keyword-consolidation");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const group of duplicates) {
        const [keeper, ...retired] = group;
        const retiredIds = retired.map((row) => row.id);
        const ids = group.map((row) => row.id);
        const keywordRows = db.prepare(`SELECT keyword_id FROM entry_keywords WHERE entry_id IN (${ids.map(() => "?").join(",")})`).all(...ids);
        const tagValues = [...new Map(group.flatMap((row) => safeJson(row.tags_json).map(clean).filter(Boolean)).map((tag) => [normal(tag), tag])).values()];
        const stamp = now();
        const addKeyword = db.prepare("INSERT OR IGNORE INTO entry_keywords(entry_id,keyword_id,is_primary,created_at) VALUES(?,?,0,?)");
        for (const keyword of keywordRows) addKeyword.run(keeper.id, keyword.keyword_id, stamp);
        db.prepare("UPDATE entries SET tags_json=?,revision=revision+1,updated_at=? WHERE id=?").run(JSON.stringify(tagValues), stamp, keeper.id);
        const retire = db.prepare("UPDATE entries SET deleted_at=?,revision=revision+1,updated_at=? WHERE id=?");
        for (const id of retiredIds) retire.run(stamp, stamp, id);
        recordRevision(getEntry(keeper.id), "consolidate-keywords");
      }
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(3,?)").run(now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function prepareEntry(payload, fallback = null) { const names = payload.keywords ?? fallback?.keywords ?? payload.keyword ?? fallback?.keyword; const keywordRows = resolveKeywords(names, payload.primaryKeyword ?? fallback?.primaryKeyword ?? payload.keyword ?? fallback?.keyword); const entry = normalizeEntry({ ...fallback, ...payload, keyword: keywordRows[0].name }); entry.detailsDocument = normalizeDetailsDocument(entry.detailsDocument); entry.details = plainDetails(entry.detailsDocument, entry.details); return { entry, keywordRows }; }
  function validatePrepared(entry) { const errors = validateEntry(entry); if (errors.length) { const error = new Error(errors.join(" ")); error.statusCode = 422; error.details = errors; throw error; } }
  function insertPrepared(entry, keywordRows, metadata = {}) { const id = metadata.id ?? randomUUID(); const timestamp = now(); const createdAt = metadata.createdAt ?? timestamp; const updatedAt = metadata.updatedAt ?? createdAt; const revision = metadata.revision ?? 1; ensureBook(entry.bookNumber); db.prepare("INSERT INTO entries(id,keyword,concept,details,details_json,book_number,page_number,tags_json,status,source_row,source_fingerprint,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,entry.keyword,entry.concept,entry.details,entry.detailsDocument?JSON.stringify(entry.detailsDocument):null,entry.bookNumber,entry.pageNumber,JSON.stringify(entry.tags),entry.status,metadata.sourceRow ?? null,metadata.sourceFingerprint ?? null,revision,createdAt,updatedAt); setEntryKeywords(id, keywordRows); const created = getEntry(id); recordRevision(created,"create"); return created; }
  function rememberEntry(entry) { const book = db.prepare("SELECT id FROM books WHERE normalized_number=?").get(normal(entry.bookNumber)); if (!book) return; const stamp = now(); for (const [key,value] of [["last_book_id",book.id],["last_page_number",entry.pageNumber],[`last_page_for_book_${book.id}`,entry.pageNumber]]) db.prepare("INSERT INTO workspace_preferences(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key,value,stamp); }
  function createEntry(payload) { db.exec("BEGIN IMMEDIATE"); try { const { entry, keywordRows } = prepareEntry(payload); validatePrepared(entry); const created = insertPrepared(entry,keywordRows); rememberEntry(created); db.exec("COMMIT"); return created; } catch (error) { db.exec("ROLLBACK"); throw error; } }
  function createEntries(payload) {
    const entries = Array.isArray(payload) ? payload : payload?.entries;
    if (!Array.isArray(entries) || !entries.length) { const error = new Error("Provide at least one entry in an entries array."); error.statusCode = 422; throw error; }
    if (entries.length > MAX_BATCH_ENTRIES) { const error = new Error(`A batch can contain at most ${MAX_BATCH_ENTRIES} entries.`); error.statusCode = 422; throw error; }
    db.exec("BEGIN IMMEDIATE");
    try {
      const created = entries.map((payloadEntry, index) => {
        try {
          if (!payloadEntry || typeof payloadEntry !== "object" || Array.isArray(payloadEntry)) { const error = new Error("Entry must be a JSON object."); error.statusCode = 422; throw error; }
          const { entry, keywordRows } = prepareEntry(payloadEntry);
          validatePrepared(entry);
          const result = insertPrepared(entry, keywordRows);
          rememberEntry(result);
          return result;
        } catch (error) {
          error.message = `Entry ${index + 1}: ${error.message}`;
          error.entryIndex = index;
          throw error;
        }
      });
      db.exec("COMMIT");
      return { items: created, created: created.length };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function updateEntry(id,payload) { const current = getEntry(id); if (!current) { const error = new Error("Entry not found."); error.statusCode=404; throw error; } if (payload.revision != null && Number(payload.revision)!==current.revision) { const error = new Error("This entry changed after it was opened. Reload it before saving."); error.statusCode=409; throw error; } db.exec("BEGIN IMMEDIATE"); try { const { entry,keywordRows }=prepareEntry(payload,current); validatePrepared(entry); ensureBook(entry.bookNumber); db.prepare("UPDATE entries SET keyword=?,concept=?,details=?,details_json=?,book_number=?,page_number=?,tags_json=?,status=?,revision=revision+1,updated_at=? WHERE id=?").run(entry.keyword,entry.concept,entry.details,entry.detailsDocument?JSON.stringify(entry.detailsDocument):null,entry.bookNumber,entry.pageNumber,JSON.stringify(entry.tags),entry.status,now(),id); setEntryKeywords(id,keywordRows); const updated=getEntry(id); recordRevision(updated,"update"); db.exec("COMMIT"); return updated; } catch(error) { db.exec("ROLLBACK"); throw error; } }
  function listEntries(options={}) { const clauses=["e.deleted_at IS NULL"],params=[]; if(options.q){const term=`%${String(options.q)}%`;clauses.push("(e.keyword LIKE ? OR e.concept LIKE ? OR e.details LIKE ? OR e.book_number LIKE ? OR e.page_number LIKE ? OR e.tags_json LIKE ? OR EXISTS(SELECT 1 FROM entry_keywords ek JOIN keywords k ON k.id=ek.keyword_id WHERE ek.entry_id=e.id AND k.name LIKE ?))");params.push(term,term,term,term,term,term,term);} if(options.keyword){const keyword=keywordByNormalized(options.keyword);if(keyword){clauses.push("EXISTS(SELECT 1 FROM entry_keywords ek WHERE ek.entry_id=e.id AND ek.keyword_id=?)");params.push(keyword.id);}else clauses.push("0");} if(options.bookNumber){clauses.push("e.book_number=?");params.push(options.bookNumber);}if(options.status){clauses.push("e.status=?");params.push(options.status);}const where=clauses.join(" AND "),total=Number(db.prepare(`SELECT COUNT(*) AS count FROM entries e WHERE ${where}`).get(...params).count),column=SORT_COLUMNS[options.sort]??"keyword",direction=String(options.direction).toLowerCase()==="desc"?"DESC":"ASC",limit=Math.min(Math.max(Number(options.limit)||100,1),2500),offset=Math.max(Number(options.offset)||0,0),tieBreak=(column==="created_at"||column==="updated_at")?`e.rowid ${direction}`:"e.concept COLLATE NOCASE";const rows=db.prepare(`SELECT e.* FROM entries e WHERE ${where} ORDER BY e.${column} COLLATE NOCASE ${direction},${tieBreak} LIMIT ? OFFSET ?`).all(...params,limit,offset);return {items:decorateEntries(rows),total,limit,offset}; }
  const listRecentEntries = ({ limit = 10, keyword = "" } = {}) => listEntries({ keyword, sort: "createdAt", direction: "desc", limit });
  function deleteEntry(id){const current=getEntry(id);if(!current)return false;recordRevision(current,"delete");db.prepare("UPDATE entries SET deleted_at=?,revision=revision+1,updated_at=? WHERE id=?").run(now(),now(),id);return true;}
  function bulkUpdate({ids,status}){if(!Array.isArray(ids)||!ids.length||!statuses.includes(status)){const error=new Error("Choose at least one entry and a valid status.");error.statusCode=422;throw error;}const stmt=db.prepare("UPDATE entries SET status=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL");let changed=0;db.exec("BEGIN IMMEDIATE");try{for(const id of ids)changed+=Number(stmt.run(status,now(),id).changes);db.exec("COMMIT");return {changed};}catch(error){db.exec("ROLLBACK");throw error;}}
  function getStatus(){const counts=db.prepare("SELECT COUNT(*) AS total,COUNT(DISTINCT book_number) AS sources,SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS draft,SUM(CASE WHEN status='review' THEN 1 ELSE 0 END) AS review,SUM(CASE WHEN status='final' THEN 1 ELSE 0 END) AS final,SUM(CASE WHEN trim(details)='' THEN 1 ELSE 0 END) AS missing_details FROM entries WHERE deleted_at IS NULL").get(),keywordCount=Number(db.prepare("SELECT COUNT(DISTINCT ek.keyword_id) AS count FROM entry_keywords ek JOIN entries e ON e.id=ek.entry_id WHERE e.deleted_at IS NULL").get().count),collisionExtraRows=Number(db.prepare("SELECT COALESCE(SUM(group_count-1),0) AS count FROM (SELECT COUNT(*) AS group_count FROM entries WHERE deleted_at IS NULL GROUP BY lower(trim(concept)),lower(trim(book_number)),lower(trim(page_number)) HAVING COUNT(*)>1)").get().count),topKeywords=db.prepare("SELECT k.name AS label,COUNT(DISTINCT ek.entry_id) AS count FROM entry_keywords ek JOIN keywords k ON k.id=ek.keyword_id JOIN entries e ON e.id=ek.entry_id WHERE e.deleted_at IS NULL GROUP BY k.id ORDER BY count DESC,k.name COLLATE NOCASE LIMIT 10").all(),sourceCounts=db.prepare("SELECT book_number AS label,COUNT(*) AS count FROM entries WHERE deleted_at IS NULL GROUP BY book_number ORDER BY count DESC,book_number COLLATE NOCASE").all();return {total:Number(counts.total??0),keywords:keywordCount,sources:Number(counts.sources??0),statuses:{draft:Number(counts.draft??0),review:Number(counts.review??0),final:Number(counts.final??0)},missingDetails:Number(counts.missing_details??0),collisionExtraRows,topKeywords,sourceCounts};}
  function getPreferences(){const map=preferenceMap(),pagesByBook={};for(const [key,value] of map)if(key.startsWith("last_page_for_book_"))pagesByBook[key.slice(19)]=value;return {lastBookId:map.get("last_book_id")||null,lastPageNumber:map.get("last_page_number")||"",pagesByBook};}
  const clearPreferences=()=>{db.prepare("DELETE FROM workspace_preferences").run();return getPreferences();};
  function listKeywords(includeArchived = false){const active=db.prepare("SELECT k.*,COUNT(DISTINCT ek.entry_id) AS usage FROM keywords k LEFT JOIN entry_keywords ek ON ek.keyword_id=k.id LEFT JOIN entries e ON e.id=ek.entry_id AND e.deleted_at IS NULL WHERE k.merged_into_id IS NULL GROUP BY k.id ORDER BY k.name COLLATE NOCASE").all().map(row=>({...keywordDto(row),usage:Number(row.usage)}));if(!includeArchived)return active;const archived=readArchive().keywords.map(item=>({id:item.id,name:item.name,aliases:item.aliases??[],usage:item.entryLinks?.length??0,archived:true,archivedAt:item.archivedAt}));return [...active,...archived].sort((a,b)=>a.name.localeCompare(b.name));}
  function archiveKeyword(id) {
    const keyword = db.prepare("SELECT * FROM keywords WHERE id=? AND merged_into_id IS NULL").get(id);
    if (!keyword) { const error = new Error("Keyword not found."); error.statusCode = 404; throw error; }
    if (normal(keyword.name) === "placeholder") { const error = new Error("The placeholder keyword keeps otherwise unassigned entries indexed and cannot be archived."); error.statusCode = 422; throw error; }
    const archive = readArchive();
    if (archive.keywords.some((item) => normal(item.name) === normal(keyword.name))) { const error = new Error("That keyword is already archived."); error.statusCode = 409; throw error; }
    const links = db.prepare("SELECT ek.entry_id,ek.is_primary,e.deleted_at FROM entry_keywords ek JOIN entries e ON e.id=ek.entry_id WHERE ek.keyword_id=?").all(keyword.id).map((link) => ({ ...link, needsPlaceholder: !link.deleted_at && Number(db.prepare("SELECT COUNT(*) AS count FROM entry_keywords WHERE entry_id=?").get(link.entry_id).count) < 2 }));
    const aliases = db.prepare("SELECT alias FROM keyword_aliases WHERE keyword_id=? ORDER BY alias COLLATE NOCASE").all(keyword.id).map((row) => row.alias);
    const stamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const placeholder = links.some((link) => link.needsPlaceholder) ? ensureKeyword("placeholder") : null;
      for (const link of links) {
        const current = link.deleted_at ? null : getEntry(link.entry_id);
        recordRevision(current, "archive-keyword");
        if (link.is_primary && !link.deleted_at) {
          const replacement = link.needsPlaceholder ? placeholder : db.prepare("SELECT k.id,k.name FROM entry_keywords ek JOIN keywords k ON k.id=ek.keyword_id WHERE ek.entry_id=? AND ek.keyword_id<>? ORDER BY k.name COLLATE NOCASE LIMIT 1").get(link.entry_id, keyword.id);
          if (link.needsPlaceholder) db.prepare("INSERT OR IGNORE INTO entry_keywords(entry_id,keyword_id,is_primary,created_at) VALUES(?,?,0,?)").run(link.entry_id, placeholder.id, stamp);
          db.prepare("UPDATE entry_keywords SET is_primary=0 WHERE entry_id=? AND keyword_id=?").run(link.entry_id, keyword.id);
          db.prepare("UPDATE entry_keywords SET is_primary=1 WHERE entry_id=? AND keyword_id=?").run(link.entry_id, replacement.id);
          db.prepare("UPDATE entries SET keyword=?,revision=revision+1,updated_at=? WHERE id=?").run(replacement.name, stamp, link.entry_id);
        }
        db.prepare("DELETE FROM entry_keywords WHERE entry_id=? AND keyword_id=?").run(link.entry_id, keyword.id);
      }
      // A merge leaves historical source rows and a merge log pointing at the
      // target. They must leave with the archived keyword or SQLite correctly
      // rejects deleting it as still referenced.
      db.prepare("DELETE FROM keyword_aliases WHERE keyword_id IN (SELECT id FROM keywords WHERE merged_into_id=?)").run(keyword.id);
      db.prepare("DELETE FROM keywords WHERE merged_into_id=?").run(keyword.id);
      db.prepare("DELETE FROM keyword_merge_log WHERE target_keyword_id=?").run(keyword.id);
      db.prepare("DELETE FROM keyword_aliases WHERE keyword_id=?").run(keyword.id);
      db.prepare("DELETE FROM keywords WHERE id=?").run(keyword.id);
      archive.keywords.push({ id: keyword.id, name: keyword.name, aliases, entryLinks: links.filter((link) => !link.deleted_at).map((link) => ({ entryId: link.entry_id, isPrimary: Boolean(link.is_primary), placeholderAdded: link.needsPlaceholder })), archivedAt: stamp });
      writeArchive(archive); db.exec("COMMIT");
      return { name: keyword.name, removedFrom: links.filter((link) => !link.deleted_at).length, archivedAt: stamp };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function restoreKeyword(name) { const archive = readArchive(), index = archive.keywords.findIndex((item) => normal(item.name) === normal(name)); if (index < 0) { const error = new Error("Archived keyword not found."); error.statusCode = 404; throw error; } const archived = archive.keywords[index], existing = keywordByNormalized(archived.name); if (existing && normal(existing.name) !== normal(archived.name)) { const error = new Error(`Cannot restore \"${archived.name}\" because its name is now an alias for \"${existing.name}\".`); error.statusCode = 409; throw error; } const stamp = now(); db.exec("BEGIN IMMEDIATE"); try { const keyword = existing ?? (() => { const id = randomUUID(); db.prepare("INSERT INTO keywords(id,name,normalized_name,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, archived.name, normal(archived.name), stamp, stamp); return db.prepare("SELECT * FROM keywords WHERE id=?").get(id); })(); for (const alias of archived.aliases ?? []) { const owner = keywordByNormalized(alias); if (!owner) db.prepare("INSERT INTO keyword_aliases(id,keyword_id,alias,normalized_alias,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), keyword.id, alias, normal(alias), stamp); } let restoredTo = 0; for (const link of archived.entryLinks ?? []) { const entry = getEntry(link.entryId); if (!entry) continue; recordRevision(entry, "restore-keyword"); db.prepare("INSERT OR IGNORE INTO entry_keywords(entry_id,keyword_id,is_primary,created_at) VALUES(?,?,0,?)").run(link.entryId, keyword.id, stamp); if (link.isPrimary) { db.prepare("UPDATE entry_keywords SET is_primary=0 WHERE entry_id=?").run(link.entryId); db.prepare("UPDATE entry_keywords SET is_primary=1 WHERE entry_id=? AND keyword_id=?").run(link.entryId, keyword.id); db.prepare("UPDATE entries SET keyword=?,revision=revision+1,updated_at=? WHERE id=?").run(keyword.name, stamp, link.entryId); } else db.prepare("UPDATE entries SET revision=revision+1,updated_at=? WHERE id=?").run(stamp, link.entryId); if (link.placeholderAdded) db.prepare("DELETE FROM entry_keywords WHERE entry_id=? AND keyword_id=(SELECT id FROM keywords WHERE normalized_name='placeholder' AND merged_into_id IS NULL)").run(link.entryId); restoredTo += 1; } archive.keywords.splice(index, 1); writeArchive(archive); db.exec("COMMIT"); return { name: archived.name, restoredTo }; } catch (error) { db.exec("ROLLBACK"); throw error; } }
  function searchKeywords(query=""){const q=`%${normal(query)}%`;return db.prepare("SELECT DISTINCT k.*,CASE WHEN k.normalized_name LIKE ? THEN NULL ELSE a.alias END AS matched_alias FROM keywords k LEFT JOIN keyword_aliases a ON a.keyword_id=k.id WHERE k.merged_into_id IS NULL AND (k.normalized_name LIKE ? OR a.normalized_alias LIKE ?) ORDER BY k.name COLLATE NOCASE LIMIT 30").all(q,q,q).map(row=>keywordDto(row,row.matched_alias));}
  function createKeyword(payload){const keyword=ensureKeyword(payload.name);if(!keyword){const error=new Error("Keyword name is required.");error.statusCode=422;throw error;}return keywordDto(keyword);}
  function addKeywordAliases(id,payload={}){const target=db.prepare("SELECT * FROM keywords WHERE id=? AND merged_into_id IS NULL").get(id);if(!target){const error=new Error("Keyword not found.");error.statusCode=404;throw error;}const supplied=Array.isArray(payload.aliases)?payload.aliases:[payload.alias??payload.aliases];const aliases=[...new Map(supplied.map(clean).filter(Boolean).map(alias=>[normal(alias),alias])).values()];if(!aliases.length){const error=new Error("Enter at least one alias.");error.statusCode=422;throw error;}for(const alias of aliases){if(normal(alias)===target.normalized_name){const error=new Error(`\"${alias}\" is already the primary keyword name.`);error.statusCode=409;throw error;}const owner=keywordByNormalized(alias);if(owner){const error=new Error(owner.id===target.id?`\"${alias}\" is already an alias for \"${target.name}\".`:`\"${alias}\" is already used by \"${owner.name}\".`);error.statusCode=409;throw error;}}const timestamp=now();db.exec("BEGIN IMMEDIATE");try{for(const alias of aliases)db.prepare("INSERT INTO keyword_aliases(id,keyword_id,alias,normalized_alias,created_at) VALUES(?,?,?,?,?)").run(randomUUID(),target.id,alias,normal(alias),timestamp);db.prepare("UPDATE keywords SET updated_at=? WHERE id=?").run(timestamp,target.id);db.exec("COMMIT");return {target:keywordDto(db.prepare("SELECT * FROM keywords WHERE id=?").get(target.id)),added:aliases.length};}catch(error){db.exec("ROLLBACK");throw error;}}
  function getMeta(){return {keywords:listKeywords().map(item=>item.name),books:getBooks().map(item=>item.number),bookOptions:getBooks(),statuses,preferences:getPreferences()};}
  function createBook(payload){const book=insertBook(payload.number,payload.label);if(!book){const error=new Error("Book number is required.");error.statusCode=422;throw error;}return bookDto(book);}
  function updateBook(id,payload){const current=db.prepare("SELECT * FROM books WHERE id=?").get(id);if(!current){const error=new Error("Book not found.");error.statusCode=404;throw error;}const number=payload.number==null?current.number:clean(payload.number);if(!number){const error=new Error("Book number is required.");error.statusCode=422;throw error;}const duplicate=db.prepare("SELECT id FROM books WHERE normalized_number=? AND id<>?").get(normal(number),id);if(duplicate){const error=new Error("That book number already exists.");error.statusCode=409;throw error;}db.prepare("UPDATE books SET number=?,normalized_number=?,label=?,sort_order=?,is_active=?,updated_at=? WHERE id=?").run(number,normal(number),payload.label==null?current.label:clean(payload.label),payload.sortOrder==null?current.sort_order:Number(payload.sortOrder),payload.active==null?current.is_active:(payload.active?1:0),now(),id);return bookDto(db.prepare("SELECT * FROM books WHERE id=?").get(id));}
  function mergeKeywords(payload){const sourceIds=[...new Set((payload.sourceIds??[]).map(String))];if(sourceIds.length<2){const error=new Error("Choose at least two keywords to merge.");error.statusCode=422;throw error;}const target=payload.primaryId?db.prepare("SELECT * FROM keywords WHERE id=? AND merged_into_id IS NULL").get(payload.primaryId):null;if(!target||!sourceIds.includes(target.id)){const error=new Error("Choose one selected keyword as the primary name.");error.statusCode=422;throw error;}const sources=db.prepare(`SELECT * FROM keywords WHERE id IN(${sourceIds.map(()=>"?").join(",")}) AND merged_into_id IS NULL`).all(...sourceIds);if(sources.length!==sourceIds.length){const error=new Error("One or more selected keywords are unavailable.");error.statusCode=409;throw error;}const backup=backupNow("pre-keyword-merge");db.exec("BEGIN IMMEDIATE");try{for(const source of sources.filter(item=>item.id!==target.id)){const affected=db.prepare("SELECT entry_id,is_primary FROM entry_keywords WHERE keyword_id=?").all(source.id);for(const row of affected){db.prepare("INSERT OR IGNORE INTO entry_keywords(entry_id,keyword_id,is_primary,created_at) VALUES(?,?,0,?)").run(row.entry_id,target.id,now());if(row.is_primary){db.prepare("UPDATE entry_keywords SET is_primary=0 WHERE entry_id=? AND keyword_id=?").run(row.entry_id,source.id);db.prepare("UPDATE entry_keywords SET is_primary=1 WHERE entry_id=? AND keyword_id=?").run(row.entry_id,target.id);}}for(const alias of db.prepare("SELECT alias,normalized_alias FROM keyword_aliases WHERE keyword_id=?").all(source.id))db.prepare("INSERT OR IGNORE INTO keyword_aliases(id,keyword_id,alias,normalized_alias,created_at) VALUES(?,?,?,?,?)").run(randomUUID(),target.id,alias.alias,alias.normalized_alias,now());db.prepare("INSERT OR IGNORE INTO keyword_aliases(id,keyword_id,alias,normalized_alias,created_at) VALUES(?,?,?,?,?)").run(randomUUID(),target.id,source.name,source.normalized_name,now());db.prepare("DELETE FROM entry_keywords WHERE keyword_id=?").run(source.id);db.prepare("DELETE FROM keyword_aliases WHERE keyword_id=?").run(source.id);db.prepare("UPDATE keywords SET merged_into_id=?,updated_at=? WHERE id=?").run(target.id,now(),source.id);}for(const row of db.prepare("SELECT DISTINCT entry_id FROM entry_keywords WHERE keyword_id=?").all(target.id)){const primary=db.prepare("SELECT k.name FROM entry_keywords ek JOIN keywords k ON k.id=ek.keyword_id WHERE ek.entry_id=? AND ek.is_primary=1").get(row.entry_id);if(primary)db.prepare("UPDATE entries SET keyword=?,updated_at=? WHERE id=?").run(primary.name,now(),row.entry_id);}db.prepare("INSERT INTO keyword_merge_log(id,target_keyword_id,source_keyword_ids_json,backup_filename,created_at) VALUES(?,?,?,?,?)").run(randomUUID(),target.id,JSON.stringify(sourceIds),backup.filename,now());db.exec("COMMIT");return {target:keywordDto(target),backup,merged:sourceIds.length-1};}catch(error){db.exec("ROLLBACK");throw error;}}
  const identityCollisionRows = (valid) => { const counts = new Map(), all = db.prepare("SELECT concept,book_number,page_number FROM entries WHERE deleted_at IS NULL").all().map(row => ({ concept: row.concept, bookNumber: row.book_number, pageNumber: row.page_number })).concat(valid.map(item => item.entry)); for (const entry of all) { const key = `${normal(entry.concept)}\u0000${normal(entry.bookNumber)}\u0000${normal(entry.pageNumber)}`; counts.set(key, (counts.get(key) ?? 0) + 1); } return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0); };
  const publicImportReport = (report, importedRows = 0) => { const { valid, books, keywords, updateRows = 0, ...publicReport } = report; return { ...publicReport, importedRows, updatedRows: updateRows }; };
  function inspectImport(csvText) { const parsed = parseCsv(csvText), missingHeaders = validateHistoricalHeaders(parsed.headers), valid = [], invalid = [], seen = new Set(), existing = new Set(db.prepare("SELECT source_fingerprint FROM entries WHERE source_fingerprint IS NOT NULL").all().map(row => row.source_fingerprint)); let duplicateRows = 0; for (const source of parsed.rows) { const entry = normalizeEntry(mapHistoricalRow(source)), errors = validateEntry(entry); if (errors.length) { invalid.push({ row: source.__rowNumber, errors }); continue; } const fingerprint = fingerprintEntry(entry); if (existing.has(fingerprint) || seen.has(fingerprint)) { duplicateRows += 1; continue; } seen.add(fingerprint); valid.push({ entry, sourceRow: source.__rowNumber, fingerprint }); } return { format: "csv", headers: parsed.headers, missingHeaders, totalRows: parsed.rows.length, validRows: valid.length, duplicateRows, invalidRows: invalid.length, invalid: invalid.slice(0, 25), identityCollisionRows: identityCollisionRows(valid), preview: valid.slice(0, 5).map(item => item.entry), valid, books: [], keywords: [] }; }
  function importCsv(csvText, { filename = "import.csv", dryRun = true } = {}) { const report = inspectImport(csvText); if (report.missingHeaders.length) { const error = new Error(`Missing required columns: ${report.missingHeaders.join(", ")}`); error.statusCode = 422; error.details = publicImportReport(report); throw error; } if (dryRun) return publicImportReport(report); const backup = backupNow("pre-import"); let importedRows = 0; db.exec("BEGIN IMMEDIATE"); try { for (const item of report.valid) { const keyword = ensureKeywordExact(item.entry.keyword); insertPrepared(item.entry, [keyword], { sourceRow: item.sourceRow, sourceFingerprint: item.fingerprint }); importedRows += 1; } db.prepare("INSERT INTO import_jobs(id,filename,total_rows,imported_rows,skipped_rows,invalid_rows,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), basename(filename), report.totalRows, importedRows, report.duplicateRows, report.invalidRows, now()); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } return { ...publicImportReport(report, importedRows), backup }; }
  function jsonImportError(message, details = undefined) { const error = new Error(message); error.statusCode = 422; error.details = details; return error; }
  function validImportedTimestamp(value, field, label) { const timestamp = clean(value); if (!timestamp || !Number.isFinite(Date.parse(timestamp))) throw jsonImportError(`${label}: ${field} must be a valid ISO timestamp.`); return timestamp; }
  function prepareJsonImportEntry(source, index) {
    const row = index + 1;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw jsonImportError(`Entry ${row}: entry must be a JSON object.`);
    const values = Array.isArray(source.keywords) ? source.keywords : String(source.keywords ?? source.keyword ?? "").split(/[,;]+/);
    const keywordNames = [...new Map(values.map(clean).filter(Boolean).map(value => [normal(value), value])).values()];
    const primaryKeyword = clean(source.primaryKeyword) || clean(source.keyword) || keywordNames[0];
    if (primaryKeyword && !keywordNames.some(value => normal(value) === normal(primaryKeyword))) keywordNames.unshift(primaryKeyword);
    if (!keywordNames.length) throw jsonImportError(`Entry ${row}: choose at least one keyword.`);
    if (source.status != null && !statuses.includes(source.status)) throw jsonImportError(`Entry ${row}: status must be draft, review, or final.`);
    if (source.deletedAt != null) throw jsonImportError(`Entry ${row}: deleted entries cannot be imported from a JSON backup.`);
    const id = clean(source.id); if (!id) throw jsonImportError(`Entry ${row}: id is required.`);
    const sourceRow = source.sourceRow == null ? null : Number(source.sourceRow); if (sourceRow != null && (!Number.isInteger(sourceRow) || sourceRow < 0)) throw jsonImportError(`Entry ${row}: sourceRow must be a non-negative integer or null.`);
    const revision = source.revision == null ? 1 : Number(source.revision); if (!Number.isInteger(revision) || revision < 1) throw jsonImportError(`Entry ${row}: revision must be a positive integer.`);
    const entry = normalizeEntry({ ...source, keyword: primaryKeyword }); entry.detailsDocument = normalizeDetailsDocument(entry.detailsDocument); entry.details = plainDetails(entry.detailsDocument, entry.details);
    const errors = validateEntry(entry); if (errors.length) throw jsonImportError(`Entry ${row}: ${errors.join(" ")}`, errors);
    return { entry, keywordNames: [primaryKeyword, ...keywordNames.filter(value => normal(value) !== normal(primaryKeyword))], primaryKeyword, metadata: { id, sourceRow, revision, createdAt: validImportedTimestamp(source.createdAt, "createdAt", `Entry ${row}`), updatedAt: validImportedTimestamp(source.updatedAt, "updatedAt", `Entry ${row}`) } };
  }
  function prepareImportedBooks(value) { if (value == null) return []; if (!Array.isArray(value)) throw jsonImportError("JSON backup books must be an array."); const seen = new Set(); return value.map((source, index) => { const number = clean(source?.number); if (!number) throw jsonImportError(`Book ${index + 1}: number is required.`); const key = normal(number); if (seen.has(key)) throw jsonImportError(`Book ${index + 1}: duplicate book number \"${number}\".`); seen.add(key); const sortOrder = Number(source.sortOrder); if (!Number.isInteger(sortOrder) || sortOrder < 0) throw jsonImportError(`Book ${index + 1}: sortOrder must be a non-negative integer.`); return { number, label: clean(source.label), sortOrder, active: source.active !== false, createdAt: validImportedTimestamp(source.createdAt, "createdAt", `Book ${index + 1}`), updatedAt: validImportedTimestamp(source.updatedAt, "updatedAt", `Book ${index + 1}`) }; }); }
  function prepareImportedKeywords(value) { if (value == null) return []; if (!Array.isArray(value)) throw jsonImportError("JSON backup keywords must be an array."); const keywords = new Map(); value.forEach((source, index) => { const name = clean(source?.name); if (!name) throw jsonImportError(`Keyword ${index + 1}: name is required.`); const key = normal(name), aliases = Array.isArray(source.aliases) ? source.aliases.map(clean).filter(Boolean) : [], existing = keywords.get(key); if (existing) { existing.aliases = [...new Map(existing.aliases.concat(aliases).map(alias => [normal(alias), alias])).values()]; return; } keywords.set(key, { name, aliases: [...new Map(aliases.map(alias => [normal(alias), alias])).values()] }); }); return [...keywords.values()]; }
  function inspectJsonImport(jsonText, { updateExisting = false } = {}) {
    let backup; try { backup = JSON.parse(String(jsonText ?? "")); } catch { throw jsonImportError("File is not valid JSON."); }
    if (!backup || typeof backup !== "object" || Array.isArray(backup)) throw jsonImportError("JSON import must be an Index Studio backup object.");
    if (backup.format !== "index-studio-backup" || backup.version !== 3) throw jsonImportError("Choose a JSON file exported by this version of Index Studio.");
    if (!Array.isArray(backup.entries)) throw jsonImportError("JSON backup entries must be an array.");
    if (backup.entries.length > MAX_JSON_IMPORT_ENTRIES) throw jsonImportError(`JSON backup contains more than ${MAX_JSON_IMPORT_ENTRIES} entries.`);
    const books = prepareImportedBooks(backup.books), keywords = prepareImportedKeywords(backup.keywords), valid = [], invalid = [], seenIds = new Set(), existingIds = new Set(db.prepare("SELECT id FROM entries").all().map(row => row.id)); let duplicateRows = 0, updateRows = 0;
    backup.entries.forEach((source, index) => { try { const item = prepareJsonImportEntry(source, index); if (seenIds.has(item.metadata.id)) { duplicateRows += 1; return; } seenIds.add(item.metadata.id); if (existingIds.has(item.metadata.id)) { if (!updateExisting) { duplicateRows += 1; return; } item.updateExisting = true; updateRows += 1; } valid.push(item); } catch (error) { invalid.push({ row: index + 1, errors: Array.isArray(error.details) ? error.details : [error.message] }); } });
    return { format: "json", headers: [], missingHeaders: [], totalRows: backup.entries.length, validRows: valid.length, duplicateRows, updateRows, invalidRows: invalid.length, invalid: invalid.slice(0, 25), identityCollisionRows: identityCollisionRows(valid.filter(item => !item.updateExisting)), preview: valid.slice(0, 5).map(item => ({ ...item.entry, keywords: item.keywordNames, primaryKeyword: item.primaryKeyword })), valid, books, keywords };
  }
  function importPreparedBooks(books) { let added = 0; for (const book of books) { if (db.prepare("SELECT 1 FROM books WHERE normalized_number=?").get(normal(book.number))) continue; db.prepare("INSERT INTO books(id,number,normalized_number,label,sort_order,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), book.number, normal(book.number), book.label, book.sortOrder, book.active ? 1 : 0, book.createdAt, book.updatedAt); added += 1; } return added; }
  function importPreparedKeywords(keywords) { let aliasesAdded = 0; for (const source of keywords) { const existing = keywordByNormalized(source.name); if (existing && normal(existing.name) !== normal(source.name)) throw jsonImportError(`Keyword \"${source.name}\" conflicts with the existing alias for \"${existing.name}\".`); const target = existing ?? ensureKeywordExact(source.name); for (const alias of source.aliases) { if (normal(alias) === normal(target.name)) continue; const owner = keywordByNormalized(alias); if (owner && owner.id !== target.id) throw jsonImportError(`Alias \"${alias}\" conflicts with \"${owner.name}\".`); if (!owner) { db.prepare("INSERT INTO keyword_aliases(id,keyword_id,alias,normalized_alias,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), target.id, alias, normal(alias), now()); aliasesAdded += 1; } } } return aliasesAdded; }
  function importJson(jsonText, { filename = "import.json", dryRun = true, updateExisting = false } = {}) { const report = inspectJsonImport(jsonText, { updateExisting }); if (report.invalidRows) { const error = jsonImportError(`${report.invalidRows} JSON ${report.invalidRows === 1 ? "entry needs" : "entries need"} correction before import. ${report.invalid.map(item => `Entry ${item.row}: ${item.errors.join(" ")}`).join(" ")}`, publicImportReport(report)); throw error; } if (dryRun) return publicImportReport(report); const backup = backupNow("pre-import"); let importedRows = 0, updatedRows = 0; db.exec("BEGIN IMMEDIATE"); try { const booksAdded = importPreparedBooks(report.books), aliasesAdded = importPreparedKeywords(report.keywords); for (const item of report.valid) { const keywordRows = resolveKeywords(item.keywordNames, item.primaryKeyword); if (item.updateExisting) { const current = getEntry(item.metadata.id); if (!current) throw jsonImportError(`Entry ${item.metadata.id} no longer exists.`); recordRevision(current, "import-update"); db.prepare("UPDATE entries SET keyword=?,concept=?,details=?,details_json=?,book_number=?,page_number=?,tags_json=?,status=?,source_row=?,revision=?,created_at=?,updated_at=? WHERE id=?").run(item.entry.keyword,item.entry.concept,item.entry.details,item.entry.detailsDocument?JSON.stringify(item.entry.detailsDocument):null,item.entry.bookNumber,item.entry.pageNumber,JSON.stringify(item.entry.tags),item.entry.status,item.metadata.sourceRow,item.metadata.revision,item.metadata.createdAt,item.metadata.updatedAt,item.metadata.id); setEntryKeywords(item.metadata.id, keywordRows); updatedRows += 1; } else { insertPrepared(item.entry, keywordRows, item.metadata); importedRows += 1; } } db.prepare("INSERT INTO import_jobs(id,filename,total_rows,imported_rows,skipped_rows,invalid_rows,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), basename(filename), report.totalRows, importedRows + updatedRows, report.duplicateRows, report.invalidRows, now()); db.exec("COMMIT"); return { ...publicImportReport(report, importedRows), updatedRows, booksAdded, aliasesAdded, backup }; } catch (error) { db.exec("ROLLBACK"); throw error; } }
  const exportEntries=()=>decorateEntries(db.prepare("SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY keyword COLLATE NOCASE,concept COLLATE NOCASE").all());
  const exportCsv=()=>stringifyHistoricalCsv(exportEntries());
  const exportJson=()=>JSON.stringify({format:"index-studio-backup",version:3,exportedAt:now(),entries:exportEntries(),books:getBooks(true),keywords:listKeywords(),preferences:getPreferences(),status:getStatus()},null,2);
  const listBackups=()=>db.prepare("SELECT id,filename,total_rows,imported_rows,skipped_rows,invalid_rows,created_at FROM import_jobs ORDER BY created_at DESC LIMIT 20").all().map(row=>({id:row.id,filename:row.filename,totalRows:row.total_rows,importedRows:row.imported_rows,skippedRows:row.skipped_rows,invalidRows:row.invalid_rows,createdAt:row.created_at}));
  if(Number(db.prepare("SELECT COUNT(*) AS count FROM entries").get().count)===0&&seedCsvPath&&existsSync(seedCsvPath))importCsv(readFileSync(seedCsvPath,"utf8"),{filename:basename(seedCsvPath),dryRun:false});
  migrateLegacyKeywordRows();
  db.exec("PRAGMA optimize");
  return {databasePath,listEntries,listRecentEntries,getEntry,createEntry,createEntries,updateEntry,deleteEntry,bulkUpdate,getStatus,getMeta,listNotes,createNote,archiveNote,archiveKeyword,restoreKeyword,createBackup:backupNow,getBackupSettings,updateBackupSettings,runScheduledBackup,listBackupPoints,restoreBackup,listBackups,importCsv,importJson,exportCsv,exportJson,getBooks,createBook,updateBook,getPreferences,clearPreferences,searchKeywords,listKeywords,createKeyword,addKeywordAliases,mergeKeywords,close(){db.exec("PRAGMA optimize");db.close();}};
}
