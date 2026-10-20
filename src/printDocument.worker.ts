import { entriesForPrintScope } from "./printScope";
import { buildPrintDocument } from "./pagination";
import type { Entry, PrintLayout, Profile } from "./types";

type BuildRequest = {
  id: number;
  entries: Entry[];
  profile: Pick<Profile, "displayName" | "printTitle" | "workbookLabel">;
};

self.onmessage = ({ data }: MessageEvent<BuildRequest>) => {
  const workbookEntries = entriesForPrintScope(data.entries, "workbook");
  const mainEntries = entriesForPrintScope(data.entries, "main");
  const layouts: PrintLayout[] = ["standard", "compact", "compact-references"];
  self.postMessage({
    id: data.id,
    documents: Object.fromEntries(layouts.map((layout) => [layout, {
      main: buildPrintDocument(mainEntries, data.profile.printTitle, layout),
      full: buildPrintDocument(data.entries, data.profile.printTitle, layout),
      workbook: buildPrintDocument(workbookEntries, `${data.profile.displayName} ${data.profile.workbookLabel} Index`, layout, { spaciousToc: true, hideSectionSummary: true }),
    }])),
  });
};
