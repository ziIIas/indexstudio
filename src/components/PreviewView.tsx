import { useEffect, useMemo, useRef, useState } from "react";
import { downloadText, standaloneHtml } from "../exportHtml";
import { commonPortsParts, sourceRef } from "../pagination";
import type { DetailBlock, Entry, PrintDetailEntry, PrintDocument, PrintLayout, PrintPage, Profile, SummaryRow, TocRow } from "../types";
import type { PrintDocuments } from "../usePrintDocuments";
import { entriesForPrintScope, type PrintScope } from "../printScope";
import { RichDetailsContent } from "./RichDetailsEditor";

function TocTable({ rows }: { rows: TocRow[] }) {
  return <table className="print-toc"><thead><tr><th>Concept/Data</th><th>Book page</th><th>Index page</th></tr></thead><tbody>{rows.map(({ entry, indexPage }) => <tr key={entry.id}><td>{entry.concept}</td><td>{sourceRef(entry)}</td><td>{indexPage}</td></tr>)}</tbody></table>;
}

function PairedTocTable({ columns }: { columns: TocRow[][] }) {
  const [left, right] = columns;
  return <table className="print-toc print-toc-paired">
    <colgroup><col /><col /><col /><col /><col /><col /><col /></colgroup>
    <thead><tr><th>Concept/Data</th><th>Book page</th><th>Index page</th><th className="toc-spacer" aria-hidden="true" /><th>Concept/Data</th><th>Book page</th><th>Index page</th></tr></thead>
    <tbody>{Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
      const leftRow = left[index]; const rightRow = right[index];
      return <tr key={`${leftRow?.entry.id ?? "empty"}-${rightRow?.entry.id ?? "empty"}`}>
        <td>{leftRow?.entry.concept}</td><td>{leftRow ? sourceRef(leftRow.entry) : ""}</td><td>{leftRow?.indexPage ?? ""}</td><td className="toc-spacer" aria-hidden="true" />
        <td>{rightRow?.entry.concept}</td><td>{rightRow ? sourceRef(rightRow.entry) : ""}</td><td>{rightRow?.indexPage ?? ""}</td>
      </tr>;
    })}</tbody>
  </table>;
}

function CommonPortsReference({ entry }: { entry: Entry }) {
  const parts = commonPortsParts(entry);
  if (!parts) return null;
  return <div className="print-common-ports">
    <div className="print-common-ports-heading"><h2>{entry.concept}</h2><span>{sourceRef(entry)}</span></div>
    <p className="print-common-ports-intro">{parts.intro}</p>
    <div className="print-common-ports-columns">
      <section><h3>{parts.numericalLabel}</h3><pre>{parts.numerical}</pre></section>
      <section><h3>{parts.alphabeticalLabel}</h3><pre>{parts.alphabetical}</pre></section>
    </div>
  </div>;
}

function SummaryRows({ rows, embedded = false }: { rows: SummaryRow[]; embedded?: boolean }) {
  return <div className={embedded ? "print-summary-embedded" : "print-summary"}>
    {embedded && <h2>Sections (Keywords)</h2>}
    {rows.map((row) => <div key={row.keyword}><span>{row.keyword}</span><strong>{row.page}</strong></div>)}
  </div>;
}

function DetailArticle({ item, compact }: { item: PrintDetailEntry; compact: boolean }) {
  const concept = <>{item.entry.concept}{item.fragment?.continued && <small> (continued)</small>}</>;
  const detailsDocument = item.fragment ? item.fragment.detailsDocument : item.entry.detailsDocument;
  const details = (item.fragment?.details ?? item.entry.details) || "No additional details";
  return <article>
    {compact
      ? <div className="print-entry-heading"><h3>{concept}</h3><div className="print-reference">{sourceRef(item.entry)}</div></div>
      : <><div className="print-reference">{sourceRef(item.entry)}</div><h3>{concept}</h3></>}
    {item.referenceKeyword
      ? <p className="print-cross-reference">See full details under <b>{item.referenceKeyword}</b>{item.referencePage ? `, index page ${item.referencePage}` : ""}.</p>
      : <p><RichDetailsContent document={detailsDocument} text={details} /></p>}
  </article>;
}

function DetailBlocks({ blocks, compact }: { blocks: DetailBlock[]; compact: boolean }) {
  return <>{blocks.map((block, blockIndex) => <div className="print-section" key={`${block.keyword}-${blockIndex}`}>
    <h2>{block.keyword}{block.continuation && <small> continued</small>}</h2>
    {block.entries.map((item) => <DetailArticle item={item} compact={compact} key={`${item.entry.id}-${item.keyword}-${item.fragment?.index ?? 0}`} />)}
  </div>)}</>;
}

