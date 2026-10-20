import type { DetailBlock, DetailNode, DetailsDocument, Entry, PrintDetailEntry, PrintDocument, PrintLayout, PrintPage, SummaryRow, TocRow } from "./types";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// Standard layout values are intentionally unchanged so the original output
// remains available as a reliable fallback.
const TOC_CAPACITY = 760;
const DETAIL_CAPACITY = 790;

// Compact pages use two independently paginated columns. These values leave a
// safety area above the absolutely positioned footer rather than relying on
// overflow:hidden to conceal a bad estimate.
// The footer already lives inside the page's bottom padding, so compact TOC
// rows only need a small clearance above it. This makes the visible bottom
// margin match the 46px top margin without allowing rows to touch the footer.
const COMPACT_TOC_CAPACITY = 952;
const COMPACT_DETAIL_CAPACITY = 1040;
const COMPACT_FULL_WIDTH_CAPACITY = 880;
const COMPACT_HEADER_COST = 30;
const COMPACT_COLUMN_IMAGE_WIDTH = 305;
const COMPACT_DETAIL_LINE_HEIGHT = 9.75;
const COMPACT_COLUMN_FRAGMENT_LINES = 88;
const FULL_WIDTH_FRAGMENT_LINES = 78;
const FULL_WIDTH_DETAIL_CHARACTERS = 105;

interface DetailDraft {
  blocks: DetailBlock[];
  columns?: DetailBlock[][];
  fullWidth?: boolean;
}

function lines(text: string, characters: number) {
  return Math.max(
    1,
    String(text || "")
      .split("\n")
      .reduce((count, part) => count + Math.max(1, Math.ceil(part.length / characters)), 0),
  );
}

function tocRowHeight(entry: Entry) {
  return 17 + Math.max(0, lines(entry.concept, 57) - 1) * 10;
}

function compactTocRowHeight(entry: Entry) {
  return 14 + Math.max(0, lines(entry.concept, 50) - 1) * 9;
}

function detailText(item: PrintDetailEntry) {
  return item.referenceKeyword
    ? `See full details under ${item.referenceKeyword}`
    : (item.fragment?.details ?? item.entry.details) || "No additional details";
}

function imageLines(item: PrintDetailEntry) {
  if (item.referenceKeyword) return 0;
  const document = item.fragment ? item.fragment.detailsDocument : item.entry.detailsDocument;
  return document?.nodes.reduce((total, node) => total + (node.type === "image" ? node.lines : 0), 0) ?? 0;
}

function entryHeight(item: PrintDetailEntry) {
  const conceptLines = lines(item.entry.concept, 70);
  const detailLines = lines(detailText(item), 102);
  return 12 + conceptLines * 10.5 + (detailLines + imageLines(item)) * 9.1;
}

function compactEntryHeight(item: PrintDetailEntry, fullWidth = false) {
  const conceptLines = lines(item.entry.concept, fullWidth ? 110 : 60);
  const detailLines = lines(detailText(item), fullWidth ? 150 : 82);
  return 10 + conceptLines * 10.8 + (detailLines + imageLines(item)) * COMPACT_DETAIL_LINE_HEIGHT;
}

function compactNeedsFullWidth(item: PrintDetailEntry) {
  if (item.referenceKeyword) return false;
  const document = item.fragment ? item.fragment.detailsDocument : item.entry.detailsDocument;
  return document?.nodes.some((node) => {
    if (node.type !== "image") return false;
    const desiredHeight = node.lines * COMPACT_DETAIL_LINE_HEIGHT;
    return desiredHeight * (node.naturalWidth / node.naturalHeight) > COMPACT_COLUMN_IMAGE_WIDTH;
  }) ?? false;
}

function splitOversizedCompactItem(item: PrintDetailEntry) {
  if (compactNeedsFullWidth(item) || compactEntryHeight(item) + COMPACT_HEADER_COST <= COMPACT_DETAIL_CAPACITY) return [item];
  return fragmentDetailItem(item, COMPACT_COLUMN_FRAGMENT_LINES, 82);
}

function estimatedTextLines(text: string, characters: number) {
  if (!text) return 0;
  return text.split("\n").reduce((count, part) => count + Math.max(1, Math.ceil(part.length / characters)), 0);
}

