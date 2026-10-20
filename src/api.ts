import type {
  DashboardStatus,
  Entry,
  EntryInput,
  Health,
  ImportJob,
  ImportReport,
  Book,
  Keyword,
  Meta,
  Note,
  Preferences,
  Profile,
  ProfileInput,
} from "./types";

let activeProfileId = "";

export function setApiProfile(id: string) {
  activeProfileId = id;
}

function profileQuery(path: string) {
  if (!activeProfileId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}profile=${encodeURIComponent(activeProfileId)}`;
}

async function request<T>(path: string, init?: RequestInit, profileScoped = true): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(profileScoped && activeProfileId ? { "X-Index-Profile": activeProfileId } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload as T;
}

export const api = {
  profiles: () => request<{ items: Profile[]; activeProfileId: string }>("/api/v1/profiles", undefined, false),
  createProfile: (payload: ProfileInput) => request<Profile>("/api/v1/profiles", { method: "POST", body: JSON.stringify(payload) }, false),
  updateProfile: (id: string, payload: Partial<Omit<Profile, "id" | "createdAt" | "updatedAt">>) => request<Profile>(`/api/v1/profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }, false),
  activateProfile: (id: string) => request<Profile>(`/api/v1/profiles/${encodeURIComponent(id)}/activate`, { method: "POST", body: "{}" }, false),
  health: () => request<Health>("/api/v1/health"),
  status: () => request<DashboardStatus>("/api/v1/status"),
  meta: () => request<Meta>("/api/v1/meta"),
  notes: (includeArchived = false) => request<{ items: Note[] }>(`/api/v1/notes${includeArchived ? "?includeArchived=true" : ""}`),
  createNote: (body: string) => request<Note>("/api/v1/notes", { method: "POST", body: JSON.stringify({ body }) }),
  archiveNote: (id: string) => request<Note>(`/api/v1/notes/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
  books: (includeArchived = false) => request<{ items: Book[] }>(`/api/v1/settings/books${includeArchived ? "?includeArchived=true" : ""}`),
  createBook: (payload: { number: string; label?: string }) => request<Book>("/api/v1/settings/books", { method: "POST", body: JSON.stringify(payload) }),
  updateBook: (id: string, payload: Partial<Pick<Book, "number" | "label" | "sortOrder" | "active">>) => request<Book>(`/api/v1/settings/books/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  preferences: () => request<Preferences>("/api/v1/settings/preferences"),
  clearPreferences: () => request<Preferences>("/api/v1/settings/preferences/clear", { method: "POST", body: "{}" }),
  backupSettings: () => request<import("./types").BackupSettings>("/api/v1/settings/backups"),
  updateBackupSettings: (payload: Pick<import("./types").BackupSettings, "intervalMinutes" | "maxBackups">) => request<import("./types").BackupSettings>("/api/v1/settings/backups", { method: "POST", body: JSON.stringify(payload) }),
  keywords: (query?: string, includeArchived = false) => request<{ items: Keyword[] }>(`/api/v1/keywords${query == null ? (includeArchived ? "?includeArchived=true" : "") : `?q=${encodeURIComponent(query)}`}`),
  archiveKeyword: (id: string) => request<{ name: string; removedFrom: number; archivedAt: string }>(`/api/v1/keywords/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
  restoreKeyword: (name: string) => request<{ name: string; restoredTo: number }>(`/api/v1/keywords/${encodeURIComponent(name)}/restore`, { method: "POST", body: "{}" }),
  createKeyword: (name: string) => request<Keyword>("/api/v1/keywords", { method: "POST", body: JSON.stringify({ name }) }),
  addKeywordAliases: (id: string, aliases: string[]) => request<{ target: Keyword; added: number }>(`/api/v1/keywords/${encodeURIComponent(id)}/aliases`, { method: "POST", body: JSON.stringify({ aliases }) }),
  mergeKeywords: (sourceIds: string[], primaryId: string) => request<{ target: Keyword; merged: number; backup: { filename: string } }>("/api/v1/keywords/merge", { method: "POST", body: JSON.stringify({ sourceIds, primaryId }) }),
  entries: () => request<{ items: Entry[]; total: number }>("/api/v1/entries?limit=2500&sort=keyword"),
  recentEntries: (limit = 10, keyword = "") =>
    request<{ items: Entry[]; total: number; limit: number; offset: number }>(`/api/v1/entries/recent?limit=${encodeURIComponent(limit)}${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ""}`),
  createEntry: (entry: EntryInput) =>
    request<Entry>("/api/v1/entries", { method: "POST", body: JSON.stringify(entry) }),
  createEntries: (entries: EntryInput[]) =>
    request<{ items: Entry[]; created: number }>("/api/v1/entries/batch", { method: "POST", body: JSON.stringify({ entries }) }),
  updateEntry: (id: string, entry: EntryInput) =>
    request<Entry>(`/api/v1/entries/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(entry),
    }),
  deleteEntry: (id: string) =>
    request<{ deleted: boolean }>(`/api/v1/entries/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" }),
  inspectImport: (csv: string, filename: string, dryRun = true) =>
    request<ImportReport>("/api/v1/imports/csv", {
      method: "POST",
      body: JSON.stringify({ csv, filename, dryRun }),
    }),
  inspectJsonImport: (json: string, filename: string, dryRun = true, updateExisting = false) =>
    request<ImportReport>("/api/v1/imports/json", {
      method: "POST",
      body: JSON.stringify({ json, filename, dryRun, updateExisting }),
    }),
  createBackup: (label = "manual") =>
    request<{ filename: string; path: string; createdAt: string }>("/api/v1/backups", {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  backupPoints: () => request<{ items: import("./types").BackupPoint[] }>("/api/v1/backups"),
  restoreBackup: (filename: string) => request<{ restored: string; safetyBackup: { filename: string } }>("/api/v1/backups/restore", { method: "POST", body: JSON.stringify({ filename }) }),
  importJobs: () => request<{ items: ImportJob[] }>("/api/v1/imports"),
  exportUrl: (format: "csv" | "json") => profileQuery(`/api/v1/exports/${format}`),
};
