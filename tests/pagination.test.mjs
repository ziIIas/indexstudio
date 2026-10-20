import assert from "node:assert/strict";
import test from "node:test";
import { standaloneHtml } from "../src/exportHtml.ts";
import { buildPrintDocument } from "../src/pagination.ts";
import { entriesForPrintScope } from "../src/printScope.ts";

function fixtureEntry(id, overrides = {}) {
  const keyword = overrides.keyword ?? `keyword-${Number(id) % 7}`;
  return {
    id: String(id),
    keyword,
    primaryKeyword: overrides.primaryKeyword ?? keyword,
    keywords: overrides.keywords ?? [keyword],
    concept: overrides.concept ?? `Concept ${id} with enough words to exercise wrapping`,
    details: overrides.details ?? `Complete details for ${id}. `.repeat(9),
    detailsDocument: overrides.detailsDocument ?? null,
    bookNumber: overrides.bookNumber ?? "275.1",
    pageNumber: overrides.pageNumber ?? String(id),
    tags: [],
    status: "final",
    sourceRow: null,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function detailItems(document) {
  return document.pages
    .filter((page) => page.kind === "detail")
    .flatMap((page) => page.blocks.flatMap((block) => block.entries));
}

test("labs print separately in every layout and can be included in the full index", () => {
  const entries = [
    fixtureEntry(1, { concept: "Main only", keyword: "network" }),
    fixtureEntry(2, { concept: "Keyword lab", keyword: "network", keywords: ["network", " Labs "] }),
    fixtureEntry(3, { concept: "Workbook lab", bookNumber: "WORKBOOK SEC. 1" }),
    fixtureEntry(4, { concept: "Not a lab", keyword: "collaboration" }),
  ];
  const expected = { main: ["1", "4"], workbook: ["2", "3"], full: ["1", "2", "3", "4"] };
  for (const [scope, ids] of Object.entries(expected)) {
    const selected = entriesForPrintScope(entries, scope);
    assert.deepEqual(selected.map((entry) => entry.id), ids);
    for (const layout of ["standard", "compact", "compact-references"]) {
      const document = buildPrintDocument(selected, "Scope test", layout);
      const html = standaloneHtml(document);
      for (const entry of entries) {
        assert.equal(html.includes(entry.concept), ids.includes(entry.id), `${scope}/${layout}: ${entry.concept}`);
      }
    }
  }
});

test("labs use a full-width spacious TOC with correct page references and no section summary", () => {
  for (const layout of ["standard", "compact", "compact-references"]) {
    for (const count of [14, 45]) {
      const entries = Array.from({ length: count }, (_, index) => fixtureEntry(index + 1, { keyword: "labs", concept: `Lab exercise ${index + 1}` }));
      const document = buildPrintDocument(entries, "Labs", layout, { spaciousToc: true, hideSectionSummary: true });
      assert.equal(document.pages.some((page) => page.kind === "summary"), false);
      const toc = document.pages.filter((page) => page.kind === "toc");
      assert.equal(toc.flatMap((page) => page.rows).length, count);
      if (count === 14) assert.equal(toc.length, 1);
      else assert.ok(toc.length > 1);
      for (const page of toc) {
        assert.equal(page.spacious, true);
        assert.equal(page.columns, undefined);
        assert.equal(page.summaryRows, undefined);
        for (const row of page.rows) {
          const target = document.pages.find((candidate) => candidate.number === row.indexPage);
          assert.equal(target.kind, "detail");
          assert.ok(target.blocks.some((block) => block.entries.some((item) => item.entry.id === row.entry.id)));
        }
      }
      assert.ok(!standaloneHtml(document).includes("Sections (Keywords)"));
    }
  }
});

test("compact pagination retains every keyword appearance and reduces page count", () => {
  const entries = Array.from({ length: 180 }, (_, index) => fixtureEntry(index + 1, index % 5 === 0 ? {
    keyword: `keyword-${index % 7}`,
    primaryKeyword: `keyword-${index % 7}`,
    keywords: [`keyword-${index % 7}`, `secondary-${index % 4}`],
  } : {}));
  const standard = buildPrintDocument(entries, "Fixture index", "standard");
  const compact = buildPrintDocument(entries, "Fixture index", "compact");

  assert.ok(compact.totalPages < standard.totalPages);
  assert.ok(compact.tocPages < standard.tocPages);
  const expectedAppearances = entries.reduce((total, entry) => total + entry.keywords.length, 0);
  const actual = detailItems(compact);
  assert.equal(actual.length, expectedAppearances);
  assert.equal(actual.filter((item) => item.referenceKeyword).length, 0);
  assert.deepEqual(
    actual.map((item) => `${item.entry.id}:${item.keyword}`).sort(),
    entries.flatMap((entry) => entry.keywords.map((keyword) => `${entry.id}:${keyword}`)).sort(),
  );

  const primaryPages = new Map();
  for (const page of compact.pages.filter((candidate) => candidate.kind === "detail")) {
    for (const item of page.blocks.flatMap((block) => block.entries)) {
      if (item.keyword === item.entry.primaryKeyword) primaryPages.set(item.entry.id, page.number);
    }
  }
  for (const row of compact.pages.filter((page) => page.kind === "toc").flatMap((page) => page.rows)) {
    assert.equal(row.indexPage, primaryPages.get(row.entry.id));
  }
  assert.match(standaloneHtml(compact), /print-toc print-toc-paired/);
});

test("cross-reference layout renders full details once without dropping memberships", () => {
  const entries = [
    fixtureEntry("1", { keyword: "primary", primaryKeyword: "primary", keywords: ["primary", "secondary", "third"] }),
    fixtureEntry("2", { keyword: "only", primaryKeyword: "only", keywords: ["only"] }),
  ];
  const document = buildPrintDocument(entries, "Cross references", "compact-references");
  const items = detailItems(document);
  const full = items.filter((item) => !item.referenceKeyword);
  const references = items.filter((item) => item.referenceKeyword);

  assert.equal(items.length, 4);
  assert.equal(full.length, 2);
  assert.equal(references.length, 2);
  assert.deepEqual(references.map((item) => item.keyword).sort(), ["secondary", "third"]);
  const primaryPage = document.pages.find((page) => page.kind === "detail" && page.blocks.some((block) => block.entries.some((item) => item.entry.id === "1" && item.keyword === "primary")))?.number;
  assert.ok(primaryPage);
  assert.ok(references.every((item) => item.referenceKeyword === "primary" && item.referencePage === primaryPage));
  assert.ok(references.every((item) => item.entry.details === entries[0].details));
});

test("common ports entry moves intact beneath the final compact glossary", () => {
  const details = "Common Ports Reference:\n- Existing introduction.\n\nNumerical (low -> high):\n20 = FTP data\n443 = HTTPS\n\nAlphabetical (A -> Z):\nFTP data = 20\nHTTPS = 443\n";
  const commonPorts = fixtureEntry("ports", {
    keyword: "network",
    primaryKeyword: "network",
    keywords: ["network"],
    concept: "Common Ports List",
    details,
    detailsDocument: { version: 1, nodes: [{ type: "text", text: details }] },
  });
  const compact = buildPrintDocument([commonPorts, fixtureEntry("other")], "Ports index", "compact");
  const featuredPage = compact.pages.find((page) => page.kind === "summary" && page.featuredEntry?.id === commonPorts.id);

  assert.ok(featuredPage);
  assert.equal(featuredPage.number, compact.totalPages);
  assert.ok(!detailItems(compact).some((item) => item.entry.id === commonPorts.id));
  assert.equal(compact.pages.filter((page) => page.kind === "toc").flatMap((page) => page.rows).find((row) => row.entry.id === commonPorts.id)?.indexPage, featuredPage.number);
  const html = standaloneHtml(compact);
  assert.match(html, /print-common-ports/);
  assert.equal((html.match(/20 = FTP data/g) ?? []).length, 1);
  assert.equal((html.match(/FTP data = 20/g) ?? []).length, 1);

  const standard = buildPrintDocument([commonPorts], "Ports index", "standard");
  assert.ok(detailItems(standard).some((item) => item.entry.id === commonPorts.id));
});

test("wide images receive a full-width page and standalone HTML mirrors the page model", () => {
  const dataUrl = "data:image/png;base64,aGVsbG8=";
  const imageEntry = fixtureEntry("image", {
    keyword: "images",
    primaryKeyword: "images",
    keywords: ["images"],
    concept: "Wide image",
    details: "Image explanation",
    detailsDocument: {
      version: 1,
      nodes: [
        { type: "text", text: "Image explanation\n" },
        { type: "image", dataUrl, naturalWidth: 2400, naturalHeight: 400, lines: 10 },
      ],
    },
  });
  const document = buildPrintDocument([imageEntry, fixtureEntry("text")], "Image index", "compact");
  const fullWidthPage = document.pages.find((page) => page.kind === "detail" && page.fullWidth);
  assert.ok(fullWidthPage);
  assert.ok(fullWidthPage.blocks.some((block) => block.entries.some((item) => item.entry.id === "image")));

  const html = standaloneHtml(document);
  assert.equal((html.match(/<section class="print-page/g) ?? []).length, document.totalPages);
  assert.equal((html.match(/data:image\/png;base64,aGVsbG8=/g) ?? []).length, 1);
  assert.match(html, /detail-page-render is-compact is-full-width/);
  assert.match(html, /\.print-page\{margin:0;transform:none!important\}@page/);
  assert.match(html, /@media screen and \(max-width:850px\)/);
  assert.doesNotMatch(html, /collapsible|expand all|sticky keyword/i);
});

test("oversized full-width text splits without changing a character", () => {
  const details = Array.from({ length: 150 }, (_, index) => `Port ${index}: exact preserved explanation ${index}\n`).join("");
  const entry = fixtureEntry("long", {
    keyword: "network",
    primaryKeyword: "network",
    keywords: ["network"],
    concept: "Long ports list",
    details,
  });
  for (const layout of ["standard", "compact"]) {
    const document = buildPrintDocument([entry], "Long entry", layout);
    const fragments = detailItems(document).filter((item) => item.entry.id === "long");

    assert.ok(fragments.length > 1);
    assert.equal(fragments.map((item) => item.fragment?.details ?? "").join(""), details);
    assert.equal(fragments[0].fragment?.continued, false);
    assert.ok(fragments.slice(1).every((item) => item.fragment?.continued));
    if (layout === "compact") assert.ok(document.pages.filter((page) => page.kind === "detail" && page.blocks.some((block) => block.entries.some((item) => item.entry.id === "long"))).every((page) => !page.fullWidth));
    const tocRow = document.pages.find((page) => page.kind === "toc")?.rows[0];
    const firstDetailPage = document.pages.find((page) => page.kind === "detail" && page.blocks.some((block) => block.entries.some((item) => item.entry.id === "long")))?.number;
    assert.equal(tocRow?.indexPage, firstDetailPage);
  }
});

test("compact output embeds a small keyword summary without losing its rows", () => {
  const entries = Array.from({ length: 12 }, (_, index) => fixtureEntry(index + 1, { keyword: `section-${index % 3}`, primaryKeyword: `section-${index % 3}`, keywords: [`section-${index % 3}`] }));
  const standard = buildPrintDocument(entries, "Summary fixture", "standard");
  const compact = buildPrintDocument(entries, "Summary fixture", "compact");
  const embedded = compact.pages.find((page) => page.kind === "toc" && page.summaryRows?.length);

  assert.ok(standard.pages.some((page) => page.kind === "summary"));
  assert.ok(embedded);
  assert.ok(!compact.pages.some((page) => page.kind === "summary"));
  assert.deepEqual(embedded.summaryRows.map((row) => row.keyword).sort(), ["section-0", "section-1", "section-2"]);
});