function splitTextForLines(text: string, maximumLines: number, characters: number) {
  if (!text) return [""];
  const lineTokens = text.match(/[^\n]*\n|[^\n]+$/g) ?? [text];
  const units: string[] = [];
  for (const token of lineTokens) {
    let remaining = token;
    while (estimatedTextLines(remaining, characters) > maximumLines) {
      const target = Math.max(characters, (maximumLines - 1) * characters);
      let cut = Math.min(target, remaining.length);
      const whitespace = Math.max(remaining.lastIndexOf(" ", cut), remaining.lastIndexOf("\t", cut));
      if (whitespace > Math.floor(cut * 0.6)) cut = whitespace + 1;
      units.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining) units.push(remaining);
  }

  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current && estimatedTextLines(current + unit, characters) > maximumLines) {
      chunks.push(current);
      current = unit;
    } else {
      current += unit;
    }
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

function splitDocumentForLines(document: DetailsDocument, maximumLines: number, characters: number): DetailsDocument[] {
  const fragments: DetailsDocument[] = [];
  let nodes: DetailNode[] = [];
  let used = 0;
  const flush = () => {
    if (nodes.length) fragments.push({ version: 1, nodes });
    nodes = [];
    used = 0;
  };

  for (const node of document.nodes) {
    if (node.type === "image") {
      if (nodes.length && used + node.lines > maximumLines) flush();
      nodes.push(node);
      used += node.lines;
      continue;
    }
    for (const text of splitTextForLines(node.text, maximumLines, characters)) {
      const cost = estimatedTextLines(text, characters);
      if (nodes.length && used + cost > maximumLines) flush();
      if (text) nodes.push({ type: "text", text });
      used += cost;
    }
  }
  flush();
  return fragments.length ? fragments : [{ version: 1, nodes: [] }];
}

function fragmentDetailItem(item: PrintDetailEntry, maximumLines: number, characters: number): PrintDetailEntry[] {
  const sourceDocument = item.fragment ? item.fragment.detailsDocument : item.entry.detailsDocument;
  const fragments: Array<{ details: string; detailsDocument: DetailsDocument | null }> = sourceDocument
    ? splitDocumentForLines(sourceDocument, maximumLines, characters).map((detailsDocument) => ({
      details: detailsDocument.nodes.map((node) => node.type === "text" ? node.text : "").join(""),
      detailsDocument,
    }))
    : splitTextForLines(detailText(item), maximumLines, characters).map((details) => ({ details, detailsDocument: null }));
  return fragments.map((fragment, index) => ({
    ...item,
    fragment: { index, continued: index > 0, ...fragment },
  }));
}

function splitFullWidthItem(item: PrintDetailEntry): PrintDetailEntry[] {
  if (compactEntryHeight(item, true) + COMPACT_HEADER_COST <= COMPACT_FULL_WIDTH_CAPACITY) return [item];
  return fragmentDetailItem(item, FULL_WIDTH_FRAGMENT_LINES, FULL_WIDTH_DETAIL_CHARACTERS);
}

function splitOversizedStandardItem(item: PrintDetailEntry) {
  if (entryHeight(item) + 34 <= DETAIL_CAPACITY) return [item];
  return fragmentDetailItem(item, FULL_WIDTH_FRAGMENT_LINES, 94);
}

function sourceRef(entry: Entry) {
  const workbook = entry.bookNumber.match(/^WORKBOOK SEC\.\s*(.+)$/i);
  return workbook ? `WB ${workbook[1]} ${entry.pageNumber}` : `${entry.bookNumber} ${entry.pageNumber}`;
}

export { sourceRef };

export function commonPortsParts(entry: Entry) {
  if (entry.concept.trim().toLocaleLowerCase() !== "common ports list") return null;
  const text = entry.detailsDocument?.nodes
    .filter((node): node is Extract<DetailNode, { type: "text" }> => node.type === "text")
    .map((node) => node.text)
    .join("") || entry.details;
  const numericalLabel = "Numerical (low -> high):";
  const alphabeticalLabel = "Alphabetical (A -> Z):";
  const numericalStart = text.indexOf(numericalLabel);
  const alphabeticalStart = text.indexOf(alphabeticalLabel);
  if (numericalStart < 0 || alphabeticalStart <= numericalStart) return null;
  return {
    intro: text.slice(0, numericalStart).trim(),
    numericalLabel,
    numerical: text.slice(numericalStart + numericalLabel.length, alphabeticalStart).trim(),
    alphabeticalLabel,
    alphabetical: text.slice(alphabeticalStart + alphabeticalLabel.length).trim(),
  };
}

function groupDetailEntries(entries: PrintDetailEntry[]) {
  const groups = new Map<string, PrintDetailEntry[]>();
  for (const item of [...entries].sort((a, b) => collator.compare(a.keyword, b.keyword) || collator.compare(a.entry.concept, b.entry.concept))) {
    const list = groups.get(item.keyword) ?? [];
    list.push(item);
    groups.set(item.keyword, list);
  }
  return groups;
}

