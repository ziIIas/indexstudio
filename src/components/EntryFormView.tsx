import { useEffect, useMemo, useRef, useState } from "react";
import type { DetailsDocument, Entry, EntryInput, Meta } from "../types";
import { RichDetailsEditor } from "./RichDetailsEditor";

interface Props { meta: Meta; lastSubmitted: Entry | null; onSave: (entry: EntryInput) => Promise<void>; onOpenSettings: () => void; }
const blank: { concept: string; details: string; detailsDocument: DetailsDocument | null } = { concept: "", details: "", detailsDocument: null };
const splitKeywords = (value: string) => value
  .split(/[,;]/)
  .map((item) => item.trim())
  .filter((item, index, all) => item && all.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index);

function currentKeywordToken(value: string, caret: number) {
  const beforeCaret = value.slice(0, caret);
  const separator = Math.max(beforeCaret.lastIndexOf(","), beforeCaret.lastIndexOf(";"));
  const start = separator + 1;
  const nextComma = value.indexOf(",", caret);
  const nextSemicolon = value.indexOf(";", caret);
  const end = [nextComma, nextSemicolon].filter((position) => position >= 0).sort((a, b) => a - b)[0] ?? value.length;
  const segment = value.slice(start, end);
  const leadingWhitespace = segment.match(/^\s*/)?.[0] ?? "";
  return { start, end, leadingWhitespace, query: segment.trim() };
}

