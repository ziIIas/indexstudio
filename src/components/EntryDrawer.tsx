import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Entry, EntryInput, Meta } from "../types";
import { RichDetailsEditor } from "./RichDetailsEditor";
import type { RichDetailsEditorHandle } from "./RichDetailsEditor";

export type EntryDrawerFocusField = "keyword" | "concept" | "details" | "bookNumber" | "pageNumber";

interface Props {
  entry: Entry | null;
  open: boolean;
  meta: Meta;
  collisionCount: number;
  focusField?: EntryDrawerFocusField;
  caretPosition?: number;
  onClose: () => void;
  onSave: (payload: EntryInput) => Promise<void>;
  onDelete: (() => Promise<void>) | null;
  onClone: (() => Promise<void>) | null;
}

const blank: EntryInput = {
  keyword: "",
  keywords: [],
  primaryKeyword: "",
  concept: "",
  details: "",
  detailsDocument: null,
  bookNumber: "",
  pageNumber: "",
  tags: [],
};

function formFor(entry: Entry | null): EntryInput {
  if (!entry) return { ...blank, keywords: [], tags: [] };
  return {
    keyword: entry.keyword,
    keywords: [...entry.keywords],
    primaryKeyword: entry.primaryKeyword,
    concept: entry.concept,
    details: entry.details,
    detailsDocument: entry.detailsDocument,
    bookNumber: entry.bookNumber,
    pageNumber: entry.pageNumber,
    tags: [...entry.tags],
    revision: entry.revision,
  };
}

function keywordTextFor(form: EntryInput) {
  return (form.keywords ?? (form.keyword ? [form.keyword] : [])).join(", ");
}

function parseKeywords(value: string) {
  return [...new Map(
    value
      .split(/[,;]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => [item.toLocaleLowerCase(), item]),
  ).values()];
}

export function EntryDrawer({ entry, open, meta, collisionCount, focusField, caretPosition, onClose, onSave, onDelete, onClone }: Props) {
  // Keep the record identity with the form state. Resetting this during render
  // means React re-renders before committing, so a newly opened drawer never
  // briefly paints the previously edited (or blank) entry.
  const formKey = `${open}:${entry?.id ?? "new"}`;
  const [formState, setFormState] = useState(() => ({ key: formKey, form: formFor(entry) }));
  const [keywordDraftState, setKeywordDraftState] = useState(() => ({ key: formKey, value: keywordTextFor(formFor(entry)) }));
  const [uiKey, setUiKey] = useState(formKey);
  const [saving, setSaving] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState("");
  if (formState.key !== formKey) {
    setFormState({ key: formKey, form: formFor(entry) });
  }
  if (keywordDraftState.key !== formKey) {
    setKeywordDraftState({ key: formKey, value: keywordTextFor(formFor(entry)) });
  }
  if (uiKey !== formKey) {
    setUiKey(formKey);
    setError("");
    setSaving(false);
    setCloning(false);
  }
  const form = formState.form;
  const setForm = (update: EntryInput | ((current: EntryInput) => EntryInput)) => {
    setFormState((current) => ({
      ...current,
      form: typeof update === "function" ? update(current.form) : update,
    }));
  };
  const fieldRefs = useRef<Partial<Record<Exclude<EntryDrawerFocusField, "details">, HTMLInputElement>>>({});
  const detailsEditorRef = useRef<RichDetailsEditorHandle>(null);

  useEffect(() => {
    if (!open) return;
    const listener = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const target = focusField ?? "keyword";
    if (target === "details") { detailsEditorRef.current?.focusAt(caretPosition); return; }
    const field = fieldRefs.current[target];
    field?.focus({ preventScroll: true });
    if (field && caretPosition != null && target === "concept") {
      const position = Math.max(0, Math.min(caretPosition, field.value.length));
      field.setSelectionRange(position, position);
    }
  }, [caretPosition, focusField, formKey, open]);

  if (!open) return null;
  const update = <K extends keyof EntryInput>(key: K, value: EntryInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  const updateKeywords = (value: string) => {
    setKeywordDraftState({ key: formKey, value });
    const keywords = parseKeywords(value);
    const primaryKeyword = keywords[0] ?? "";
    setForm((current) => ({ ...current, keyword: primaryKeyword, keywords, primaryKeyword }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!(form.keywords?.length ?? (form.keyword ? 1 : 0)) || !form.concept.trim() || !form.bookNumber.trim() || !form.pageNumber.trim()) {
      setError("Keyword, concept, book, and page are required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const keywords = parseKeywords(keywordDraftState.value);
      const primaryKeyword = keywords[0] ?? "";
      await onSave({ ...form, keyword: primaryKeyword, keywords, primaryKeyword });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this entry.");
    } finally {
      setSaving(false);
    }
  };
  const clone = async () => {
    if (!onClone) return;
    setCloning(true);
    setError("");
    try {
      await onClone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not clone this entry.");
    } finally {
      setCloning(false);
    }
  };

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="entry-drawer" aria-modal="true" role="dialog" aria-labelledby="entry-drawer-title">
        <div className="drawer-heading">
          <div><h2 id="entry-drawer-title">{entry ? "Edit index entry" : "Add index entry"}</h2></div>
          <button className="icon-button" aria-label="Close editor" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          {collisionCount > 0 && <div className="warning-callout"><strong>Possible duplicate identity</strong><span>{collisionCount} other active record{collisionCount === 1 ? "" : "s"} use this concept, book, and page.</span></div>}
          <label>Keywords<input ref={(element) => { fieldRefs.current.keyword = element ?? undefined; }} list="keyword-options" value={keywordDraftState.value} onChange={(event) => updateKeywords(event.target.value)} placeholder="keyword1, keyword2" /><small>Separate keywords with commas.</small></label>
          <datalist id="keyword-options">{meta.keywords.map((value) => <option key={value} value={value} />)}</datalist>
          <label>Concept / data<input ref={(element) => { fieldRefs.current.concept = element ?? undefined; }} value={form.concept} onChange={(event) => update("concept", event.target.value)} /></label>
          <label className="rich-details-label">Additional details<RichDetailsEditor key={formKey} ref={detailsEditorRef} initialDocument={form.detailsDocument} initialText={form.details} onChange={(detailsDocument, details) => setForm((current) => ({ ...current, details, detailsDocument }))} onError={setError} /></label>
          <div className="field-grid two-up">
            <label>Book number<input ref={(element) => { fieldRefs.current.bookNumber = element ?? undefined; }} list="book-options" value={form.bookNumber} onChange={(event) => update("bookNumber", event.target.value)} /></label>
            <label>Page number<input ref={(element) => { fieldRefs.current.pageNumber = element ?? undefined; }} value={form.pageNumber} onChange={(event) => update("pageNumber", event.target.value)} /></label>
          </div>
          <datalist id="book-options">{meta.books.map((value) => <option key={value} value={value} />)}</datalist>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="drawer-actions">
            {onDelete && <button type="button" className="danger-button" disabled={saving || cloning} onClick={() => void onDelete()}>Move to trash</button>}
            {onClone && <button type="button" className="secondary-button" disabled={saving || cloning} onClick={() => void clone()}>{cloning ? "Cloning…" : "Clone"}</button>}
            <span />
            <button type="button" className="secondary-button" disabled={saving || cloning} onClick={onClose}>Cancel</button>
            <button className="primary-button" disabled={saving || cloning}>{saving ? "Saving…" : "Save entry"}</button>
          </div>
        </form>
      </aside>
    </div>
  );
}
