import { randomBytes } from "node:crypto";
import { configuredPort, defaultDataDir } from "./runtime.mjs";
import { authenticated, requestAllowed, securityHeaders } from "./security.mjs";
import { spawn } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.mjs";
import { createProfileManager } from "./profiles.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args[0] : "serve";
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
process.umask(0o077);
const port = configuredPort(option("--port", process.env.INDEX_APP_PORT ?? "4010"));
const host = "127.0.0.1";
const dataDir = resolve(option("--data-dir", defaultDataDir()));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const exportDir = join(dataDir, "exports");

const profiles = createProfileManager({ dataDir, createStore });
const requestedCliProfile = option("--profile", profiles.activeProfileId);
const cliProfile = profiles.resolve(requestedCliProfile);
const store = profiles.getStore(cliProfile.id);
const pidPath = join(dataDir, "server.pid");

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

if (command !== "serve") {
  try {
    if (command === "import") {
      const filename = args[1];
      if (!filename) throw new Error("Usage: node server/index.mjs import <file.csv|file.json> [--commit]");
      const contents = readFileSync(resolve(filename), "utf8");
      const importFile = extname(filename).toLowerCase() === ".json" ? store.importJson : store.importCsv;
      print(importFile(contents, {
        filename,
        dryRun: !args.includes("--commit"),
      }));
    } else if (command === "add") {
      const filename = option("--json", args[1]);
      if (!filename) throw new Error("Usage: node server/index.mjs add --json <entry.json>");
      print(store.createEntry(JSON.parse(readFileSync(resolve(filename), "utf8"))));
    } else if (command === "export") {
      const format = option("--format", "csv");
      const filename = option("--out", join(exportDir, `index-export.${format}`));
      mkdirSync(exportDir, { recursive: true, mode: 0o700 });
      writeFileSync(resolve(filename), format === "json" ? store.exportJson() : store.exportCsv());
      print({ exported: resolve(filename), format });
    } else if (command === "backup") {
      print(store.createBackup("cli"));
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
    profiles.close();
    process.exit(0);
  } catch (error) {
    profiles.close();
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

const baseUrl = `http://${host}:${port}`;

function openBrowser(url) {
  const [program, browserArgs] = process.platform === "win32"
    ? ["cmd.exe", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  const child = spawn(program, browserArgs, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  // A missing desktop opener must not bring down the local server (for example,
  // when it is started over SSH or as a headless service).
  child.on("error", () => {});
  child.unref();
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function text(res, status, body, contentType, headers = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

async function bodyText(req, limit = 30_000_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function bodyJson(req) {
  if (req.parsedBody !== undefined) return req.parsedBody;
  const type = String(req.headers["content-type"] ?? "");
  if (type.split(";")[0].trim().toLowerCase() !== "application/json") {
    const error = new Error("Write requests must use application/json.");
    error.statusCode = 415;
    throw error;
  }
  const raw = await bodyText(req);
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    req.parsedBody = parsed;
    return parsed;
  } catch { const error = new Error("Body must be a valid JSON object."); error.statusCode = 400; throw error; }
}

function mimeType(pathname) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
  }[extname(pathname)] ?? "application/octet-stream";
}

async function handleApi(req, res, url) {
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/api/v1/profiles") {
    return json(res, 200, { items: profiles.list(), activeProfileId: profiles.activeProfileId });
  }
  if (method === "POST" && path === "/api/v1/profiles") return json(res, 201, profiles.create(await bodyJson(req)));
  const profileActivateMatch = path.match(/^\/api\/v1\/profiles\/([^/]+)\/activate$/);
  if (profileActivateMatch && method === "POST") return json(res, 200, profiles.activate(decodeURIComponent(profileActivateMatch[1])));
  const profileMatch = path.match(/^\/api\/v1\/profiles\/([^/]+)$/);
  if (profileMatch && method === "PATCH") return json(res, 200, profiles.update(decodeURIComponent(profileMatch[1]), await bodyJson(req)));

  const profile = profiles.resolve(req.headers["x-index-profile"] ?? url.searchParams.get("profile"));
  const profileStore = profiles.getStore(profile.id);

  if (method === "GET" && path === "/api/v1/health") {
    return json(res, 200, {
      ok: true,
      app: "Index Studio",
      version: "1.0.0",
      url: baseUrl,
      dataPath: profileStore.databasePath,
      offline: true,
      profile,
    });
  }
  if (method === "GET" && path === "/api/v1/status") return json(res, 200, profileStore.getStatus());
  if (method === "GET" && path === "/api/v1/meta") return json(res, 200, profileStore.getMeta());
  if (method === "GET" && path === "/api/v1/notes") return json(res, 200, { items: profileStore.listNotes(url.searchParams.get("includeArchived") === "true") });
  if (method === "POST" && path === "/api/v1/notes") return json(res, 201, profileStore.createNote(await bodyJson(req)));
  const noteArchiveMatch = path.match(/^\/api\/v1\/notes\/([^/]+)\/archive$/);
  if (noteArchiveMatch && method === "POST") {
    const note = profileStore.archiveNote(decodeURIComponent(noteArchiveMatch[1]));
    return note ? json(res, 200, note) : json(res, 404, { error: "Note not found." });
  }
  const keywordArchiveMatch = path.match(/^\/api\/v1\/keywords\/([^/]+)\/archive$/);
  if (keywordArchiveMatch && method === "POST") return json(res, 200, profileStore.archiveKeyword(decodeURIComponent(keywordArchiveMatch[1])));
  const keywordRestoreMatch = path.match(/^\/api\/v1\/keywords\/([^/]+)\/restore$/);
  if (keywordRestoreMatch && method === "POST") return json(res, 200, profileStore.restoreKeyword(decodeURIComponent(keywordRestoreMatch[1])));
  if (method === "GET" && path === "/api/v1/settings/books") return json(res, 200, { items: profileStore.getBooks(url.searchParams.get("includeArchived") === "true") });
  if (method === "POST" && path === "/api/v1/settings/books") return json(res, 201, profileStore.createBook(await bodyJson(req)));
  const bookMatch = path.match(/^\/api\/v1\/settings\/books\/([^/]+)$/);
  if (bookMatch && method === "PATCH") return json(res, 200, profileStore.updateBook(decodeURIComponent(bookMatch[1]), await bodyJson(req)));
  if (method === "GET" && path === "/api/v1/settings/preferences") return json(res, 200, profileStore.getPreferences());
  if (method === "POST" && path === "/api/v1/settings/preferences/clear") return json(res, 200, profileStore.clearPreferences());
  if (method === "GET" && path === "/api/v1/settings/backups") return json(res, 200, profileStore.getBackupSettings());
  if (method === "POST" && path === "/api/v1/settings/backups") return json(res, 200, profileStore.updateBackupSettings(await bodyJson(req)));
  if (method === "GET" && path === "/api/v1/keywords") return json(res, 200, { items: url.searchParams.has("q") ? profileStore.searchKeywords(url.searchParams.get("q") ?? "") : profileStore.listKeywords(url.searchParams.get("includeArchived") === "true") });
  if (method === "POST" && path === "/api/v1/keywords") return json(res, 201, profileStore.createKeyword(await bodyJson(req)));
  if (method === "POST" && path === "/api/v1/keywords/merge") return json(res, 200, profileStore.mergeKeywords(await bodyJson(req)));
  const keywordAliasMatch = path.match(/^\/api\/v1\/keywords\/([^/]+)\/aliases$/);
  if (keywordAliasMatch && method === "POST") return json(res, 200, profileStore.addKeywordAliases(decodeURIComponent(keywordAliasMatch[1]), await bodyJson(req)));
  if (method === "GET" && path === "/api/v1/entries") {
    return json(res, 200, profileStore.listEntries({
      q: url.searchParams.get("q") ?? "",
      keyword: url.searchParams.get("keyword") ?? "",
      bookNumber: url.searchParams.get("bookNumber") ?? "",
      status: url.searchParams.get("status") ?? "",
      sort: url.searchParams.get("sort") ?? "keyword",
      direction: url.searchParams.get("direction") ?? "asc",
      limit: url.searchParams.get("limit") ?? 100,
      offset: url.searchParams.get("offset") ?? 0,
    }));
  }
  if (method === "GET" && path === "/api/v1/entries/recent") {
    return json(res, 200, profileStore.listRecentEntries({
      limit: url.searchParams.get("limit") ?? 10,
      keyword: url.searchParams.get("keyword") ?? "",
    }));
  }
  if (method === "POST" && path === "/api/v1/entries") return json(res, 201, profileStore.createEntry(await bodyJson(req)));
  if (method === "POST" && path === "/api/v1/entries/batch") return json(res, 201, profileStore.createEntries(await bodyJson(req)));
  if (method === "POST" && path === "/api/v1/entries/bulk") return json(res, 200, profileStore.bulkUpdate(await bodyJson(req)));
  const entryMatch = path.match(/^\/api\/v1\/entries\/([^/]+)$/);
  if (entryMatch && method === "GET") {
    const entry = profileStore.getEntry(decodeURIComponent(entryMatch[1]));
    return entry ? json(res, 200, entry) : json(res, 404, { error: "Entry not found." });
  }
  if (entryMatch && method === "PATCH") return json(res, 200, profileStore.updateEntry(decodeURIComponent(entryMatch[1]), await bodyJson(req)));
  if (entryMatch && method === "DELETE") return json(res, profileStore.deleteEntry(decodeURIComponent(entryMatch[1])) ? 200 : 404, { deleted: true });
  if (method === "POST" && path === "/api/v1/imports/csv") {
    const payload = await bodyJson(req);
    return json(res, 200, profileStore.importCsv(payload.csv ?? "", {
      filename: payload.filename ?? "import.csv",
      dryRun: payload.dryRun !== false,
    }));
  }
  if (method === "POST" && path === "/api/v1/imports/json") {
    const payload = await bodyJson(req);
    return json(res, 200, profileStore.importJson(payload.json ?? "", {
      filename: payload.filename ?? "import.json",
      dryRun: payload.dryRun !== false,
      updateExisting: payload.updateExisting === true,
    }));
  }
  if (method === "POST" && path === "/api/v1/backups") {
    const payload = await bodyJson(req);
    return json(res, 201, profileStore.createBackup(payload.label ?? "manual"));
  }
  if (method === "GET" && path === "/api/v1/backups") return json(res, 200, { items: profileStore.listBackupPoints() });
  if (method === "POST" && path === "/api/v1/backups/restore") {
    const payload = await bodyJson(req);
    const result = profileStore.restoreBackup(payload.filename);
    profiles.replaceStore(profile.id, { alreadyClosed: true });
    return json(res, 200, result);
  }
  if (method === "GET" && path === "/api/v1/imports") return json(res, 200, { items: profileStore.listBackups() });
  if (method === "GET" && path === "/api/v1/exports/csv") {
    return text(res, 200, profileStore.exportCsv(), "text/csv; charset=utf-8", {
      "Content-Disposition": `attachment; filename="${profile.code.toLowerCase()}-index.csv"`,
    });
  }
  if (method === "GET" && path === "/api/v1/exports/json") {
    return text(res, 200, profileStore.exportJson(), "application/json; charset=utf-8", {
      "Content-Disposition": `attachment; filename="${profile.code.toLowerCase()}-index-backup.json"`,
    });
  }
  return json(res, 404, { error: "API route not found." });
}

const staticRoot = resolve(rootDir, "dist");
if (!existsSync(join(staticRoot, "index.html"))) {
  profiles.close();
  throw new Error("Build the app first with npm run build, or use a release archive.");
}
const token = randomBytes(32).toString("hex");
const tokenPath = join(dataDir, `shutdown-token-${port}.txt`);
const server = createServer(async (req, res) => {
  for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
  try {
    if (!requestAllowed(req, baseUrl)) return json(res, 403, { error: "Request origin is not allowed." });
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) return json(res, 400, { error: "Invalid request target." });
    const url = new URL(req.url, baseUrl);
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/v1/control" && req.method === "GET") {
        return authenticated(req, token) ? json(res, 200, { ok: true }) : json(res, 401, { error: "Private launcher control." });
      }
      if (!["GET", "HEAD"].includes(req.method)) await bodyJson(req);
      if (url.pathname === "/api/v1/shutdown" && req.method === "POST") {
        if (!authenticated(req, token)) return json(res, 401, { error: "The private shutdown token is required." });
        json(res, 200, { stopped: true });
        setImmediate(shutdown);
        return;
      }
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "Method not allowed." });
    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    let filePath = resolve(staticRoot, requested);
    if (!filePath.startsWith(staticRoot + sep) && filePath !== join(staticRoot, "index.html")) {
      return text(res, 403, "Forbidden", "text/plain; charset=utf-8");
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(staticRoot, "index.html");
    const realPath = realpathSync(filePath);
    if (!realPath.startsWith(realpathSync(staticRoot) + sep)) return json(res, 403, { error: "Forbidden." });
    const body = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": mimeType(filePath),
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (error) {
    const status = Number(error.statusCode) || (error instanceof URIError ? 400 : 500);
    if (status === 500) process.stderr.write(`${error.stack}\n`);
    json(res, status, {
      error: status === 500 ? "Unexpected server error. See the local server log." : error.message,
      details: error.details ?? undefined,
    });
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.maxHeadersCount = 100;
server.on("error", (error) => {
  profiles.close();
  process.stderr.write(`Could not start Index Studio: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  writeFileSync(pidPath, `${process.pid}\n`);
  print(`Index Studio is running at ${baseUrl}`);
  print(`Data: ${profiles.getStore(profiles.activeProfileId).databasePath}`);
  if (!args.includes("--no-open")) openBrowser(baseUrl);
});

const scheduledBackupTimer = setInterval(() => {
  try { profiles.runScheduledBackups(); } catch (error) { process.stderr.write(`Automatic backup failed: ${error.message}\n`); }
}, 60_000);
scheduledBackupTimer.unref();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(scheduledBackupTimer);
  server.close(() => {
    profiles.close();
    try {
      unlinkSync(tokenPath);
      unlinkSync(pidPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