export function EntryFormView({ meta, lastSubmitted, onSave, onOpenSettings }: Props) {
  const [bookId, setBookId] = useState("");
  const [pageNumber, setPageNumber] = useState("");
  const [keywordInput, setKeywordInput] = useState("");
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [keywordFocused, setKeywordFocused] = useState(false);
  const [keywordCaret, setKeywordCaret] = useState(0);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [detailsKey, setDetailsKey] = useState(0);
  const keywordInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (bookId || !meta.bookOptions.length) return;
    const preferred = meta.bookOptions.find((book) => book.id === meta.preferences.lastBookId) ?? meta.bookOptions[0];
    setBookId(preferred.id);
    setPageNumber(meta.preferences.pagesByBook[preferred.id] ?? meta.preferences.lastPageNumber);
  }, [bookId, meta]);

  const selectedBook = meta.bookOptions.find((book) => book.id === bookId);
  const keywordToken = currentKeywordToken(keywordInput, keywordCaret);
  const suggestions = useMemo(() => {
    const query = keywordToken.query.toLocaleLowerCase();
    if (!query) return [];
    return meta.keywords
      .filter((keyword) => keyword.toLocaleLowerCase().includes(query))
      .sort((left, right) => {
        const leftStarts = left.toLocaleLowerCase().startsWith(query) ? 0 : 1;
        const rightStarts = right.toLocaleLowerCase().startsWith(query) ? 0 : 1;
        return leftStarts - rightStarts || left.localeCompare(right);
      })
      .slice(0, 8);
  }, [keywordToken.query, meta.keywords]);
  const showSuggestions = keywordFocused && suggestions.length > 0;
  const changeKeywords = (value: string) => {
    setKeywordInput(value);
  };
  const chooseSuggestion = (suggestion: string) => {
    const token = currentKeywordToken(keywordInput, keywordCaret);
    const replacement = `${token.leadingWhitespace}${suggestion}`;
    const remainder = keywordInput.slice(token.end);
    const separator = remainder.startsWith(",") || remainder.startsWith(";") ? "" : ", ";
    const value = `${keywordInput.slice(0, token.start)}${replacement}${separator}${remainder}`;
    const caret = token.start + replacement.length + separator.length;
    changeKeywords(value);
    setKeywordCaret(caret);
    setKeywordFocused(true);
    requestAnimationFrame(() => {
      keywordInputRef.current?.focus();
      keywordInputRef.current?.setSelectionRange(caret, caret);
    });
  };

  useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => setError(""), 5000);
    return () => window.clearTimeout(timeout);
  }, [error]);

  useEffect(() => {
    setActiveSuggestion(0);
  }, [keywordToken.query]);
  const chooseBook = (id: string) => { setBookId(id); setPageNumber(meta.preferences.pagesByBook[id] ?? meta.preferences.lastPageNumber); };
  const cloneLastSubmitted = () => {
    if (!lastSubmitted) return;
    const matchingBook = meta.bookOptions.find((book) => book.number === lastSubmitted.bookNumber);
    if (!matchingBook) { setError("The last entry's book is no longer available. Add it in Settings first."); return; }
    setBookId(matchingBook.id);
    setPageNumber(lastSubmitted.pageNumber);
    setKeywordInput((lastSubmitted.keywords.length ? lastSubmitted.keywords : [lastSubmitted.keyword]).join(", "));
    setKeywordFocused(false);
    setForm({ concept: lastSubmitted.concept, details: lastSubmitted.details, detailsDocument: lastSubmitted.detailsDocument });
    setDetailsKey((current) => current + 1);
  };
  const save = async () => {
    const finalKeywords = splitKeywords(keywordInput);
    if (!selectedBook || !pageNumber.trim() || !finalKeywords.length || !form.concept.trim()) { setError("Book, page, at least one keyword, and concept are required."); return; }
    setBusy(true); setError("");
    try {
      await onSave({ keyword: finalKeywords[0], primaryKeyword: finalKeywords[0], keywords: finalKeywords, concept: form.concept, details: form.details, detailsDocument: form.detailsDocument, bookNumber: selectedBook.number, pageNumber, tags: [] });
      setKeywordInput(""); setForm(blank); setDetailsKey((current) => current + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save this entry."); }
    finally { setBusy(false); }
  };

  return <form className="entry-form" onSubmit={(event) => { event.preventDefault(); void save(); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void save(); } }}>
    <div className="entry-form-grid">
      <label>Book number
        {meta.bookOptions.length ? <select value={bookId} onChange={(event) => chooseBook(event.target.value)}>{meta.bookOptions.map((book) => <option key={book.id} value={book.id}>{book.number}{book.label ? ` — ${book.label}` : ""}</option>)}</select> : <button type="button" className="secondary-button" onClick={onOpenSettings}>Set up books</button>}
      </label>
      <label>Page number<input value={pageNumber} onChange={(event) => setPageNumber(event.target.value)} /></label>
    </div>
    <label>Keywords
      <span className="keyword-input-wrap">
      <input ref={keywordInputRef} id="entry-keywords" value={keywordInput} onChange={(event) => { changeKeywords(event.target.value); setKeywordCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length); }} onFocus={(event) => { setKeywordFocused(true); setKeywordCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length); }} onBlur={() => setKeywordFocused(false)} onClick={(event) => setKeywordCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length)} onKeyUp={(event) => setKeywordCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length)} onKeyDown={(event) => {
        if (event.key === "Escape" && showSuggestions) { setKeywordFocused(false); return; }
        if (event.key === "ArrowDown" && showSuggestions) { event.preventDefault(); setActiveSuggestion((current) => Math.min(current + 1, suggestions.length - 1)); return; }
        if (event.key === "ArrowUp" && showSuggestions) { event.preventDefault(); setActiveSuggestion((current) => Math.max(current - 1, 0)); return; }
        if (event.key === "Tab" && showSuggestions) { event.preventDefault(); chooseSuggestion(suggestions[activeSuggestion] ?? suggestions[0]); }
      }} placeholder="keyword1, keyword2" aria-describedby="keyword-help" aria-autocomplete="list" aria-controls="keyword-suggestions" aria-expanded={showSuggestions} aria-activedescendant={showSuggestions ? `keyword-suggestion-${activeSuggestion}` : undefined} autoComplete="off" />
      {showSuggestions && <span id="keyword-suggestions" className="keyword-suggestions" role="listbox" aria-label="Keyword suggestions">{suggestions.map((suggestion, index) => <button key={suggestion} id={`keyword-suggestion-${index}`} type="button" role="option" aria-selected={index === activeSuggestion} className={index === activeSuggestion ? "is-active" : ""} onMouseDown={(event) => { event.preventDefault(); chooseSuggestion(suggestion); }} onMouseEnter={() => setActiveSuggestion(index)}>{suggestion}</button>)}</span>}
      </span>
      <small id="keyword-help">Separate multiple keywords with commas or semicolons.</small>
    </label>
    <label>Concept / data<input value={form.concept} onChange={(event) => setForm({ ...form, concept: event.target.value })} /></label>
    <label className="rich-details-label">Additional details<RichDetailsEditor key={detailsKey} initialDocument={form.detailsDocument} initialText={form.details} onChange={(detailsDocument, details) => setForm((current) => ({ ...current, details, detailsDocument }))} onError={setError} /></label>
    {error && <div className="form-error form-error-toast" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
    <div className="entry-form-actions"><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save entry"}</button><button type="button" className="secondary-button clone-last-button" disabled={busy || !lastSubmitted} title={lastSubmitted ? "Fill the form from the last entry submitted to this class." : "Save an entry first."} onClick={cloneLastSubmitted}>Clone last entry</button></div>
  </form>;
}
