import { useState } from "react";
import type { DashboardStatus, Entry, Note } from "../types";

interface Props {
  status: DashboardStatus;
  entries: Entry[];
  notes: Note[];
  onOpenEntries: () => void;
  onCreateNote: (body: string) => Promise<void>;
  onArchiveNote: (id: string) => Promise<void>;
}

export function OverviewView({ status, entries, notes, onOpenEntries, onCreateNote, onArchiveNote }: Props) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const recent = [...entries]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  const workbookSources = status.sourceCounts.filter((item) => /workbook/i.test(item.label)).length;
  const bookSources = status.sourceCounts.length - workbookSources;
  const saveNote = async () => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    try {
      await onCreateNote(draft);
      setDraft("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="view-stack">
      <section className="metrics" aria-label="Index statistics">
        <article><span>Total entries</span><strong>{status.total.toLocaleString()}</strong><small>{status.keywords} keyword sections</small></article>
        <article><span>Source sets</span><strong>{status.sources}</strong><small>{bookSources} book{bookSources === 1 ? "" : "s"} · {workbookSources} workbook{workbookSources === 1 ? "" : "s"}</small></article>
        <article><span>Missing details</span><strong>{status.missingDetails.toLocaleString()}</strong><small>Entries that may need more context</small></article>
        <article className="attention"><span>Collision rows</span><strong>{status.collisionExtraRows}</strong><small>Preserved from duplicate input rows</small></article>
      </section>

      <section className="overview-grid">
        <article className="panel">
          <div className="panel-heading"><div><h3>Index checks</h3></div></div>
          <div className="quality-grid">
            <div><strong>{status.missingDetails}</strong><span>Missing details</span></div>
            <div><strong>{status.collisionExtraRows}</strong><span>Identity collisions</span></div>
            <div><strong>{status.keywords}</strong><span>Output sections</span></div>
          </div>
        </article>

        <article className="panel">
          <div className="panel-heading"><div><h3>Entries by source</h3></div></div>
          <div className="bar-list">
            {status.sourceCounts.map((item) => {
              const max = Math.max(...status.sourceCounts.map((source) => source.count), 1);
              return <div className="bar-row" key={item.label}><span>{item.label}</span><div><i style={{ width: `${(item.count / max) * 100}%` }} /></div><strong>{item.count}</strong></div>;
            })}
          </div>
        </article>
      </section>

      <section className="overview-grid lower-grid">
        <article className="panel">
          <div className="panel-heading"><div><h3>Top keywords</h3></div></div>
          <div className="rank-list">
            {status.topKeywords.map((item, index) => <div key={item.label}><b>{String(index + 1).padStart(2, "0")}</b><span>{item.label}</span><strong>{item.count}</strong></div>)}
          </div>
        </article>
        <article className="panel">
          <div className="panel-heading"><div><h3>Latest entries</h3></div></div>
          <div className="recent-list">
            {recent.map((entry) => <button key={entry.id} onClick={onOpenEntries}><span className="keyword-preview">{entry.keywords.join(", ")}</span><strong>{entry.concept}</strong><small>{entry.bookNumber} / {entry.pageNumber}</small></button>)}
          </div>
        </article>
      </section>

      <section className="panel notes-panel">
        <div className="panel-heading"><div><h3>Notes</h3><p>Quick reminders for future entries and fixes.</p></div></div>
        <div className="note-composer">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write anything…" aria-label="New note" />
          <button className="primary-button" type="button" disabled={!draft.trim() || saving} onClick={() => void saveNote()}>{saving ? "Saving…" : "Save note"}</button>
        </div>
        <div className="notes-list">
          {notes.map((note) => <article key={note.id}>
            <p>{note.body}</p>
            <div><time dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleString()}</time><button className="soft-button" type="button" onClick={() => void onArchiveNote(note.id)}>Archive</button></div>
          </article>)}
          {!notes.length && <p className="empty-notes">No notes yet.</p>}
        </div>
      </section>
    </div>
  );
}
