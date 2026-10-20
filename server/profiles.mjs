import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const now = () => new Date().toISOString();
const cleanCode = (value) => String(value ?? "").trim().toUpperCase();
const cleanText = (value) => String(value ?? "").trim();

function safeId(code, existing) {
  const base = code.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "class";
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function publicProfile(profile) {
  return {
    id: profile.id,
    code: profile.code,
    displayName: profile.displayName,
    printTitle: profile.printTitle,
    workbookLabel: profile.workbookLabel,
    starred: Boolean(profile.starred),
    archived: Boolean(profile.archived),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function createProfileManager({ dataDir, createStore }) {
  const registryPath = join(dataDir, "profiles.json");
  const profilesRoot = join(dataDir, "profiles");
  const stores = new Map();
  mkdirSync(profilesRoot, { recursive: true });

  const writeRegistry = () => writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  const defaultProfile = () => {
    const stamp = now();
    return {
      id: "my-index",
      code: "MY-INDEX",
      displayName: "My Index",
      printTitle: "My Index",
      workbookLabel: "Workbook Labs",
      starred: true,
      archived: false,
      createdAt: stamp,
      updatedAt: stamp,
    };
  };

  let registry;
  if (existsSync(registryPath)) {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } else {
    const profile = defaultProfile();
    registry = { version: 1, activeProfileId: profile.id, profiles: [profile] };
    const targetDataDir = join(profilesRoot, profile.id);
    const targetBackupDir = join(targetDataDir, "backups");
    mkdirSync(targetBackupDir, { recursive: true });
    const legacyDatabase = join(dataDir, "index.sqlite");
    if (existsSync(legacyDatabase)) copyFileSync(legacyDatabase, join(targetDataDir, "index.sqlite"));
    const legacyBackups = join(dataDir, "backups");
    if (existsSync(legacyBackups)) cpSync(legacyBackups, targetBackupDir, { recursive: true, force: false, errorOnExist: false });
    writeRegistry();
  }

  if (!Array.isArray(registry.profiles) || !registry.profiles.length) {
    const profile = defaultProfile();
    registry = { version: 1, activeProfileId: profile.id, profiles: [profile] };
    writeRegistry();
  }

  const find = (id) => registry.profiles.find((profile) => profile.id === id);
  const requireProfile = (id, { allowArchived = true } = {}) => {
    const profile = find(id);
    if (!profile) { const error = new Error("Profile not found."); error.statusCode = 404; throw error; }
    if (!allowArchived && profile.archived) { const error = new Error("Restore this profile before opening it."); error.statusCode = 409; throw error; }
    return profile;
  };
  const profilePaths = (id) => {
    requireProfile(id);
    const profileDataDir = join(profilesRoot, id);
    return { profileDataDir, profileBackupDir: join(profileDataDir, "backups") };
  };
  const getStore = (id = registry.activeProfileId) => {
    const profile = requireProfile(id, { allowArchived: false });
    if (!stores.has(profile.id)) {
      const { profileDataDir, profileBackupDir } = profilePaths(profile.id);
      stores.set(profile.id, createStore({
        dataDir: profileDataDir,
        backupDir: profileBackupDir,
        seedCsvPath: null,
      }));
    }
    return stores.get(profile.id);
  };

  const list = () => registry.profiles.map(publicProfile);
  const create = (payload = {}) => {
    const code = cleanCode(payload.code);
    if (!/^[A-Z0-9][A-Z0-9 ._-]{0,39}$/.test(code)) { const error = new Error("Class code must use 1–40 letters, numbers, spaces, dots, underscores or hyphens."); error.statusCode = 422; throw error; }
    if (!code) { const error = new Error("Class code is required."); error.statusCode = 422; throw error; }
    if (code.length > 40) { const error = new Error("Class code must be 40 characters or fewer."); error.statusCode = 422; throw error; }
    if (registry.profiles.some((profile) => profile.code.toLowerCase() === code.toLowerCase())) { const error = new Error("That class code already exists."); error.statusCode = 409; throw error; }
    const displayName = cleanText(payload.displayName) || code;
    const stamp = now();
    const id = safeId(code, new Set(registry.profiles.map((profile) => profile.id)));
    const profile = {
      id,
      code,
      displayName,
      printTitle: cleanText(payload.printTitle) || `${displayName} Master Index`,
      workbookLabel: cleanText(payload.workbookLabel) || "Workbook Labs",
      starred: Boolean(payload.starred),
      archived: false,
      createdAt: stamp,
      updatedAt: stamp,
    };
    registry.profiles.push(profile);
    const { profileDataDir, profileBackupDir } = profilePaths(id);
    mkdirSync(profileBackupDir, { recursive: true });
    if (payload.cloneFromId) {
      const source = getStore(String(payload.cloneFromId));
      const snapshot = source.createBackup("profile-clone");
      copyFileSync(snapshot.path, join(profileDataDir, "index.sqlite"));
    }
    getStore(id);
    writeRegistry();
    return publicProfile(profile);
  };

  const update = (id, payload = {}) => {
    const profile = requireProfile(id);
    if (payload.code !== undefined) {
      const code = cleanCode(payload.code);
      if (!/^[A-Z0-9][A-Z0-9 ._-]{0,39}$/.test(code)) { const error = new Error("Class code must use 1–40 letters, numbers, spaces, dots, underscores or hyphens."); error.statusCode = 422; throw error; }
    if (!code) { const error = new Error("Class code is required."); error.statusCode = 422; throw error; }
      if (registry.profiles.some((item) => item.id !== id && item.code.toLowerCase() === code.toLowerCase())) { const error = new Error("That class code already exists."); error.statusCode = 409; throw error; }
      profile.code = code;
    }
    if (payload.displayName !== undefined) profile.displayName = cleanText(payload.displayName) || profile.code;
    if (payload.printTitle !== undefined) profile.printTitle = cleanText(payload.printTitle) || `${profile.displayName} Master Index`;
    if (payload.workbookLabel !== undefined) profile.workbookLabel = cleanText(payload.workbookLabel) || "Workbook Labs";
    if (payload.starred !== undefined) profile.starred = Boolean(payload.starred);
    if (payload.archived !== undefined) {
      const archived = Boolean(payload.archived);
      if (archived && profile.id === registry.activeProfileId) { const error = new Error("Switch to another profile before archiving this one."); error.statusCode = 409; throw error; }
      if (archived && registry.profiles.filter((item) => !item.archived).length <= 1) { const error = new Error("At least one active profile is required."); error.statusCode = 409; throw error; }
      profile.archived = archived;
    }
    profile.updatedAt = now();
    writeRegistry();
    return publicProfile(profile);
  };

  const activate = (id) => {
    const profile = requireProfile(id, { allowArchived: false });
    registry.activeProfileId = profile.id;
    writeRegistry();
    return publicProfile(profile);
  };

  const resolve = (requested) => {
    const value = cleanText(requested) || registry.activeProfileId;
    const profile = registry.profiles.find((item) => item.id === value || item.code.toLowerCase() === value.toLowerCase());
    if (!profile) { const error = new Error("Profile not found."); error.statusCode = 404; throw error; }
    if (profile.archived) { const error = new Error("Restore this profile before opening it."); error.statusCode = 409; throw error; }
    return profile;
  };

  return {
    get activeProfileId() { return registry.activeProfileId; },
    list,
    create,
    update,
    activate,
    resolve,
    getStore,
    replaceStore(id, { alreadyClosed = false } = {}) {
      if (!alreadyClosed) stores.get(id)?.close();
      stores.delete(id);
      return getStore(id);
    },
    runScheduledBackups() {
      for (const profile of registry.profiles.filter((item) => !item.archived)) getStore(profile.id).runScheduledBackup();
    },
    close() {
      for (const store of stores.values()) store.close();
      stores.clear();
    },
  };
}
