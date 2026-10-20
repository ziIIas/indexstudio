import { useEffect, useMemo, useRef, useState } from "react";
import type { Profile, ProfileInput } from "../types";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

function fuzzyMatch(profile: Profile, query: string) {
  const needle = normalize(query);
  if (!needle) return true;
  const values = [normalize(profile.code), normalize(profile.displayName)];
  return values.some((value) => {
    if (value.includes(needle)) return true;
    let index = 0;
    for (const character of value) if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
    if (needle.length < 3) return false;
    return editDistance(value.slice(0, Math.max(needle.length, Math.min(value.length, needle.length + 2))), needle) <= Math.min(2, Math.floor(needle.length / 3));
  });
}

type Draft = { code: string; displayName: string; printTitle: string; workbookLabel: string; cloneFromId: string };
const emptyDraft = (): Draft => ({ code: "", displayName: "", printTitle: "", workbookLabel: "Workbook Labs", cloneFromId: "" });

export function ProfileSwitcher({
  profiles,
  activeProfile,
  onSwitch,
  onCreate,
  onUpdate,
}: {
  profiles: Profile[];
  activeProfile: Profile;
  onSwitch: (profile: Profile) => Promise<void>;
  onCreate: (payload: ProfileInput) => Promise<void>;
  onUpdate: (profile: Profile, payload: Partial<Profile>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [mode, setMode] = useState<"new" | string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  const visible = useMemo(() => profiles
    .filter((profile) => (showArchived || !profile.archived) && fuzzyMatch(profile, query))
    .sort((a, b) => Number(b.starred) - Number(a.starred) || collator.compare(a.displayName, b.displayName) || collator.compare(a.code, b.code)), [profiles, query, showArchived]);

  const startNew = () => { setMode("new"); setDraft(emptyDraft()); setNameTouched(false); setError(""); };
  const startEdit = (profile: Profile) => {
    setMode(profile.id);
    setDraft({ code: profile.code, displayName: profile.displayName, printTitle: profile.printTitle, workbookLabel: profile.workbookLabel, cloneFromId: "" });
    setNameTouched(true);
    setError("");
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      if (mode === "new") {
        await onCreate({
          code: draft.code,
          displayName: draft.displayName,
          printTitle: draft.printTitle,
          workbookLabel: draft.workbookLabel,
          cloneFromId: draft.cloneFromId || undefined,
        });
      } else {
        const profile = profiles.find((item) => item.id === mode);
        if (profile) await onUpdate(profile, { code: draft.code, displayName: draft.displayName, printTitle: draft.printTitle, workbookLabel: draft.workbookLabel });
      }
      setMode(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save this profile."); }
    finally { setBusy(false); }
  };
  const update = async (profile: Profile, payload: Partial<Profile>) => {
    setBusy(true); setError("");
    try { await onUpdate(profile, payload); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update this profile."); }
    finally { setBusy(false); }
  };

  return <div className="profile-switcher" ref={root}>
    {open && <div className="profile-popup" role="dialog" aria-label="Class profiles">
      <div className="profile-popup-head"><strong>Classes</strong><button type="button" onClick={startNew}>New</button></div>
      <input className="profile-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search classes" aria-label="Search classes" autoFocus />
      <div className="profile-list">
        {visible.map((profile) => <div className={`profile-row ${profile.id === activeProfile.id ? "is-active" : ""}`} key={profile.id}>
          <button className="profile-star" type="button" disabled={busy} onClick={() => void update(profile, { starred: !profile.starred })} aria-label={`${profile.starred ? "Unstar" : "Star"} ${profile.displayName}`}>{profile.starred ? "★" : "☆"}</button>
          <button className="profile-select" type="button" disabled={busy || profile.archived} onClick={() => void onSwitch(profile)}><strong>{profile.displayName}</strong>{profile.displayName !== profile.code && <small>{profile.code}</small>}{profile.archived && <small>Archived</small>}</button>
          <button className="profile-edit" type="button" onClick={() => startEdit(profile)} aria-label={`Edit ${profile.displayName}`}>Edit</button>
        </div>)}
        {!visible.length && <p>No matching classes.</p>}
      </div>
      <label className="archived-toggle"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
      {mode && <div className="profile-editor">
        <strong>{mode === "new" ? "New class" : "Edit class"}</strong>
        <label>Class code<input value={draft.code} onChange={(event) => {
          const code = event.target.value.toUpperCase();
          setDraft((current) => ({ ...current, code, displayName: nameTouched ? current.displayName : code }));
        }} placeholder="SEC504" /></label>
        <label>Display name<input value={draft.displayName} onChange={(event) => { setNameTouched(true); setDraft((current) => ({ ...current, displayName: event.target.value })); }} placeholder={draft.code || "Defaults to class code"} /></label>
        <label>Print title<input value={draft.printTitle} onChange={(event) => setDraft((current) => ({ ...current, printTitle: event.target.value }))} placeholder={`${draft.displayName || draft.code || "Class"} Master Index`} /></label>
        <label>Workbook label<input value={draft.workbookLabel} onChange={(event) => setDraft((current) => ({ ...current, workbookLabel: event.target.value }))} /></label>
        {mode === "new" && <label>Start with<select value={draft.cloneFromId} onChange={(event) => setDraft((current) => ({ ...current, cloneFromId: event.target.value }))}><option value="">Blank profile</option>{profiles.filter((profile) => !profile.archived).map((profile) => <option value={profile.id} key={profile.id}>Clone {profile.displayName}</option>)}</select></label>}
        <div className="profile-editor-actions">
          <button className="secondary-button" type="button" onClick={() => setMode(null)}>Cancel</button>
          <button className="primary-button" type="button" disabled={busy || !draft.code.trim()} onClick={() => void save()}>Save</button>
          {mode !== "new" && (() => { const profile = profiles.find((item) => item.id === mode); return profile ? <button className="danger-button" type="button" disabled={busy || profile.id === activeProfile.id} title={profile.id === activeProfile.id ? "Switch to another class before archiving this one." : ""} onClick={() => void update(profile, { archived: !profile.archived })}>{profile.archived ? "Restore" : "Archive"}</button> : null; })()}
        </div>
      </div>}
      {error && <div className="profile-error" role="alert">{error}</div>}
    </div>}
    <button className="profile-current" type="button" onClick={() => { setOpen((current) => !current); setMode(null); setError(""); }} aria-expanded={open}><span>{activeProfile.displayName}</span><b>⌃</b></button>
  </div>;
}
