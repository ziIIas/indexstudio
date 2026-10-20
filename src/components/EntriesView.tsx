import { memo, useMemo, useState } from "react";
import type { Entry, Meta } from "../types";

interface Props {
  entries: Entry[];
  meta: Meta;
  onEdit: (entry: Entry, focus?: "keyword" | "concept" | "details" | "bookNumber" | "pageNumber", caret?: number) => void;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
type SortKey = "createdAt" | "keyword" | "concept" | "details" | "bookPage";

type CaretDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

type CaretBoundary = { node: Node; offset: number };

function fallbackCharacterOffset(textElement: HTMLElement, clientX: number, clientY: number, fallback: number) {
  const walker = document.createTreeWalker(textElement, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let runningOffset = 0;
  let closest: { offset: number; distance: number } | undefined;

  while (node) {
    const text = node.textContent ?? "";
    for (let index = 0; index < text.length; index += 1) {
      const character = document.createRange();
      character.setStart(node, index);
      character.setEnd(node, index + 1);
      const rect = character.getBoundingClientRect();
      if (rect.width || rect.height) {
        const middleX = rect.left + rect.width / 2;
        const middleY = rect.top + rect.height / 2;
        const distance = (middleX - clientX) ** 2 + (middleY - clientY) ** 2;
        if (!closest || distance < closest.distance) {
          closest = {
            offset: runningOffset + (clientX <= middleX ? index : index + 1),
            distance,
          };
        }
      }
    }
    runningOffset += text.length;
    node = walker.nextNode();
  }

  return Math.max(0, Math.min(closest?.offset ?? fallback, fallback));
}

function clickedCharacterOffset(event: React.MouseEvent<HTMLElement>, textElement: HTMLElement, fallback: number) {
  const pointDocument = document as CaretDocument;
  const range = pointDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
  const position: CaretBoundary | null = range
    ? { node: range.startContainer, offset: range.startOffset }
    : (() => {
      const caretPosition = pointDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
      return caretPosition ? { node: caretPosition.offsetNode, offset: caretPosition.offset } : null;
    })();

  if (position && textElement.contains(position.node)) {
    try {
      const beforeClick = document.createRange();
      beforeClick.selectNodeContents(textElement);
      beforeClick.setEnd(position.node, position.offset);
      return Math.max(0, Math.min(beforeClick.toString().length, fallback));
    } catch {
      // Some browsers report a boundary just outside a text node; use geometry below.
    }
  }

  return fallbackCharacterOffset(textElement, event.clientX, event.clientY, fallback);
}

export const EntriesView = memo(function EntriesView({ entries, meta, onEdit }: Props) {
  const [query, setQuery] = useState("");
  const [book, setBook] = useState("");
  const [keyword, setKeyword] = useState("");
  const [sort, setSort] = useState<SortKey>("createdAt");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries
      .filter((entry) => {
        if (book && entry.bookNumber !== book) return false;
        if (keyword && entry.keyword !== keyword) return false;
        if (!needle) return true;
        return [entry.keyword, ...entry.keywords, entry.concept, entry.details, entry.bookNumber, entry.pageNumber, entry.tags.join(" ")]
          .some((value) => value.toLowerCase().includes(needle));
      })
      .sort((a, b) => {
        let result: number;
        if (sort === "createdAt") result = a.createdAt.localeCompare(b.createdAt);
        else if (sort === "bookPage") {
          result = collator.compare(a.bookNumber, b.bookNumber) || collator.compare(a.pageNumber, b.pageNumber);
        } else result = collator.compare(a[sort], b[sort]);
        return direction === "asc" ? result : -result;
      });
  }, [entries, query, book, keyword, sort, direction]);

  const toggleSort = (column: SortKey) => {
    if (sort === column) setDirection((value) => value === "asc" ? "desc" : "asc");
    else { setSort(column); setDirection("asc"); }
  };
  const sortMarker = (column: SortKey) => sort === column ? (direction === "asc" ? " ↑" : " ↓") : "";
  const addedLabel = (value: string) => new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value)).replace(",", "");

  return (
    <section className="entries-workspace">
      <div className="table-titlebar">
        <div><h2>Index entries</h2><span>{filtered.length.toLocaleString()} of {entries.length.toLocaleString()} records</span></div>
      </div>
      <div className="toolbar filter-toolbar">
        <label className="search-box"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Concept, command, keyword…" /></label>
        <select aria-label="Filter by keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)}><option value="">All keywords</option>{meta.keywords.map((value) => <option key={value}>{value}</option>)}</select>
        <select aria-label="Filter by book" value={book} onChange={(event) => setBook(event.target.value)}><option value="">All books</option>{meta.books.map((value) => <option key={value}>{value}</option>)}</select>
      </div>
      <div className="table-wrap data-table-wrap">
        <table className="data-table">
          <thead><tr>
            <th><button onClick={() => toggleSort("keyword")}>Keyword{sortMarker("keyword")}</button></th>
            <th><button onClick={() => toggleSort("concept")}>Concept / data{sortMarker("concept")}</button></th>
            <th><button onClick={() => toggleSort("details")}>Details{sortMarker("details")}</button></th>
            <th><button onClick={() => toggleSort("bookPage")}>Book + page{sortMarker("bookPage")}</button></th>
            <th><button onClick={() => toggleSort("createdAt")}>Added{sortMarker("createdAt")}</button></th>
          </tr></thead>
          <tbody>{filtered.map((entry) =>
            <tr data-entry-row key={entry.id} onClick={() => onEdit(entry)}>
              <td onClick={(event) => { event.stopPropagation(); onEdit(entry, "keyword"); }}><span className="keyword-preview">{entry.keywords.join(", ")}</span></td>
              <td onClick={(event) => { event.stopPropagation(); const text = event.currentTarget.querySelector<HTMLElement>(".concept-link"); onEdit(entry, "concept", text ? clickedCharacterOffset(event, text, entry.concept.length) : entry.concept.length); }}><button className="concept-link">{entry.concept}</button></td>
              <td onClick={(event) => { event.stopPropagation(); const text = event.currentTarget.querySelector<HTMLElement>(".details-preview"); onEdit(entry, "details", text ? clickedCharacterOffset(event, text, entry.details.length) : entry.details.length); }}><span className="details-preview">{entry.details || (entry.detailsDocument?.nodes.some((node) => node.type === "image") ? "[Image]" : "—")}</span></td>
              <td className="book-page-cell" onClick={(event) => { event.stopPropagation(); onEdit(entry, "bookNumber"); }}><span className="book-cell">{entry.bookNumber}</span><span className="page-cell" onClick={(event) => { event.stopPropagation(); onEdit(entry, "pageNumber"); }}>{entry.pageNumber}</span></td>
              <td className="added-cell">{addedLabel(entry.createdAt)}</td>
            </tr>
          )}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="empty-state"><strong>No entries match these filters.</strong><span>Clear a filter or add a new entry.</span></div>}
      </div>
    </section>
  );
});
