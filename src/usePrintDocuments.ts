import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry, PrintDocument, PrintLayout, Profile } from "./types";

import type { PrintScope } from "./printScope";

export type PrintScopeDocuments = Record<PrintScope, PrintDocument>;
export type PrintDocuments = Record<PrintLayout, PrintScopeDocuments>;
type Snapshot = { key: string; profileId: string; entries: Entry[]; profile: Profile };
type Cache = { key: string; profileId: string; documents: PrintDocuments };
type PendingJob = { key: string; resolve: (documents: PrintDocuments) => void; reject: (reason: unknown) => void };

function snapshotKey(entries: Entry[], profile: Profile) {
  return [
    profile.id,
    profile.displayName,
    profile.printTitle,
    profile.workbookLabel,
    ...entries.map((entry) => `${entry.id}:${entry.revision}:${entry.updatedAt}:${entry.deletedAt ?? ""}`),
  ].join("|");
}

export function usePrintDocuments(entries: Entry[], profile: Profile, enabled: boolean) {
  const [cache, setCache] = useState<Cache | null>(null);
  const cacheRef = useRef<Cache | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, PendingJob>());
  const jobsByKeyRef = useRef(new Map<string, Promise<PrintDocuments>>());
  const nextIdRef = useRef(1);

  const snapshot = useMemo<Snapshot>(() => ({
    key: snapshotKey(entries, profile),
    profileId: profile.id,
    entries,
    profile,
  }), [entries, profile]);
  const latestSnapshotRef = useRef(snapshot);
  latestSnapshotRef.current = snapshot;

  const setCached = useCallback((next: Cache) => {
    cacheRef.current = next;
    setCache(next);
  }, []);

  const build = useCallback((target: Snapshot, force = false) => {
    const existing = !force ? jobsByKeyRef.current.get(target.key) : undefined;
    if (existing) return existing;
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error("The print preview worker is not ready."));

    const id = nextIdRef.current++;
    const jobKey = force ? `${target.key}:${id}` : target.key;
    const job = new Promise<PrintDocuments>((resolve, reject) => {
      pendingRef.current.set(id, { key: jobKey, resolve, reject });
      worker.postMessage({
        id,
        entries: target.entries,
        profile: {
          displayName: target.profile.displayName,
          printTitle: target.profile.printTitle,
          workbookLabel: target.profile.workbookLabel,
        },
      });
    });
    jobsByKeyRef.current.set(jobKey, job);
    void job.then(
      () => jobsByKeyRef.current.delete(jobKey),
      () => jobsByKeyRef.current.delete(jobKey),
    );
    return job;
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("./printDocument.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = ({ data }: MessageEvent<{ id: number; documents: PrintDocuments }>) => {
      const pending = pendingRef.current.get(data.id);
      if (!pending) return;
      pendingRef.current.delete(data.id);
      const current = latestSnapshotRef.current;
      if (current.key === pending.key || pending.key.startsWith(`${current.key}:`)) {
        setCached({ key: current.key, profileId: current.profileId, documents: data.documents });
      }
      pending.resolve(data.documents);
    };
    worker.onerror = (event) => {
      const reason = event.error ?? new Error(event.message || "Could not prepare the print preview.");
      pendingRef.current.forEach(({ reject }) => reject(reason));
      pendingRef.current.clear();
      jobsByKeyRef.current.clear();
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
      pendingRef.current.forEach(({ reject }) => reject(new Error("The print preview worker stopped.")));
      pendingRef.current.clear();
      jobsByKeyRef.current.clear();
    };
  }, [setCached]);

  useEffect(() => {
    if (!enabled) return;
    if (cacheRef.current?.profileId !== snapshot.profileId) {
      cacheRef.current = null;
      setCache(null);
    }
    // Prepare the first preview right away. Later edits keep the last finished
    // version on screen until the five-minute refresh (or an explicit update).
    if (!cacheRef.current) void build(snapshot).catch(() => undefined);
  }, [build, enabled, setCached, snapshot]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      const current = latestSnapshotRef.current;
      if (!cacheRef.current || cacheRef.current.key !== current.key) void build(current).catch(() => undefined);
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [build, enabled]);

  const updateNow = useCallback(() => build(latestSnapshotRef.current, true), [build]);
  const currentDocument = useCallback(async (mode: PrintScope, layout: PrintLayout) => {
    const current = latestSnapshotRef.current;
    if (cacheRef.current?.key === current.key) return cacheRef.current.documents[layout][mode];
    return (await build(current))[layout][mode];
  }, [build]);

  return {
    documents: cache?.profileId === profile.id ? cache.documents : null,
    updateNow,
    currentDocument,
  };
}
