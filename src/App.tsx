import { useCallback, useEffect, useMemo, useState } from "react";
import { api, setApiProfile } from "./api";
import { ApiView } from "./components/ApiView";
import { DataView } from "./components/DataView";
import { EntriesView } from "./components/EntriesView";
import { EntryDrawer } from "./components/EntryDrawer";
import type { EntryDrawerFocusField } from "./components/EntryDrawer";
import { EntryFormView } from "./components/EntryFormView";
import { OverviewView } from "./components/OverviewView";
import { PreviewView } from "./components/PreviewView";
import { ProfileSwitcher } from "./components/ProfileSwitcher";
import { SettingsView } from "./components/SettingsView";
import type { DashboardStatus, Entry, EntryInput, Health, Meta, Note, Profile, ProfileInput, ViewId } from "./types";
import { usePrintDocuments } from "./usePrintDocuments";

const emptyStatus: DashboardStatus = {
  total: 0,
  keywords: 0,
  sources: 0,
  missingDetails: 0,
  collisionExtraRows: 0,
  topKeywords: [],
  sourceCounts: [],
};
const emptyMeta: Meta = { keywords: [], books: [], bookOptions: [], preferences: { lastBookId: null, lastPageNumber: "", pagesByBook: {} } };
const emptyProfile: Profile = { id: "", code: "", displayName: "", printTitle: "", workbookLabel: "", starred: false, archived: false, createdAt: "", updatedAt: "" };
const lastSubmittedStorageKey = (profileId: string) => `index-last-submitted-entry:${profileId}`;
const readLastSubmitted = (profileId: string) => {
  try {
    const value = JSON.parse(window.localStorage.getItem(lastSubmittedStorageKey(profileId)) ?? "null");
    return value && typeof value === "object" && typeof value.id === "string" ? value as Entry : null;
  } catch {
    return null;
  }
};
const nextCloneConcept = (concept: string) => {
  const match = concept.match(/^(.*?)(?:\s*\((\d+)\))\s*$/);
  return match ? `${match[1].trimEnd()} (${Number(match[2]) + 1})` : `${concept} (1)`;
};
const clonePayload = (entry: Entry): EntryInput => ({ keyword: entry.keyword, primaryKeyword: entry.primaryKeyword, keywords: [...entry.keywords], concept: nextCloneConcept(entry.concept), details: entry.details, detailsDocument: entry.detailsDocument, bookNumber: entry.bookNumber, pageNumber: entry.pageNumber, tags: [...entry.tags], status: entry.status });

const nav: Array<{ id: ViewId; icon: string; label: string }> = [
  { id: "add", icon: "+", label: "Add entry" },
  { id: "entries", icon: "≡", label: "Entries" },
  { id: "preview", icon: "▤", label: "Print preview" },
  { id: "overview", icon: "⌂", label: "Overview" },
  { id: "data", icon: "⇄", label: "Data & backups" },
  { id: "settings", icon: "⚙", label: "Settings" },
  { id: "api", icon: "{ }", label: "API reference" },
];

function LoadingScreen() {
  return <div className="loading-screen"><strong>Loading…</strong></div>;
}

