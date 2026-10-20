import type { Entry } from "./types";

export type PrintScope = "full" | "main" | "workbook";

export function isLabEntry(entry: Entry): boolean {
  return [entry.keyword, entry.primaryKeyword, ...entry.keywords].some((keyword) => keyword.trim().toLowerCase() === "labs")
    || /^WORKBOOK/i.test(entry.bookNumber);
}

export function entriesForPrintScope(entries: Entry[], scope: PrintScope): Entry[] {
  if (scope === "full") return entries;
  return entries.filter((entry) => scope === "workbook" ? isLabEntry(entry) : !isLabEntry(entry));
}