function PrintPageContent({ page, document }: { page: PrintPage; document: PrintDocument }) {
  const compact = document.layout !== "standard";
  if (page.kind === "toc") return <section className={`print-page toc-page-render${compact ? " is-compact" : ""}${page.spacious ? " is-spacious" : ""}`}>
    {compact && page.columns?.length === 2
      ? <PairedTocTable columns={page.columns} />
      : compact && page.columns
      ? <div className="print-toc-columns">
        {page.columns.map((rows, index) => <div className="print-toc-column" key={index}><TocTable rows={rows} /></div>)}
        {page.summaryRows && <SummaryRows rows={page.summaryRows} embedded />}
      </div>
      : <TocTable rows={page.rows} />}
    <footer>{page.number}</footer>
  </section>;
  if (page.kind === "detail") return <section className={`print-page detail-page-render${compact ? " is-compact" : ""}${page.fullWidth ? " is-full-width" : ""}`}>
    {compact && page.columns
      ? <div className="print-detail-columns">{page.columns.map((blocks, index) => <div className="print-detail-column" key={index}><DetailBlocks blocks={blocks} compact /></div>)}</div>
      : <DetailBlocks blocks={page.blocks} compact={false} />}
    <footer>{page.number}</footer>
  </section>;
  return <section className={`print-page summary-page-render${compact ? " is-compact" : ""}`}>
    <SummaryRows rows={page.rows} />
    {page.featuredEntry && <CommonPortsReference entry={page.featuredEntry} />}
    <footer>{page.number}</footer>
  </section>;
}

