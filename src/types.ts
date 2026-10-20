export type ViewId = "add" | "overview" | "entries" | "preview" | "data" | "settings" | "api";

export type DetailImageLines = number;
export type DetailNode =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string; naturalWidth: number; naturalHeight: number; lines: DetailImageLines };
export interface DetailsDocument { version: 1; nodes: DetailNode[]; }

export interface Profile {
  id: string;
  code: string;
  displayName: string;
  printTitle: string;
  workbookLabel: string;
  starred: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileInput {
  code: string;
  displayName?: string;
  printTitle?: string;
  workbookLabel?: string;
  cloneFromId?: string;
}

export interface Entry {
  id: string;
  keyword: string;
  primaryKeyword: string;
  keywords: string[];
  concept: string;
  details: string;
  detailsDocument: DetailsDocument | null;
  bookNumber: string;
  pageNumber: string;
  tags: string[];
  status: "draft" | "review" | "final";
  sourceRow: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Note {
  id: string;
  body: string;
  createdAt: string;
  archivedAt: string | null;
}

export type EntryInput = Pick<
  Entry,
  "keyword" | "concept" | "details" | "detailsDocument" | "bookNumber" | "pageNumber" | "tags"
> & { keywords?: string[]; primaryKeyword?: string; status?: Entry["status"]; revision?: number };

export interface Book {
  id: string;
  number: string;
  label: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Keyword {
  id: string;
  name: string;
  aliases: string[];
  matchedAlias?: string | null;
  usage?: number;
  archived?: boolean;
  archivedAt?: string;
}

export interface Preferences {
  lastBookId: string | null;
  lastPageNumber: string;
  pagesByBook: Record<string, string>;
}

export interface BackupSettings {
  intervalMinutes: number;
  maxBackups: number;
  lastBackupAt: string | null;
}

export interface BackupPoint {
  filename: string;
  createdAt: string;
  size: number;
  kind: string;
}

export interface DashboardStatus {
  total: number;
  keywords: number;
  sources: number;
  missingDetails: number;
  collisionExtraRows: number;
  topKeywords: Array<{ label: string; count: number }>;
  sourceCounts: Array<{ label: string; count: number }>;
}

export interface Meta {
  keywords: string[];
  books: string[];
  bookOptions: Book[];
  preferences: Preferences;
}

export interface Health {
  ok: boolean;
  app: string;
  version: string;
  url: string;
  dataPath: string;
  offline: boolean;
  profile: Profile;
}

export interface ImportReport {
  format: "csv" | "json";
  headers: string[];
  missingHeaders: string[];
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  invalidRows: number;
  identityCollisionRows: number;
  importedRows: number;
  updatedRows?: number;
  invalid: Array<{ row: number; errors: string[] }>;
  preview: EntryInput[];
}

export interface ImportJob {
  id: string;
  filename: string;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  invalidRows: number;
  createdAt: string;
}

export interface TocRow {
  entry: Entry;
  indexPage: number;
}

export type PrintLayout = "standard" | "compact" | "compact-references";

export interface PrintDetailEntry {
  entry: Entry;
  keyword: string;
  referenceKeyword?: string;
  referencePage?: number;
  fragment?: {
    index: number;
    continued: boolean;
    details: string;
    detailsDocument: DetailsDocument | null;
  };
}

export interface DetailBlock {
  keyword: string;
  continuation: boolean;
  entries: PrintDetailEntry[];
}

export interface SummaryRow { keyword: string; page: number; }

export type PrintPage =
  | { kind: "toc"; number: number; rows: TocRow[]; columns?: TocRow[][]; summaryRows?: SummaryRow[]; spacious?: boolean; title: string }
  | { kind: "detail"; number: number; blocks: DetailBlock[]; columns?: DetailBlock[][]; fullWidth?: boolean; title: string }
  | { kind: "summary"; number: number; rows: SummaryRow[]; featuredEntry?: Entry; title: string };

export interface PrintDocument {
  title: string;
  layout: PrintLayout;
  generatedAt: string;
  pages: PrintPage[];
  tocPages: number;
  detailPages: number;
  totalPages: number;
}