function paginateDetails(entries: PrintDetailEntry[], deferredKeywords = new Set<string>()) {
  const groups = groupDetailEntries(entries);
  const pages: DetailDraft[] = [];
  const eligibleDeferrals: Array<{ keyword: string; strandedEntries: number }> = [];
  let blocks: DetailBlock[] = [];
  let used = 0;

  const flush = () => {
    if (blocks.length) pages.push({ blocks });
    blocks = [];
    used = 0;
  };

  for (const [keyword, groupEntries] of groups) {
    const costs = groupEntries.map((entry) => Math.min(entryHeight(entry), DETAIL_CAPACITY - 34));
    const wholeGroupCost = 34 + costs.reduce((total, cost) => total + cost, 0);
    const fitCount = () => {
      let remaining = DETAIL_CAPACITY - used - 34;
      let count = 0;
      for (const cost of costs) {
        if (cost > remaining) break;
        remaining -= cost;
        count += 1;
      }
      return count;
    };

    const wouldPlace = fitCount();
    const canDefer = blocks.length
      && wouldPlace > 0
      && wouldPlace < groupEntries.length
      && wholeGroupCost <= DETAIL_CAPACITY;
    if (canDefer) eligibleDeferrals.push({ keyword, strandedEntries: wouldPlace });
    if (canDefer && deferredKeywords.has(keyword)) flush();

    let continuation = false;
    let block: DetailBlock | null = null;
    for (const [entryIndex, entry] of groupEntries.entries()) {
      const headerCost = block ? 0 : 34;
      const cost = costs[entryIndex];
      if (blocks.length && used + headerCost + cost > DETAIL_CAPACITY) {
        flush();
        continuation = true;
        block = null;
      }
      if (!block) {
        block = { keyword, continuation, entries: [] };
        blocks.push(block);
        used += 34;
      }
      block.entries.push(entry);
      used += cost;
      if (cost >= DETAIL_CAPACITY - 34) {
        flush();
        continuation = true;
        block = null;
      }
    }
  }
  flush();
  return { pages, eligibleDeferrals };
}

function paginateDetailsWithSectionBalance(entries: PrintDetailEntry[]) {
  const compact = paginateDetails(entries);
  const maximumPages = Math.floor(compact.pages.length * 1.1);
  const deferred = new Set<string>();
  let current = compact;

  const fragmentScore = (pages: DetailDraft[]) => {
    const fragments = new Map<string, number[]>();
    for (const page of pages) {
      for (const block of page.blocks) {
        const counts = fragments.get(block.keyword) ?? [];
        counts.push(block.entries.length);
        fragments.set(block.keyword, counts);
      }
    }
    const score: number[] = [];
    for (const counts of fragments.values()) {
      if (counts.length < 2) continue;
      for (const count of counts) score[count] = (score[count] ?? 0) + 1;
    }
    return score;
  };
  const isBetterScore = (candidate: number[], baseline: number[]) => {
    const last = Math.max(candidate.length, baseline.length);
    for (let size = 1; size < last; size += 1) {
      const difference = (candidate[size] ?? 0) - (baseline[size] ?? 0);
      if (difference) return difference < 0;
    }
    return false;
  };

  while (true) {
    const currentScore = fragmentScore(current.pages);
    const attempts = current.eligibleDeferrals
      .filter(({ keyword }) => !deferred.has(keyword))
      .map(({ keyword, strandedEntries }, order) => {
        const next = new Set(deferred);
        next.add(keyword);
        const result = paginateDetails(entries, next);
        return { keyword, strandedEntries, order, result, score: fragmentScore(result.pages) };
      })
      .filter((attempt) => attempt.result.pages.length <= maximumPages && isBetterScore(attempt.score, currentScore))
      .sort((left, right) =>
        (isBetterScore(left.score, right.score) ? -1 : isBetterScore(right.score, left.score) ? 1 : 0)
        || left.strandedEntries - right.strandedEntries
        || left.result.pages.length - right.result.pages.length
        || left.order - right.order,
      );
    const best = attempts[0];
    if (!best) break;
    deferred.add(best.keyword);
    current = best.result;
  }
  return current.pages;
}