export function PreviewView({ entries, profile, documents, updateNow, currentDocument }: {
  entries: Entry[];
  profile: Profile;
  documents: PrintDocuments | null;
  updateNow: () => Promise<PrintDocuments>;
  currentDocument: (mode: PrintScope, layout: PrintLayout) => Promise<PrintDocument>;
}) {
  const [mode, setMode] = useState<"full" | "workbook">("full");
  const [hideLabs, setHideLabs] = useState(true);
  const scope: PrintScope = mode === "workbook" ? "workbook" : hideLabs ? "main" : "full";
  const [layout, setLayout] = useState<PrintLayout>("compact");
  const [activePage, setActivePage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [renderedThrough, setRenderedThrough] = useState(3);
  const [action, setAction] = useState<"print" | "download" | "update" | null>(null);
  const [printDocument, setPrintDocument] = useState<PrintDocument | null>(null);
  const pageCanvas = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const includedEntries = useMemo(() => entriesForPrintScope(entries, scope), [entries, scope]);
  const document = documents?.[layout]?.[scope] ?? null;
  const pageNumber = document ? Math.min(activePage, document.totalPages) : 1;

  const downloadHtml = async () => {
    setAction("download");
    try {
      const current = await currentDocument(scope, layout);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadText(`${profile.code.toLowerCase()}-${mode === "workbook" ? "labs-index" : "index"}-${stamp}-${layout}.html`, standaloneHtml(current), "text/html;charset=utf-8");
    } finally { setAction(null); }
  };
  const requestPrint = async () => {
    setAction("print");
    try { setPrintDocument(await currentDocument(scope, layout)); } finally { setAction(null); }
  };
  const refreshPreview = async () => {
    setAction("update");
    try { await updateNow(); } finally { setAction(null); }
  };

  useEffect(() => {
    if (!printDocument) return;
    const finish = () => setPrintDocument(null);
    let afterSecondPaint = 0;
    const afterFirstPaint = window.requestAnimationFrame(() => {
      afterSecondPaint = window.requestAnimationFrame(() => window.print());
    });
    window.addEventListener("afterprint", finish, { once: true });
    return () => {
      window.cancelAnimationFrame(afterFirstPaint);
      window.cancelAnimationFrame(afterSecondPaint);
      window.removeEventListener("afterprint", finish);
    };
  }, [printDocument]);

  useEffect(() => {
    if (!document) return;
    const number = Math.min(activePage, document.totalPages);
    setActivePage(number);
    setPageInput(String(number));
    setRenderedThrough((current) => Math.min(Math.max(3, current), document.totalPages));
  }, [document, activePage]);
  useEffect(() => {
    setActivePage(1); setPageInput("1"); setRenderedThrough(3);
    pageCanvas.current?.scrollTo({ top: 0 });
  }, [scope, layout]);

  const updateActivePageFromScroll = () => {
    const canvas = pageCanvas.current;
    if (!canvas || !document) return;
    const firstPage = pageRefs.current.get(1);
    const secondPage = pageRefs.current.get(2);
    const stride = firstPage && secondPage ? secondPage.offsetTop - firstPage.offsetTop : firstPage?.offsetHeight ?? 1;
    const firstOffset = firstPage?.offsetTop ?? 0;
    const center = canvas.scrollTop + canvas.clientHeight * 0.42;
    const nextActive = Math.min(document.totalPages, Math.max(1, Math.round((center - firstOffset) / stride) + 1));
    setActivePage((current) => current === nextActive ? current : nextActive);
    const requestedThrough = Math.min(document.totalPages, Math.max(3, Math.ceil((canvas.scrollTop + canvas.clientHeight * 1.12 - firstOffset) / stride) + 2));
    setRenderedThrough((current) => Math.max(current, requestedThrough));
  };
  const jumpToPage = () => {
    if (!document) return;
    const requested = Number.parseInt(pageInput, 10);
    const destination = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), document.totalPages) : pageNumber;
    setPageInput(String(destination)); setActivePage(destination);
    setRenderedThrough((current) => Math.max(current, Math.min(document.totalPages, destination + 2)));
    pageRefs.current.get(destination)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return <div className="preview-layout">
    <section className="preview-controls">
      <div><h2>Print preview</h2></div>
      <div className="segmented-control" aria-label="Index scope">
        <button className={mode === "full" ? "active" : ""} onClick={() => setMode("full")}>Full index</button>
        <button className={mode === "workbook" ? "active" : ""} onClick={() => setMode("workbook")}>Workbook labs</button>
      </div>
      {mode === "full" && <label className="print-hide-labs"><input type="checkbox" checked={hideLabs} onChange={(event) => setHideLabs(event.target.checked)} /> Hide labs on main index</label>}
      <label className="print-layout-select">Page layout<select value={layout} onChange={(event) => setLayout(event.target.value as PrintLayout)}>
        <option value="compact">Compact two-column</option>
        <option value="compact-references">Compact + cross-references</option>
        <option value="standard">Standard single-column</option>
      </select><small>{layout === "compact-references" ? "Full details print once under the primary keyword; secondary keywords point to that page." : layout === "compact" ? "Two columns with complete details repeated under every assigned keyword." : "Original single-column arrangement with oversized entries continued safely."}</small></label>
      <div className="preview-stats"><div><strong>{includedEntries.length}</strong><span>entries</span></div><div><strong>{document?.tocPages ?? "—"}</strong><span>TOC pages</span></div><div><strong>{document?.detailPages ?? "—"}</strong><span>detail pages</span></div><div><strong>{document?.totalPages ?? "—"}</strong><span>total pages</span></div></div>
      <div className="preview-actions">
        <button className="primary-button" disabled={action !== null} onClick={requestPrint}>{action === "print" ? "Preparing…" : "Print / Save PDF"}</button>
        <button className="secondary-button" disabled={action !== null} onClick={downloadHtml}>{action === "download" ? "Preparing…" : "Download standalone HTML"}</button>
        <button className="secondary-button" disabled={action !== null} onClick={refreshPreview}>{action === "update" ? "Updating…" : "Update preview"}</button>
      </div>
      <div className="print-tip"><strong>Print settings</strong><span>Letter · Scale 100% · Margins none · Background graphics on</span></div>
    </section>
    <section className="preview-stage">
      {document ? <>
        <div className="page-canvas" ref={pageCanvas} onScroll={updateActivePageFromScroll}><div className="preview-document">
          {document.pages.map((item, index) => <div className={`preview-page-frame ${index + 1 > renderedThrough ? "is-deferred" : ""}`} key={item.number} ref={(node) => {
            if (node) pageRefs.current.set(item.number, node); else pageRefs.current.delete(item.number);
          }}>{index + 1 <= renderedThrough && <PrintPageContent page={item} document={document} />}</div>)}
        </div></div>
        <form className="page-jump" onSubmit={(event) => { event.preventDefault(); jumpToPage(); }} aria-label="Jump to preview page">
          <label>Page <input aria-label="Page number" inputMode="numeric" value={pageInput} onChange={(event) => setPageInput(event.target.value)} onBlur={jumpToPage} /></label><span>of {document.totalPages}</span>
        </form>
      </> : <div className="preview-loading">Preparing preview…</div>}
    </section>
    {printDocument && <div className="print-host" aria-hidden="true">{printDocument.pages.map((item) => <PrintPageContent key={item.number} page={item} document={printDocument} />)}</div>}
  </div>;
}
