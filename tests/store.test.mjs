import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createStore } from "../server/store.mjs";
import { createProfileManager } from "../server/profiles.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sec401-index-test-"));
  const store = createStore({
    dataDir: join(root, "data"),
    backupDir: join(root, "backups"),
    seedCsvPath: fileURLToPath(new URL("./fixtures/sample.csv", import.meta.url)),
  });
  return { root, store };
}

function emptyFixture() {
  const root = mkdtempSync(join(tmpdir(), "index-json-import-test-"));
  const store = createStore({
    dataDir: join(root, "data"),
    backupDir: join(root, "backups"),
  });
  return { root, store };
}

test("synthetic CSV fixture imports without private data", () => {
  const { root, store } = fixture();
  try {
    const status = store.getStatus();
    assert.equal(status.total, 3);
    assert.equal(status.keywords, 3);
    assert.equal(status.sources, 2);
    assert.equal(status.collisionExtraRows, 0);
    assert.equal(store.listEntries({ limit: 2500 }).items.length, 3);
    const ipsec = store.listEntries({ limit: 2500 }).items.find((entry) => entry.concept === "Example one");
    assert.deepEqual(ipsec?.keywords, ["alpha"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("create, revision-safe update, and soft delete work", () => {
  const { root, store } = fixture();
  try {
    const created = store.createEntry({ keyword: "test", concept: "Test entry", details: "Notes", bookNumber: "401.1", pageNumber: "1", tags: ["sample"], status: "draft" });
    assert.equal(created.revision, 1);
    const updated = store.updateEntry(created.id, { ...created, concept: "Updated test", revision: 1 });
    assert.equal(updated.revision, 2);
    assert.throws(() => store.updateEntry(created.id, { ...updated, revision: 1 }), /changed after it was opened/);
    assert.equal(store.deleteEntry(created.id), true);
    assert.equal(store.getEntry(created.id), null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("notes are newest-first and archive without deleting their history", () => {
  const { root, store } = emptyFixture();
  try {
    const first = store.createNote({ body: "First reminder\nwith another line" });
    const second = store.createNote({ body: "Newest reminder" });
    assert.deepEqual(store.listNotes().map((note) => note.id), [second.id, first.id]);
    assert.equal(first.body, "First reminder\nwith another line");
    const archived = store.archiveNote(second.id);
    assert.ok(archived.archivedAt);
    assert.deepEqual(store.listNotes().map((note) => note.id), [first.id]);
    assert.deepEqual(store.listNotes(true).map((note) => note.id), [second.id, first.id]);
    assert.equal(store.archiveNote(second.id), null);
    assert.throws(() => store.createNote({ body: "   " }), /Write something/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("archived keywords leave active data and JSON exports clean, then restore their memberships", () => {
  const { root, store } = emptyFixture();
  try {
    const first = store.createEntry({ keywords: ["obsolete", "keep"], primaryKeyword: "obsolete", concept: "First keyword record", details: "", bookNumber: "401.1", pageNumber: "1", tags: [] });
    const second = store.createEntry({ keywords: ["obsolete", "keep"], primaryKeyword: "keep", concept: "Second keyword record", details: "", bookNumber: "401.1", pageNumber: "2", tags: [] });
    const obsolete = store.listKeywords().find((keyword) => keyword.name === "obsolete");
    assert.ok(obsolete);
    const archived = store.archiveKeyword(obsolete.id);
    assert.equal(archived.removedFrom, 2);
    assert.deepEqual(store.getEntry(first.id).keywords, ["keep"]);
    assert.deepEqual(store.getEntry(second.id).keywords, ["keep"]);
    assert.ok(!store.exportJson().includes("obsolete"));
    const archiveFile = join(root, "data", "index-archived.json");
    assert.ok(existsSync(archiveFile));
    assert.equal(JSON.parse(readFileSync(archiveFile, "utf8")).keywords[0].name, "obsolete");
    assert.equal(store.listKeywords(true).find((keyword) => keyword.name === "obsolete")?.archived, true);
    const restored = store.restoreKeyword("obsolete");
    assert.equal(restored.restoredTo, 2);
    assert.deepEqual(store.getEntry(first.id).keywords, ["obsolete", "keep"]);
    assert.deepEqual(store.getEntry(second.id).keywords, ["keep", "obsolete"]);
    assert.equal(JSON.parse(readFileSync(archiveFile, "utf8")).keywords.length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("archiving a sole keyword assigns placeholder until it is restored", () => {
  const { root, store } = emptyFixture();
  try {
    const entry = store.createEntry({ keyword: "retire-me", concept: "Sole keyword record", details: "", bookNumber: "401.1", pageNumber: "1", tags: [] });
    const keyword = store.listKeywords().find((item) => item.name === "retire-me");
    store.archiveKeyword(keyword.id);
    assert.deepEqual(store.getEntry(entry.id).keywords, ["placeholder"]);
    store.restoreKeyword("retire-me");
    assert.deepEqual(store.getEntry(entry.id).keywords, ["retire-me"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("archiving a merged keyword clears its historical merge references", () => {
  const { root, store } = emptyFixture();
  try {
    store.createEntry({ keywords: ["merge target", "merge source"], concept: "Merged keyword record", details: "", bookNumber: "401.1", pageNumber: "1", tags: [] });
    const keywords = store.listKeywords();
    const target = keywords.find((item) => item.name === "merge target");
    const source = keywords.find((item) => item.name === "merge source");
    store.mergeKeywords({ sourceIds: [target.id, source.id], primaryId: target.id });
    assert.doesNotThrow(() => store.archiveKeyword(target.id));
    assert.ok(!store.listKeywords().some((item) => item.name === "merge target"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch creation is atomic and recent entries can be filtered by keyword", () => {
  const { root, store } = fixture();
  try {
    const before = store.getStatus().total;
    const result = store.createEntries({
      entries: [
        { keyword: "batch-shared", concept: "Batch first", details: "First batch entry.", bookNumber: "401.1", pageNumber: "301", tags: [] },
        { keyword: "batch-other", concept: "Batch middle", details: "Middle batch entry.", bookNumber: "401.1", pageNumber: "302", tags: [] },
        { keywords: ["batch-shared", "batch-extra"], primaryKeyword: "batch-extra", concept: "Batch last", details: "Last batch entry.", bookNumber: "401.1", pageNumber: "303", tags: [] },
      ],
    });

    assert.equal(result.created, 3);
    assert.deepEqual(result.items.map((entry) => entry.concept), ["Batch first", "Batch middle", "Batch last"]);
    assert.equal(store.getStatus().total, before + 3);

    const recent = store.listRecentEntries({ limit: 1, keyword: "batch-shared" });
    assert.equal(recent.total, 2);
    assert.equal(recent.limit, 1);
    assert.equal(recent.items[0].concept, "Batch last");

    assert.throws(() => store.createEntries([
      { keyword: "batch-rollback", concept: "Should roll back", details: "Valid first item.", bookNumber: "401.1", pageNumber: "304", tags: [] },
      { keyword: "batch-rollback", concept: "", details: "Invalid second item.", bookNumber: "401.1", pageNumber: "305", tags: [] },
    ]), /Entry 2:/);
    assert.equal(store.getStatus().total, before + 3);
    assert.equal(store.listEntries({ keyword: "batch-rollback", limit: 10 }).total, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeat CSV import is a dry-run-safe no-op", () => {
  const { root, store } = fixture();
  try {
    const csv = store.exportCsv();
    const report = store.importCsv(csv, { filename: "repeat.csv", dryRun: true });
    assert.equal(report.totalRows, 3);
    assert.equal(report.validRows, 0);
    assert.equal(report.duplicateRows, 3);
    assert.equal(store.getStatus().total, 3);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a complete JSON export merges without replacing existing entries and preserves metadata", () => {
  const source = fixture();
  const target = emptyFixture();
  try {
    const existing = target.store.createEntry({
      keyword: "target-only",
      concept: "Existing target entry",
      details: "This entry must survive a JSON merge.",
      bookNumber: "275.1",
      pageNumber: "1",
      tags: [],
    });
    const added = source.store.createEntry({
      keywords: ["json-import-primary", "json-import-secondary"],
      primaryKeyword: "json-import-primary",
      concept: "JSON import round trip",
      details: "This entry verifies export-compatible JSON import.",
      bookNumber: "401.1",
      pageNumber: "401",
      tags: ["round-trip"],
      status: "final",
    });
    const backup = source.store.exportJson();
    const sourceTotal = source.store.getStatus().total;

    const preview = target.store.importJson(backup, { filename: "source-backup.json", dryRun: true });
    assert.equal(preview.format, "json");
    assert.equal(preview.totalRows, sourceTotal);
    assert.equal(preview.validRows, sourceTotal);
    assert.equal(preview.duplicateRows, 0);

    const imported = target.store.importJson(backup, { filename: "source-backup.json", dryRun: false });
    assert.equal(imported.importedRows, sourceTotal);
    assert.equal(target.store.getStatus().total, sourceTotal + 1);
    assert.deepEqual(target.store.getEntry(existing.id), existing);
    assert.deepEqual(target.store.getEntry(added.id), added);
    assert.ok(target.store.getBooks(true).some((book) => book.number === "401.1"));
    assert.ok(target.store.listKeywords().find((keyword) => keyword.name === "json-import-primary"));

    const repeated = target.store.importJson(backup, { filename: "source-backup.json", dryRun: true });
    assert.equal(repeated.validRows, 0);
    assert.equal(repeated.duplicateRows, sourceTotal);
    assert.throws(() => target.store.importJson("{\"format\":\"other\"}"), /exported by this version/);
  } finally {
    source.store.close();
    target.store.close();
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target.root, { recursive: true, force: true });
  }
});

test("JSON import reports the invalid entry and field without writing changes", () => {
  const { root, store } = emptyFixture();
  try {
    const entry = store.createEntry({ keyword: "filesystem", concept: "File System Enumeration", bookNumber: "275.3", pageNumber: "Unknown (Q132)" });
    const backup = JSON.parse(store.exportJson());
    backup.entries[0].pageNumber = "";
    for (const dryRun of [true, false]) {
      assert.throws(() => store.importJson(JSON.stringify(backup), { dryRun, updateExisting: true }), (error) => {
        assert.equal(error.statusCode, 422);
        assert.match(error.message, /1 JSON entry needs correction before import\. Entry 1: Page Number is required\./);
        assert.deepEqual(error.details.invalid, [{ row: 1, errors: ["Page Number is required."] }]);
        return true;
      });
      assert.equal(store.getEntry(entry.id).pageNumber, "Unknown (Q132)");
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("JSON import can opt in to updating matching backup IDs", () => {
  const { root, store } = emptyFixture();
  try {
    const entry = store.createEntry({ keyword: "original", concept: "Original concept", details: "Original details", bookNumber: "401.1", pageNumber: "1", tags: ["old"], status: "draft" });
    const backup = JSON.parse(store.exportJson());
    backup.entries[0] = { ...backup.entries[0], keywords: ["changed", "new keyword"], primaryKeyword: "changed", keyword: "changed", concept: "Updated concept", details: "Updated details", tags: ["new"], status: "final", revision: 7, updatedAt: new Date().toISOString() };
    const unchanged = store.importJson(JSON.stringify(backup), { dryRun: true });
    assert.equal(unchanged.validRows, 0);
    const preview = store.importJson(JSON.stringify(backup), { dryRun: true, updateExisting: true });
    assert.equal(preview.validRows, 1);
    assert.equal(preview.updatedRows, 1);
    const imported = store.importJson(JSON.stringify(backup), { dryRun: false, updateExisting: true });
    assert.equal(imported.importedRows, 0);
    assert.equal(imported.updatedRows, 1);
    const updated = store.getEntry(entry.id);
    assert.equal(updated.concept, "Updated concept");
    assert.equal(updated.details, "Updated details");
    assert.deepEqual(updated.tags, ["new"]);
    assert.deepEqual(updated.keywords, ["changed", "new keyword"]);
    assert.equal(updated.status, "final");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("form workflow stores recent values, multiple keywords, and merge aliases", () => {
  const { root, store } = fixture();
  try {
    const [book] = store.getBooks();
    const created = store.createEntry({
      keyword: "workflow-beta",
      keywords: ["workflow-alpha", "workflow-beta"],
      primaryKeyword: "workflow-beta",
      concept: "Workflow form record",
      details: "Created by the form workflow test.",
      bookNumber: book.number,
      pageNumber: "99",
      tags: [],
      status: "draft",
    });
    assert.deepEqual(created.keywords, ["workflow-beta", "workflow-alpha"]);
    assert.equal(store.listEntries({ q: "Workflow form record", limit: 10 }).total, 1);
    assert.equal(store.getPreferences().lastPageNumber, "99");
    const selected = store.listKeywords().filter((item) => item.name.startsWith("workflow-"));
    const beta = selected.find((item) => item.name === "workflow-beta");
    assert.ok(beta);
    const result = store.mergeKeywords({ sourceIds: selected.map((item) => item.id), primaryId: beta.id });
    assert.equal(result.merged, 1);
    const merged = store.getEntry(created.id);
    assert.deepEqual(merged.keywords, ["workflow-beta"]);
    assert.ok(result.target.aliases.includes("workflow-alpha"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual aliases resolve to their primary keyword", () => {
  const { root, store } = fixture();
  try {
    const primary = store.createKeyword({ name: "manual-alias-primary" });
    const result = store.addKeywordAliases(primary.id, { aliases: ["manual alias", "manual-alt"] });
    assert.equal(result.added, 2);
    assert.deepEqual(result.target.aliases, ["manual alias", "manual-alt"]);
    const created = store.createEntry({ keywords: ["manual alias"], concept: "Manual alias record", details: "Alias entry.", bookNumber: "401.1", pageNumber: "100", tags: [] });
    assert.equal(created.primaryKeyword, "manual-alias-primary");
    assert.throws(() => store.addKeywordAliases(primary.id, { aliases: ["manual alias"] }), /already an alias/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic backup settings are persisted and validated", () => {
  const { root, store } = fixture();
  try {
    assert.deepEqual(store.getBackupSettings(), { intervalMinutes: 1440, maxBackups: 14, lastBackupAt: null });
    const saved = store.updateBackupSettings({ intervalMinutes: 360, maxBackups: 7 });
    assert.equal(saved.intervalMinutes, 360);
    assert.equal(saved.maxBackups, 7);
    assert.deepEqual(store.getBackupSettings(), saved);
    assert.throws(() => store.updateBackupSettings({ intervalMinutes: -1, maxBackups: 7 }), /valid automatic backup interval/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("comma-separated keyword input ignores whitespace after commas", () => {
  const createWithKeywords = (keywords) => {
    const { root, store } = fixture();
    try {
      const before = store.getStatus().total;
      const created = store.createEntry({
        keywords,
        concept: "Comma whitespace regression record",
        details: "The keyword separators should not create extra entries.",
        bookNumber: "401.1",
        pageNumber: "101",
        tags: [],
        status: "draft",
      });
      assert.equal(store.getStatus().total, before + 1);
      assert.equal(store.listEntries({ q: "Comma whitespace regression record", limit: 10 }).total, 1);
      return created.keywords;
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };

  const withoutSpaces = createWithKeywords("whitespace-alpha,whitespace-beta");
  const withSpaces = createWithKeywords("whitespace-alpha, whitespace-beta");
  assert.deepEqual(withSpaces, withoutSpaces);
  assert.deepEqual(withSpaces, ["whitespace-alpha", "whitespace-beta"]);
});

test("profiles isolate class data, default the display name, clone, star, and archive safely", () => {
  const root = mkdtempSync(join(tmpdir(), "index-profiles-test-"));
  const manager = createProfileManager({
    dataDir: join(root, "data"),
    seedCsvPath: fileURLToPath(new URL("./fixtures/sample.csv", import.meta.url)),
    createStore,
  });
  try {
    const [sec401] = manager.list();
    assert.equal(sec401.displayName, "My Index");
    assert.equal(manager.getStore(sec401.id).getStatus().total, 0);
    manager.getStore(sec401.id).importCsv(readFileSync(new URL("./fixtures/sample.csv", import.meta.url), "utf8"), { dryRun: false });
    assert.equal(manager.getStore(sec401.id).getStatus().total, 3);

    const sec504 = manager.create({ code: "sec504" });
    assert.equal(sec504.code, "SEC504");
    assert.equal(sec504.displayName, "SEC504");
    assert.equal(manager.getStore(sec504.id).getStatus().total, 0);
    manager.getStore(sec504.id).createEntry({ keyword: "isolated", concept: "Only in 504", bookNumber: "504.1", pageNumber: "1", details: "", tags: [] });
    assert.equal(manager.getStore(sec504.id).getStatus().total, 1);
    assert.equal(manager.getStore(sec401.id).getStatus().total, 3);
    manager.getStore(sec504.id).createNote({ body: "Only in the SEC504 profile" });
    assert.equal(manager.getStore(sec504.id).listNotes().length, 1);
    assert.equal(manager.getStore(sec401.id).listNotes().length, 0);

    const cloned = manager.create({ code: "sec503", cloneFromId: sec401.id });
    assert.equal(manager.getStore(cloned.id).getStatus().total, 3);
    assert.equal(manager.update(cloned.id, { starred: true }).starred, true);
    manager.activate(sec504.id);
    assert.throws(() => manager.update(sec504.id, { archived: true }), /Switch to another profile/);
    assert.equal(manager.update(cloned.id, { archived: true }).archived, true);
    assert.equal(manager.update(cloned.id, { archived: false }).archived, false);
  } finally {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rich additional details preserve pasted images and derive searchable plain text", () => {
  const { root, store } = fixture();
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  try {
    const detailsDocument = {
      version: 1,
      nodes: [
        { type: "text", text: "Before image\n" },
        { type: "image", dataUrl, naturalWidth: 1, naturalHeight: 1, lines: 5 },
        { type: "text", text: "After image" },
      ],
    };
    const created = store.createEntry({ keyword: "rich-details", concept: "Pasted screenshot", details: "stale text", detailsDocument, bookNumber: "401.1", pageNumber: "200", tags: [] });
    assert.equal(created.details, "Before image\nAfter image");
    assert.deepEqual(created.detailsDocument, detailsDocument);
    assert.equal(store.listEntries({ q: "After image", limit: 10 }).total, 1);
    assert.match(store.exportCsv(), /Before image\nAfter image/);
    const json = JSON.parse(store.exportJson());
    assert.equal(json.version, 3);
    assert.equal(json.entries.find((entry) => entry.id === created.id).detailsDocument.nodes[1].lines, 5);
    const customSized = store.updateEntry(created.id, { ...created, detailsDocument: { ...detailsDocument, nodes: [{ ...detailsDocument.nodes[1], lines: 42 }] } });
    assert.equal(customSized.detailsDocument.nodes[0].lines, 42);
    assert.throws(() => store.updateEntry(created.id, { ...customSized, detailsDocument: { ...detailsDocument, nodes: [{ ...detailsDocument.nodes[1], lines: 51 }] } }), /invalid image/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