function paginateCompactDetails(entries: PrintDetailEntry[]) {
  const pages: DetailDraft[] = [];
  let columns: DetailBlock[][] = [[]];
  let used = [0];
  let columnIndex = 0;

  const hasContent = () => columns.some((column) => column.length > 0);
  const flush = () => {
    if (hasContent()) pages.push({ blocks: columns.flat(), columns });
    columns = [[]];
    used = [0];
    columnIndex = 0;
  };
  const advanceColumn = () => {
    if (columnIndex === 0) {
      columnIndex = 1;
      columns[1] = [];
      used[1] = 0;
    } else {
      flush();
    }
  };

  for (const [keyword, originalGroupEntries] of groupDetailEntries(entries)) {
    const groupEntries = originalGroupEntries.flatMap(splitOversizedCompactItem);
    let keywordStarted = false;
    let block: DetailBlock | null = null;

    for (const item of groupEntries) {
      if (compactNeedsFullWidth(item)) {
        if (hasContent()) flush();
        for (const fragment of splitFullWidthItem(item)) {
          const fullBlock: DetailBlock = { keyword, continuation: keywordStarted, entries: [fragment] };
          pages.push({ blocks: [fullBlock], columns: [[fullBlock]], fullWidth: true });
          keywordStarted = true;
        }
        block = null;
        continue;
      }

      const cost = compactEntryHeight(item);
      const headerCost = block ? 0 : COMPACT_HEADER_COST;
      if (columns[columnIndex].length && used[columnIndex] + headerCost + cost > COMPACT_DETAIL_CAPACITY) {
        advanceColumn();
        block = null;
      }
      if (!block) {
        block = { keyword, continuation: keywordStarted, entries: [] };
        columns[columnIndex].push(block);
        used[columnIndex] += COMPACT_HEADER_COST;
        keywordStarted = true;
      }
      block.entries.push(item);
      used[columnIndex] += cost;
    }
  }
  flush();
  return pages;
}

function paginateStandardToc(sortedEntries: Entry[], indexPages: Map<string, number>, title: string): PrintPage[] {
  const pages: PrintPage[] = [];
  let rows: TocRow[] = [];
  let used = 0;
  for (const entry of sortedEntries) {
    const cost = tocRowHeight(entry);
    if (rows.length && used + cost > TOC_CAPACITY) {
      pages.push({ kind: "toc", number: pages.length + 1, rows, title });
      rows = [];
      used = 0;
    }
    rows.push({ entry, indexPage: indexPages.get(entry.id) ?? 0 });
    used += cost;
  }
  if (rows.length) pages.push({ kind: "toc", number: pages.length + 1, rows, title });
  return pages;
}

function paginateCompactToc(sortedEntries: Entry[], indexPages: Map<string, number>, title: string): PrintPage[] {
  const virtualColumns: TocRow[][] = [];
  let rows: TocRow[] = [];
  let used = 0;
  for (const entry of sortedEntries) {
    const cost = compactTocRowHeight(entry);
    if (rows.length && used + cost > COMPACT_TOC_CAPACITY) {
      virtualColumns.push(rows);
      rows = [];
      used = 0;
    }
    rows.push({ entry, indexPage: indexPages.get(entry.id) ?? 0 });
    used += cost;
  }
  if (rows.length) virtualColumns.push(rows);

  const pages: PrintPage[] = [];
  for (let index = 0; index < virtualColumns.length; index += 2) {
    const columns = virtualColumns.slice(index, index + 2);
    pages.push({ kind: "toc", number: pages.length + 1, rows: columns.flat(), columns, title });
  }
  return pages;
}

function paginateSpaciousToc(sortedEntries: Entry[], indexPages: Map<string, number>, title: string): PrintPage[] {
  const pages: PrintPage[] = [];
  let rows: TocRow[] = [];
  let used = 0;
  const flush = () => {
    if (rows.length) pages.push({ kind: "toc", number: pages.length + 1, rows, title, spacious: true });
    rows = [];
    used = 0;
  };
  for (const entry of sortedEntries) {
    const cost = 24 + 20 * Math.max(lines(entry.concept, 45), lines(sourceRef(entry), 15));
    if (rows.length && used + cost > 880) flush();
    rows.push({ entry, indexPage: indexPages.get(entry.id) ?? 0 });
    used += cost;
  }
  flush();
  return pages;
}

function paginateToc(sortedEntries: Entry[], indexPages: Map<string, number>, title: string, layout: PrintLayout) {
  return layout === "standard"
    ? paginateStandardToc(sortedEntries, indexPages, title)
    : paginateCompactToc(sortedEntries, indexPages, title);
}

