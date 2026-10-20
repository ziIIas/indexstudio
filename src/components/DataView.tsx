import { useEffect, useState } from "react";
import { api } from "../api";
import type { BackupPoint, BackupSettings, ImportJob, ImportReport } from "../types";

export function DataView({ onChanged, notify }: { onChanged: () => Promise<void>; notify: (message: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileContents, setFileContents] = useState("");
  const [pastedContents, setPastedContents] = useState("");
  const [importFormat, setImportFormat] = useState<"csv" | "json">("csv");
  const [updateExisting, setUpdateExisting] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [backupSettings, setBackupSettings] = useState<BackupSettings>({ intervalMinutes: 1440, maxBackups: 14, lastBackupAt: null });
  const [backupPoints, setBackupPoints] = useState<BackupPoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadJobs = () => api.importJobs().then((result) => setJobs(result.items)).catch(() => setJobs([]));
  const loadBackupPoints = () => api.backupPoints().then((result) => setBackupPoints(result.items)).catch(() => setBackupPoints([]));
  useEffect(() => { void loadJobs(); void loadBackupPoints(); void api.backupSettings().then(setBackupSettings).catch(() => undefined); }, []);

  const choose = async (selected: File | null) => {
    setFile(selected);
    setPastedContents("");
    setReport(null);
    setError("");
    setFileContents(selected ? await selected.text() : "");
  };
  const paste = (value: string) => {
    setFile(null);
    setFileContents("");
    setPastedContents(value);
    setReport(null);
    setError("");
  };
  const changeImportFormat = (format: "csv" | "json") => {
    setImportFormat(format);
    setUpdateExisting(false);
    setFile(null);
    setFileContents("");
    setPastedContents("");
    setReport(null);
    setError("");
  };
  const contents = file ? fileContents : pastedContents;
  const hasImportSource = Boolean(contents.trim());
  const importFile = (dryRun: boolean) => importFormat === "json"
    ? api.inspectJsonImport(contents, file?.name ?? "import.json", dryRun, updateExisting)
    : api.inspectImport(contents, file?.name ?? "import.csv", dryRun);
  const inspect = async () => {
    if (!hasImportSource) return;
    setBusy(true); setError("");
    try { setReport(await importFile(true)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not inspect this file."); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!hasImportSource) return;
    setBusy(true); setError("");
    try {
      const result = await importFile(false);
      setReport(result);
      notify(`Imported ${result.importedRows} new entries${result.updatedRows ? ` and updated ${result.updatedRows} existing entries` : ""}.`);
      await Promise.all([onChanged(), loadJobs(), loadBackupPoints()]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not import this file."); }
    finally { setBusy(false); }
  };
  const backup = async () => {
    setBusy(true);
    try { const result = await api.createBackup("manual"); await loadBackupPoints(); notify(`Backup created: ${result.filename}`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create a backup."); }
    finally { setBusy(false); }
  };
  const restore = async (point: BackupPoint) => {
    if (!window.confirm(`Restore ${point.filename}? The current database will first be backed up.`)) return;
    setBusy(true); setError("");
    try {
      const result = await api.restoreBackup(point.filename);
      await Promise.all([onChanged(), loadJobs(), loadBackupPoints()]);
      notify(`Restored ${result.restored}. Current data saved as ${result.safetyBackup.filename}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not restore this backup."); }
    finally { setBusy(false); }
  };
  const saveBackupSettings = async () => {
    setBusy(true); setError("");
    try {
      const saved = await api.updateBackupSettings(backupSettings);
      setBackupSettings(saved);
      notify(saved.intervalMinutes ? "Automatic backup settings saved." : "Automatic backups turned off.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save backup settings."); }
    finally { setBusy(false); }
  };

  return <div className="data-layout">
    <section className="panel import-panel">
      <div className="import-workflow">
        <div className="panel-heading"><div><h2>Import entries</h2></div></div>
        <p className="panel-copy">{importFormat === "csv" ? "Choose the six-column historical CSV. The app validates every row and shows a dry run before writing anything." : "Choose a complete JSON backup exported by Index Studio. Entries, multiple keywords, aliases, images, IDs, and timestamps are preserved."}</p>
        <label className="import-format">File type<select value={importFormat} disabled={busy} onChange={(event) => changeImportFormat(event.target.value as "csv" | "json")}><option value="csv">CSV</option><option value="json">JSON backup</option></select></label>
        <label className="drop-zone">
          <input type="file" accept={importFormat === "json" ? ".json,application/json" : ".csv,text/csv"} onChange={(event) => void choose(event.target.files?.[0] ?? null)} />
          <span className="drop-icon">{importFormat.toUpperCase()}</span>
          <strong>{file ? file.name : `Choose a ${importFormat === "json" ? "JSON backup" : "CSV"} file`}</strong>
          <small>{file ? `${(file.size / 1024).toFixed(1)} KiB ready to inspect` : importFormat === "json" ? "Use a file downloaded from Complete JSON backup." : "Multiline details and quoted fields are preserved."}</small>
        </label>
        <label className="paste-import">Or paste {importFormat === "json" ? "a complete JSON backup" : "CSV entries"}<textarea value={pastedContents} onChange={(event) => paste(event.target.value)} placeholder={importFormat === "json" ? '{"format":"index-studio-backup","version":3,...}' : "Keyword,Concept/Data,Additional Details,Book Number,Page Number,Keywords"} /></label>
        {importFormat === "json" && <label className="import-format"><input type="checkbox" checked={updateExisting} disabled={busy} onChange={(event) => { setUpdateExisting(event.target.checked); setReport(null); }} /> Update entries already in this backup</label>}
        <div className="import-actions"><button className="secondary-button" disabled={!hasImportSource || busy} onClick={() => void inspect()}>{busy ? "Checking…" : "Run dry check"}</button>{report && report.validRows > 0 && <button className="primary-button" disabled={busy || (report.format === "csv" && report.missingHeaders.length > 0)} onClick={() => void commit()}>{updateExisting && report.updatedRows ? `Import ${report.importedRows} new / update ${report.updatedRows}` : `Merge ${report.validRows} new entries`}</button>}</div>
        {error && <div className="form-error">{error}</div>}
        {report && <div className="import-report">
          <div><strong>{report.totalRows}</strong><span>source {report.format === "json" ? "entries" : "rows"}</span></div><div><strong>{report.validRows}</strong><span>{updateExisting && report.format === "json" ? "ready to import / update" : "new valid entries"}</span></div><div><strong>{report.duplicateRows}</strong><span>already imported</span></div><div><strong>{report.invalidRows}</strong><span>invalid entries</span></div>
          <p>{updateExisting && report.format === "json" ? `${report.updatedRows ?? 0} matching IDs will be updated from this backup.` : "Existing entries are never replaced."} {report.identityCollisionRows} additional entries share a concept/book/page identity and are preserved for review.</p>
        </div>}
      </div>
      <div className="import-history">
        <div className="panel-heading"><div><h2>Recent imports</h2></div></div>
        {jobs.length ? <div className="import-history-table"><table><thead><tr><th>File</th><th>Imported</th><th>Skipped</th><th>When</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td>{job.filename}</td><td>{job.importedRows}</td><td>{job.skippedRows}</td><td>{new Date(job.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div> : <div className="empty-state compact"><strong>No import history yet.</strong><span>Start by adding an entry or importing your own CSV or JSON file.</span></div>}
      </div>
    </section>

    <section className="panel export-panel">
      <div className="panel-heading"><div><h2>Export &amp; backup</h2></div></div>
      <div className="export-options">
        <a href={api.exportUrl("csv")} download><span>CSV</span><div><strong>Compatibility CSV</strong><small>Original six-column format</small></div></a>
        <a href={api.exportUrl("json")} download><span>JSON</span><div><strong>Complete JSON backup</strong><small>Records, IDs, and timestamps</small></div></a>
        <button onClick={() => void backup()} disabled={busy}><span>DB</span><div><strong>Create database backup</strong><small>Safe point before large changes</small></div></button>
      </div>
      <div className="safety-note"><strong>Automatic safety net</strong><span>A database backup is created before every committed CSV or JSON import.</span></div>
      <div className="backup-settings">
        <strong>Automatic database backups</strong>
        <label>How often<select value={backupSettings.intervalMinutes} onChange={(event) => setBackupSettings((current) => ({ ...current, intervalMinutes: Number(event.target.value) }))}><option value={0}>Off</option><option value={5}>Every 5 minutes</option><option value={10}>Every 10 minutes</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={45}>Every 45 minutes</option><option value={60}>Every hour</option><option value={360}>Every 6 hours</option><option value={720}>Every 12 hours</option><option value={1440}>Daily</option><option value={10080}>Weekly</option></select></label>
        <label>Keep at most<select value={backupSettings.maxBackups} onChange={(event) => setBackupSettings((current) => ({ ...current, maxBackups: Number(event.target.value) }))}><option value={3}>3 backups</option><option value={7}>7 backups</option><option value={14}>14 backups</option><option value={30}>30 backups</option><option value={60}>60 backups</option></select></label>
        <button className="secondary-button" disabled={busy} onClick={() => void saveBackupSettings()}>Save backup settings</button>
        <small>{backupSettings.intervalMinutes ? `Last automatic backup: ${backupSettings.lastBackupAt ? new Date(backupSettings.lastBackupAt).toLocaleString() : "not yet"}.` : "Automatic backups are off."}</small>
      </div>
      <div className="backup-points">
        <strong>Restore backup point</strong>
        {backupPoints.length ? <div>{backupPoints.map((point) => <div key={point.filename}><span><b>{point.kind.replaceAll("-", " ")}</b>{new Date(point.createdAt).toLocaleString()} · {(point.size / 1024 / 1024).toFixed(1)} MiB</span><button className="soft-button" disabled={busy} onClick={() => void restore(point)}>Restore</button></div>)}</div> : <small>No database backups yet.</small>}
      </div>
    </section>

  </div>;
}
