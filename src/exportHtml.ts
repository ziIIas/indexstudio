import { commonPortsParts, sourceRef } from "./pagination.ts";
import type { DetailBlock, Entry, PrintDetailEntry, PrintDocument, PrintLayout, PrintPage, SummaryRow, TocRow } from "./types";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function tocMarkup(rows: TocRow[]) {
  return `<table class="print-toc"><thead><tr><th>Concept/Data</th><th>Book page</th><th>Index page</th></tr></thead><tbody>${rows
    .map(({ entry, indexPage }) => `<tr><td>${escapeHtml(entry.concept)}</td><td>${escapeHtml(sourceRef(entry))}</td><td>${indexPage}</td></tr>`)
    .join("")}</tbody></table>`;
}

function pairedTocMarkup(columns: TocRow[][]) {
  const [left, right] = columns;
  const rows = Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
    const leftRow = left[index];
    const rightRow = right[index];
    return `<tr><td>${escapeHtml(leftRow?.entry.concept)}</td><td>${leftRow ? escapeHtml(sourceRef(leftRow.entry)) : ""}</td><td>${leftRow?.indexPage ?? ""}</td><td class="toc-spacer"></td><td>${escapeHtml(rightRow?.entry.concept)}</td><td>${rightRow ? escapeHtml(sourceRef(rightRow.entry)) : ""}</td><td>${rightRow?.indexPage ?? ""}</td></tr>`;
  }).join("");
  return `<table class="print-toc print-toc-paired"><colgroup><col><col><col><col><col><col><col></colgroup><thead><tr><th>Concept/Data</th><th>Book page</th><th>Index page</th><th class="toc-spacer"></th><th>Concept/Data</th><th>Book page</th><th>Index page</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function commonPortsMarkup(entry: Entry) {
  const parts = commonPortsParts(entry);
  if (!parts) return "";
  return `<div class="print-common-ports"><div class="print-common-ports-heading"><h2>${escapeHtml(entry.concept)}</h2><span>${escapeHtml(sourceRef(entry))}</span></div><p class="print-common-ports-intro">${escapeHtml(parts.intro)}</p><div class="print-common-ports-columns"><section><h3>${escapeHtml(parts.numericalLabel)}</h3><pre>${escapeHtml(parts.numerical)}</pre></section><section><h3>${escapeHtml(parts.alphabeticalLabel)}</h3><pre>${escapeHtml(parts.alphabetical)}</pre></section></div></div>`;
}

function summaryMarkup(rows: SummaryRow[], embedded = false) {
  return `<div class="${embedded ? "print-summary-embedded" : "print-summary"}">${embedded ? "<h2>Sections (Keywords)</h2>" : ""}${rows
    .map((row) => `<div><span>${escapeHtml(row.keyword)}</span><strong>${row.page}</strong></div>`)
    .join("")}</div>`;
}

function detailsMarkup(item: PrintDetailEntry) {
  if (item.referenceKeyword) {
    return `<p class="print-cross-reference">See full details under <b>${escapeHtml(item.referenceKeyword)}</b>${item.referencePage ? `, index page ${item.referencePage}` : ""}.</p>`;
  }
  const detailsDocument = item.fragment ? item.fragment.detailsDocument : item.entry.detailsDocument;
  const details = (item.fragment?.details ?? item.entry.details) || "No additional details";
  if (!detailsDocument?.nodes.length) return `<p>${escapeHtml(details)}</p>`;
  return `<p>${detailsDocument.nodes.map((node) => node.type === "text"
    ? escapeHtml(node.text)
    : `<img src="${escapeHtml(node.dataUrl)}" alt="Pasted detail" style="height:${node.lines * 1.2}em;width:auto">`).join("")}</p>`;
}

function detailBlocksMarkup(blocks: DetailBlock[], compact: boolean) {
  return blocks.map((block) => `<div class="print-section"><h2>${escapeHtml(block.keyword)}${block.continuation ? " <small>continued</small>" : ""}</h2>${block.entries
    .map((item) => `<article>${compact
      ? `<div class="print-entry-heading"><h3>${escapeHtml(item.entry.concept)}${item.fragment?.continued ? " <small>(continued)</small>" : ""}</h3><div class="print-reference">${escapeHtml(sourceRef(item.entry))}</div></div>`
      : `<div class="print-reference">${escapeHtml(sourceRef(item.entry))}</div><h3>${escapeHtml(item.entry.concept)}${item.fragment?.continued ? " <small>(continued)</small>" : ""}</h3>`}${detailsMarkup(item)}</article>`)
    .join("")}</div>`).join("");
}

function pageMarkup(page: PrintPage, layout: PrintLayout) {
  const compact = layout !== "standard";
  if (page.kind === "toc") {
    const content = compact && page.columns?.length === 2
      ? pairedTocMarkup(page.columns)
      : compact && page.columns
      ? `<div class="print-toc-columns">${page.columns.map((rows) => `<div class="print-toc-column">${tocMarkup(rows)}</div>`).join("")}${page.summaryRows ? summaryMarkup(page.summaryRows, true) : ""}</div>`
      : tocMarkup(page.rows);
    return `<section class="print-page toc-page-render${compact ? " is-compact" : ""}${page.spacious ? " is-spacious" : ""}">${content}<footer>${page.number}</footer></section>`;
  }
  if (page.kind === "detail") {
    const content = compact && page.columns
      ? `<div class="print-detail-columns">${page.columns.map((blocks) => `<div class="print-detail-column">${detailBlocksMarkup(blocks, true)}</div>`).join("")}</div>`
      : detailBlocksMarkup(page.blocks, false);
    return `<section class="print-page detail-page-render${compact ? " is-compact" : ""}${page.fullWidth ? " is-full-width" : ""}">${content}<footer>${page.number}</footer></section>`;
  }
  return `<section class="print-page summary-page-render${compact ? " is-compact" : ""}">${summaryMarkup(page.rows)}${page.featuredEntry ? commonPortsMarkup(page.featuredEntry) : ""}<footer>${page.number}</footer></section>`;
}

export function standaloneHtml(document: PrintDocument) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(document.title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#dfe3e8;color:#253047;font-family:Arial,Helvetica,sans-serif}.print-page{position:relative;width:816px;height:1056px;margin:18px auto;padding:46px 56px 38px;background:#fff;overflow:hidden;break-after:page}.print-page footer{position:absolute;left:0;right:0;bottom:15px;color:#747d8d;text-align:center;font-size:9px}
.print-toc{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8.3px}.print-toc th{padding:5px 7px;color:#fff;background:#74818e;text-align:left;font-size:7.4px;text-transform:uppercase;letter-spacing:.08em}.print-toc th:nth-child(1){width:68%}.print-toc th:nth-child(2){width:19%}.print-toc th:nth-child(3){width:13%}.print-toc td{padding:3px 7px;border-bottom:1px solid #e7ebef;line-height:1.2;vertical-align:middle}.print-toc td:first-child{color:#2c3e50;font-weight:700}.print-toc td:nth-child(2){color:#a85f55;text-align:center;font-weight:700}.print-toc td:nth-child(3){color:#637366;text-align:center;font-weight:700}.print-toc tr:nth-child(even){background:#f8f9fa}
.print-section{margin-bottom:14px}.print-section h2{margin:0 0 7px;padding:0 0 4px;color:#26364d;border-bottom:2px solid #74818e;font-size:12px;letter-spacing:.08em;text-transform:uppercase}.print-section h2 small{color:#8490a1;font-size:7px;text-transform:none;letter-spacing:0}.print-section article{position:relative;margin:0 0 6px;padding-left:6px;break-inside:avoid}.print-section h3{margin:0 105px 1px 0;color:#637366;font-size:8.7px;line-height:1.2}.print-section h3 small{color:#8490a1;font-size:7px;font-weight:500}.print-section p{margin:0 95px 0 0;color:#3d4a60;font-size:7.55px;line-height:1.2;white-space:pre-line}.print-section p img{display:inline-block;max-width:100%;object-fit:contain;vertical-align:bottom;margin:2px 4px}.print-reference{float:right;max-width:100px;color:#a85f55;text-align:right;font-size:7.4px;font-weight:700}
.print-summary{columns:2;column-gap:34px}.print-summary>div{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dotted #a9b0ba;break-inside:avoid;font-size:8px}.print-summary strong{color:#637366}
.print-toc-columns,.print-detail-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:18px}.print-toc-column,.print-detail-column{min-width:0}.toc-page-render.is-compact .print-toc{font-size:7.7px}.toc-page-render.is-compact .print-toc th{padding:4px 3px;font-size:6.5px;letter-spacing:.03em}.toc-page-render.is-compact .print-toc th:nth-child(1){width:62%}.toc-page-render.is-compact .print-toc th:nth-child(2){width:24%}.toc-page-render.is-compact .print-toc th:nth-child(3){width:14%}.toc-page-render.is-compact .print-toc td{padding:1.9px 3px;line-height:1.16;overflow-wrap:anywhere}.toc-page-render.is-compact .print-toc-paired col:nth-child(1),.toc-page-render.is-compact .print-toc-paired col:nth-child(5){width:30%}.toc-page-render.is-compact .print-toc-paired col:nth-child(2),.toc-page-render.is-compact .print-toc-paired col:nth-child(6){width:11.5%}.toc-page-render.is-compact .print-toc-paired col:nth-child(3),.toc-page-render.is-compact .print-toc-paired col:nth-child(7){width:7%}.toc-page-render.is-compact .print-toc-paired col:nth-child(4){width:3%}.toc-page-render.is-compact .print-toc-paired th:nth-child(1),.toc-page-render.is-compact .print-toc-paired th:nth-child(5){width:30%}.toc-page-render.is-compact .print-toc-paired th:nth-child(2),.toc-page-render.is-compact .print-toc-paired th:nth-child(6){width:11.5%}.toc-page-render.is-compact .print-toc-paired th:nth-child(3),.toc-page-render.is-compact .print-toc-paired th:nth-child(7){width:7%}.toc-page-render.is-compact .print-toc-paired th:nth-child(4){width:3%}.print-toc-paired td:nth-child(5){color:#2c3e50;font-weight:700}.print-toc-paired td:nth-child(6){color:#a85f55;text-align:center;font-weight:700}.print-toc-paired td:nth-child(7){color:#637366;text-align:center;font-weight:700}.print-toc-paired .toc-spacer{padding:0;border:0;background:#fff}
.print-common-ports{margin-top:10px;padding-top:8px;border-top:2px solid #74818e}.print-common-ports-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.print-common-ports-heading h2{margin:0;color:#26364d;font-size:12px;letter-spacing:.06em;text-transform:uppercase}.print-common-ports-heading span{color:#a85f55;font-size:8px;font-weight:700}.print-common-ports-intro{margin:4px 0 7px;color:#3d4a60;font-size:8px;line-height:1.2;white-space:pre-line}.print-common-ports-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}.print-common-ports-columns section{min-width:0}.print-common-ports-columns h3{margin:0 0 3px;padding-bottom:3px;color:#637366;border-bottom:1px solid #cbd1d7;font-size:8.5px}.print-common-ports-columns pre{margin:0;color:#3d4a60;font:8.7px/1.24 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre}
.detail-page-render.is-compact .print-section{margin-bottom:9px}.detail-page-render.is-compact .print-section h2{margin-bottom:5px;padding-bottom:3px;border-bottom-width:1.5px;font-size:10.2px}.detail-page-render.is-compact .print-section h2 small{font-size:6.8px}.detail-page-render.is-compact .print-section article{margin-bottom:4px;padding-left:3px}.detail-page-render.is-compact .print-entry-heading{display:flex;align-items:baseline;justify-content:space-between;gap:7px;margin-bottom:1px}.detail-page-render.is-compact .print-section h3{min-width:0;margin:0;font-size:8.9px;line-height:1.2}.detail-page-render.is-compact .print-reference{float:none;flex:0 0 auto;max-width:112px;font-size:7.2px;white-space:nowrap}.detail-page-render.is-compact .print-section p{margin:0;font-size:8.1px;line-height:1.2;overflow-wrap:anywhere}.detail-page-render.is-compact .print-section p img{max-width:100%;object-fit:contain}.detail-page-render.is-compact .print-cross-reference{color:#657087;font-style:italic}.detail-page-render.is-compact .print-cross-reference b{color:#46526a}.detail-page-render.is-full-width .print-detail-columns{grid-template-columns:minmax(0,1fr)}.detail-page-render.is-full-width .print-section p{font-size:8.4px}.detail-page-render.is-full-width .print-section p img{max-width:100%}
.print-summary-embedded{min-width:0}.print-summary-embedded h2{margin:0 0 6px;padding-bottom:4px;border-bottom:1.5px solid #74818e;color:#26364d;font-size:10.2px;letter-spacing:.06em;text-transform:uppercase}.print-summary-embedded>div,.summary-page-render.is-compact .print-summary>div{display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px dotted #a9b0ba;break-inside:avoid;font-size:7.7px}.print-summary-embedded strong,.summary-page-render.is-compact .print-summary strong{color:#637366}.summary-page-render.is-compact .print-summary{columns:3;column-gap:24px}
@media print{body{background:#fff}.print-page{margin:0;transform:none!important}@page{size:letter;margin:0}}@media screen and (max-width:850px){.print-page{transform-origin:top left;transform:scale(.72);margin-bottom:-2.9in}}

.toc-page-render.is-spacious .print-toc { height: 940px; font-size: 14px; }
.toc-page-render.is-spacious .print-toc th { height: 44px; padding: 12px 10px; font-size: 12px; }
.toc-page-render.is-spacious .print-toc td { padding: 12px 10px; line-height: 20px; overflow-wrap: anywhere; }
.toc-page-render.is-spacious .print-toc th:nth-child(1) { width: 62%; }
.toc-page-render.is-spacious .print-toc th:nth-child(2) { width: 24%; }
.toc-page-render.is-spacious .print-toc th:nth-child(3) { width: 14%; }
</style></head><body>${document.pages.map((page) => pageMarkup(page, document.layout)).join("")}</body></html>`;
}

export function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