function detailEntries(active: Entry[], layout: PrintLayout): PrintDetailEntry[] {
  return active.flatMap((entry) => {
    const keywords = entry.keywords?.length ? entry.keywords : [entry.keyword];
    const primaryKeyword = keywords.includes(entry.primaryKeyword) ? entry.primaryKeyword : keywords[0];
    return keywords.map((keyword) => ({
      entry,
      keyword,
      referenceKeyword: layout === "compact-references" && keyword !== primaryKeyword ? primaryKeyword : undefined,
    }));
  });
}

function withReferencePages(block: DetailBlock, indexPages: Map<string, number>): DetailBlock {
  return {
    ...block,
    entries: block.entries.map((item) => item.referenceKeyword
      ? { ...item, referencePage: indexPages.get(item.entry.id) }
      : item),
  };
}

export function buildPrintDocument(entries: Entry[], title = "Master Index", layout: PrintLayout = "standard", options: { spaciousToc?: boolean; hideSectionSummary?: boolean } = {}): PrintDocument {
  const active = entries.filter((entry) => !entry.deletedAt);
  const featuredEntry = layout === "standard" ? undefined : active.find((entry) => commonPortsParts(entry));
  const printableDetails = detailEntries(featuredEntry ? active.filter((entry) => entry.id !== featuredEntry.id) : active, layout);
  const detailDrafts = layout === "standard"
    ? paginateDetailsWithSectionBalance(printableDetails.flatMap(splitOversizedStandardItem))
    : paginateCompactDetails(printableDetails);
  const sortedEntries = [...active].sort((a, b) => collator.compare(a.concept, b.concept));

  const buildToc = (indexPages: Map<string, number>) => options.spaciousToc
    ? paginateSpaciousToc(sortedEntries, indexPages, title)
    : paginateToc(sortedEntries, indexPages, title, layout);
  const tocPageCount = buildToc(new Map()).length;
  const featuredPageNumber = tocPageCount + detailDrafts.length + 1;
  const indexPages = new Map<string, number>();
  const primaryPagesAssigned = new Set<string>();
  const sectionPages = new Map<string, number>();
  detailDrafts.forEach((page, index) => {
    const pageNumber = tocPageCount + index + 1;
    for (const block of page.blocks) {
      if (!sectionPages.has(block.keyword)) sectionPages.set(block.keyword, pageNumber);
      for (const item of block.entries) {
        if (item.keyword === item.entry.primaryKeyword && !primaryPagesAssigned.has(item.entry.id)) {
          indexPages.set(item.entry.id, pageNumber);
          primaryPagesAssigned.add(item.entry.id);
        } else if (!indexPages.has(item.entry.id)) {
          indexPages.set(item.entry.id, pageNumber);
        }
      }
    }
  });
  if (featuredEntry) {
    indexPages.set(featuredEntry.id, featuredPageNumber);
    for (const keyword of featuredEntry.keywords?.length ? featuredEntry.keywords : [featuredEntry.keyword]) {
      if (!sectionPages.has(keyword)) sectionPages.set(keyword, featuredPageNumber);
    }
  }

  const tocPages = buildToc(indexPages);
  const detailPages: PrintPage[] = detailDrafts.map((page, index) => {
    const columns = page.columns?.map((column) => column.map((block) => withReferencePages(block, indexPages)));
    const blocks = columns?.flat() ?? page.blocks.map((block) => withReferencePages(block, indexPages));
    return {
      kind: "detail",
      number: tocPages.length + index + 1,
      blocks,
      columns,
      fullWidth: page.fullWidth,
      title,
    };
  });
  const summaryRows: SummaryRow[] = [...sectionPages.entries()]
    .map(([keyword, page]) => ({ keyword, page }))
    .sort((a, b) => collator.compare(a.keyword, b.keyword));

  let summaryPage: PrintPage | null = {
    kind: "summary",
    number: tocPages.length + detailPages.length + 1,
    rows: options.hideSectionSummary ? [] : summaryRows,
    featuredEntry,
    title,
  };
  if (options.hideSectionSummary && !featuredEntry) summaryPage = null;
  if (!options.hideSectionSummary && layout !== "standard" && !featuredEntry && summaryRows.length) {
    const lastToc = tocPages.at(-1);
    if (lastToc?.kind === "toc" && lastToc.columns?.length === 1 && 34 + summaryRows.length * 15 <= COMPACT_TOC_CAPACITY) {
      lastToc.summaryRows = summaryRows;
      summaryPage = null;
    }
  }

  const pages = [...tocPages, ...detailPages, ...(summaryPage ? [summaryPage] : [])];
  return {
    title,
    layout,
    generatedAt: new Date().toISOString(),
    pages,
    tocPages: tocPages.length,
    detailPages: detailPages.length,
    totalPages: pages.length,
  };
}
