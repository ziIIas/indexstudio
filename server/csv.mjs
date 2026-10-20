import { createHash } from "node:crypto";

export const HISTORICAL_HEADERS = [
  "Keyword",
  "Concept/Data",
  "Additional Details",
  "Book Number",
  "Page Number",
  "Keywords",
];

export function parseCsv(input) {
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  const matrix = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) matrix.push(row);
      row = [];
      field = "";
    } else {
      field += char === "\r" && quoted ? "\n" : char;
    }
  }

  row.push(field);
  if (row.some((value) => value.length > 0)) matrix.push(row);
  if (matrix.length === 0) return { headers: [], rows: [] };

  const headers = matrix[0].map((value) => value.trim());
  const rows = matrix.slice(1).map((values, rowIndex) => {
    const record = { __rowNumber: rowIndex + 2 };
    headers.forEach((header, columnIndex) => {
      record[header] = values[columnIndex] ?? "";
    });
    return record;
  });
  return { headers, rows };
}

export function mapHistoricalRow(row) {
  return {
    keyword: String(row.Keyword ?? "").trim(),
    concept: String(row["Concept/Data"] ?? "").trim(),
    details: String(row["Additional Details"] ?? "").trim().replace(/\r\n?/g, "\n"),
    bookNumber: String(row["Book Number"] ?? "").trim(),
    pageNumber: String(row["Page Number"] ?? "").trim(),
    tags: String(row.Keywords ?? "")
      .split(/[,;]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    sourceRow: Number(row.__rowNumber) || null,
  };
}

export function validateHistoricalHeaders(headers) {
  return HISTORICAL_HEADERS.filter((header) => !headers.includes(header));
}

export function normalizeEntry(entry) {
  return {
    keyword: String(entry.keyword ?? "").trim(),
    concept: String(entry.concept ?? "").trim(),
    details: String(entry.details ?? "").trim().replace(/\r\n?/g, "\n"),
    detailsDocument: entry.detailsDocument ?? null,
    bookNumber: String(entry.bookNumber ?? "").trim(),
    pageNumber: String(entry.pageNumber ?? "").trim(),
    tags: Array.isArray(entry.tags)
      ? [...new Set(entry.tags.map((value) => String(value).trim()).filter(Boolean))]
      : String(entry.tags ?? "")
          .split(/[,;]+/)
          .map((value) => value.trim())
          .filter(Boolean),
    status: ["draft", "review", "final"].includes(entry.status) ? entry.status : "draft",
  };
}

export function validateEntry(entry) {
  const errors = [];
  if (!entry.keyword) errors.push("Keyword is required.");
  if (!entry.concept) errors.push("Concept/Data is required.");
  if (!entry.bookNumber) errors.push("Book Number is required.");
  if (!entry.pageNumber) errors.push("Page Number is required.");
  if (!Array.isArray(entry.tags)) errors.push("Tags must be an array.");
  return errors;
}

export function fingerprintEntry(entry) {
  const payload = [
    entry.keyword,
    entry.concept,
    entry.details,
    entry.bookNumber,
    entry.pageNumber,
    [...entry.tags].sort(),
  ];
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function quoteCsv(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function stringifyHistoricalCsv(entries) {
  const lines = [HISTORICAL_HEADERS.map(quoteCsv).join(",")];
  for (const entry of entries) {
    lines.push(
      [
        entry.keyword,
        entry.concept,
        entry.details,
        entry.bookNumber,
        entry.pageNumber,
        (entry.tags ?? []).join(", "),
      ]
        .map(quoteCsv)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