export default function App() {
  const [view, setView] = useState<ViewId>("add");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<DashboardStatus>(emptyStatus);
  const [notes, setNotes] = useState<Note[]>([]);
  const [meta, setMeta] = useState<Meta>(emptyMeta);
  const [health, setHealth] = useState<Health | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [drawerFocus, setDrawerFocus] = useState<EntryDrawerFocusField | undefined>();
  const [drawerCaret, setDrawerCaret] = useState<number | undefined>();
  const [lastSubmitted, setLastSubmitted] = useState<Entry | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const [toast, setToast] = useState("");
  const printDocuments = usePrintDocuments(entries, activeProfile ?? emptyProfile, !loading && !!activeProfile && !connectionError);

  const load = useCallback(async () => {
    try {
      const [healthResult, entriesResult, statusResult, metaResult, notesResult] = await Promise.all([
        api.health(), api.entries(), api.status(), api.meta(), api.notes(),
      ]);
      setHealth(healthResult);
      setEntries(entriesResult.items);
      setStatus(statusResult);
      setMeta(metaResult);
      setNotes(notesResult.items);
      setConnectionError("");
    } catch (reason) {
      setConnectionError(reason instanceof Error ? reason.message : "The local data service is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialize = async () => {
      try {
        const result = await api.profiles();
        const remembered = window.localStorage.getItem("index-active-profile");
        const selected = result.items.find((profile) => profile.id === remembered && !profile.archived)
          ?? result.items.find((profile) => profile.id === result.activeProfileId && !profile.archived)
          ?? result.items.find((profile) => !profile.archived);
        if (!selected) throw new Error("No active class profile is available.");
        setProfiles(result.items);
        setActiveProfile(selected);
        setLastSubmitted(readLastSubmitted(selected.id));
        setApiProfile(selected.id);
        window.localStorage.setItem("index-active-profile", selected.id);
        if (selected.id !== result.activeProfileId) await api.activateProfile(selected.id);
        await load();
      } catch (reason) {
        setConnectionError(reason instanceof Error ? reason.message : "The local data service is unavailable.");
        setLoading(false);
      }
    };
    void initialize();
  }, [load]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const isEditable = (element: Element | null) => element instanceof HTMLElement && (
      element.matches("input, textarea, select, [contenteditable='true']") || element.isContentEditable
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isEditable(document.activeElement)) return;
      const shortcutViews: Record<string, ViewId> = { "1": "add", "2": "entries", "3": "preview" };
      const shortcutView = shortcutViews[event.key];
      if (!shortcutView) return;
      event.preventDefault();
      setView(shortcutView);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openEdit = useCallback((entry: Entry, focus?: EntryDrawerFocusField, caret?: number) => {
    setEditing(entry);
    setDrawerFocus(focus);
    setDrawerCaret(caret);
    setDrawerOpen(true);
  }, []);
  const closeDrawer = () => { setDrawerOpen(false); setEditing(null); setDrawerFocus(undefined); setDrawerCaret(undefined); };
  const notify = (message: string) => setToast(message);
  const rememberLastSubmitted = (entry: Entry) => {
    setLastSubmitted(entry);
    if (!activeProfile) return;
    try {
      window.localStorage.setItem(lastSubmittedStorageKey(activeProfile.id), JSON.stringify(entry));
    } catch {
      // Large pasted images can exceed browser storage; the current session still retains the entry.
    }
  };

  const refreshProfiles = async () => {
    const result = await api.profiles();
    setProfiles(result.items);
    return result;
  };
  const switchProfile = async (profile: Profile) => {
    if (profile.id === activeProfile?.id) return;
    closeDrawer();
    setLoading(true);
    setApiProfile(profile.id);
    window.localStorage.setItem("index-active-profile", profile.id);
    try {
      const activated = await api.activateProfile(profile.id);
      setActiveProfile(activated);
      setLastSubmitted(readLastSubmitted(activated.id));
      await load();
      notify(`Opened ${activated.displayName}.`);
    } catch (reason) {
      if (activeProfile) setApiProfile(activeProfile.id);
      setLoading(false);
      throw reason;
    }
  };
  const createProfile = async (payload: ProfileInput) => {
    const created = await api.createProfile(payload);
    await refreshProfiles();
    await switchProfile(created);
  };
  const updateProfile = async (profile: Profile, payload: Partial<Profile>) => {
    const updated = await api.updateProfile(profile.id, payload);
    const result = await refreshProfiles();
    if (activeProfile?.id === updated.id) setActiveProfile(updated);
    else if (result.activeProfileId === updated.id) setActiveProfile(updated);
  };

  const saveEntry = async (payload: EntryInput) => {
    if (editing) await api.updateEntry(editing.id, payload);
    else await api.createEntry(payload);
    closeDrawer();
    await load();
    notify(editing ? "Entry updated." : "Entry added to the index.");
  };
  const addEntry = async (payload: EntryInput) => {
    const created = await api.createEntry(payload);
    rememberLastSubmitted(created);
    await load();
    notify("Entry saved.");
  };
  const createNote = async (body: string) => {
    const created = await api.createNote(body);
    setNotes((current) => [created, ...current]);
    notify("Note saved.");
  };
  const archiveNote = async (id: string) => {
    await api.archiveNote(id);
    setNotes((current) => current.filter((note) => note.id !== id));
    notify("Note archived.");
  };
  const cloneEntry = editing ? async () => {
    const created = await api.createEntry(clonePayload(editing));
    rememberLastSubmitted(created);
    await load();
    setEditing(created);
    setDrawerFocus("concept");
    setDrawerCaret(created.concept.length);
    notify(`Cloned as “${created.concept}”.`);
  } : null;
  const deleteEntry = editing ? async () => {
    if (!window.confirm(`Move “${editing.concept}” to trash?`)) return;
    await api.deleteEntry(editing.id);
    closeDrawer();
    await load();
    notify("Entry moved to trash.");
  } : null;
  const collisionCount = useMemo(() => {
    if (!editing) return 0;
    return entries.filter((entry) => entry.id !== editing.id &&
      entry.concept.trim().toLowerCase() === editing.concept.trim().toLowerCase() &&
      entry.bookNumber.trim().toLowerCase() === editing.bookNumber.trim().toLowerCase() &&
      entry.pageNumber.trim().toLowerCase() === editing.pageNumber.trim().toLowerCase()).length;
  }, [editing, entries]);

  if (loading) return <LoadingScreen />;
  if (connectionError || !health) return <div className="connection-screen"><h1>Could not reach the data file.</h1><p>{connectionError}</p><button className="primary-button" onClick={() => window.location.reload()}>Try again</button><small>Start the app with <b>npm run launch</b> on Ubuntu or macOS, <b>Start.command</b> on macOS, or <b>Start.cmd</b> on Windows.</small></div>;
  if (!activeProfile) return <LoadingScreen />;

  return <div className="app-shell">
    <aside className="sidebar">
      <nav aria-label="Primary navigation">{nav.map((item) => <button key={item.id} className={`nav-item ${view === item.id ? "is-active" : ""}`} onClick={() => setView(item.id)}><b>{item.icon}</b><span><strong>{item.label}</strong></span></button>)}</nav>
      <ProfileSwitcher profiles={profiles} activeProfile={activeProfile} onSwitch={switchProfile} onCreate={createProfile} onUpdate={updateProfile} />
    </aside>

    <main className="app-main">
      {view === "add" && <EntryFormView meta={meta} lastSubmitted={lastSubmitted} onSave={addEntry} onOpenSettings={() => setView("settings")} />}
      {view === "overview" && <OverviewView status={status} entries={entries} notes={notes} onOpenEntries={() => setView("entries")} onCreateNote={createNote} onArchiveNote={archiveNote} />}
      {view === "entries" && <EntriesView entries={entries} meta={meta} onEdit={openEdit} />}
      {view === "preview" && <PreviewView entries={entries} profile={activeProfile} {...printDocuments} />}
      {view === "data" && <DataView onChanged={load} notify={notify} />}
      {view === "settings" && <SettingsView meta={meta} onChanged={load} notify={notify} />}
      {view === "api" && <ApiView />}
    </main>

    <EntryDrawer entry={editing} open={drawerOpen} meta={meta} collisionCount={collisionCount} focusField={drawerFocus} caretPosition={drawerCaret} onClose={closeDrawer} onSave={saveEntry} onDelete={deleteEntry} onClone={cloneEntry} />
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}
