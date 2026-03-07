import fs from 'fs';
import path from 'path';

const DEFAULT_STATE_DIR = '/opt/hunter/state';
const DEFAULT_LEGACY_DB = '/opt/hunter/dev.db';

let databaseWarningPrinted = false;
let uploadsWarningPrinted = false;
let assetsWarningPrinted = false;

function warnOnce(kind: 'db' | 'uploads' | 'assets', message: string): void {
  if (kind === 'db' && databaseWarningPrinted) return;
  if (kind === 'uploads' && uploadsWarningPrinted) return;
  if (kind === 'assets' && assetsWarningPrinted) return;
  if (kind === 'db') databaseWarningPrinted = true;
  if (kind === 'uploads') uploadsWarningPrinted = true;
  if (kind === 'assets') assetsWarningPrinted = true;
  console.warn(`[hunter-state] ${message}`);
}

function normalizeFileDatabaseUrl(input: string, baseDir: string): { url: string; absolutePath: string } | null {
  const raw = String(input || '').trim();
  if (!raw.toLowerCase().startsWith('file:')) return null;
  const filePathRaw = raw.slice('file:'.length).trim();
  if (!filePathRaw) return null;
  const absolutePath = path.isAbsolute(filePathRaw) ? filePathRaw : path.resolve(baseDir, filePathRaw);
  return { url: `file:${absolutePath}`, absolutePath };
}

function firstExistingFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore candidate
    }
  }
  return null;
}

export function getStateRootDir(): string {
  return String(process.env.HUNTER_STATE_DIR || '').trim() || DEFAULT_STATE_DIR;
}

export function getStateDbPath(): string {
  return String(process.env.HUNTER_STATE_DB_PATH || '').trim() || path.join(getStateRootDir(), 'dev.db');
}

export function getStateUploadsPath(): string {
  return String(process.env.HUNTER_STATE_UPLOADS_PATH || '').trim() || path.join(getStateRootDir(), 'uploads');
}

export function getStateAssetsPath(): string {
  const configured = String(process.env.HUNTER_ASSETS_DIR || process.env.HUNTER_WORKSPACE_ASSETS_DIR || '').trim();
  if (!configured) return path.join(getStateRootDir(), 'assets');
  const normalized = path.resolve(configured);
  // Compatibilidad: ruta legacy que suele fallar por permisos en PROD.
  if (normalized.startsWith('/var/lib/hunter')) {
    warnOnce('assets', `Assets legacy (${normalized}) detectado. Se usará ${path.join(getStateRootDir(), 'assets')}.`);
    return path.join(getStateRootDir(), 'assets');
  }
  return configured;
}

export function getLegacyUploadsPath(): string {
  return path.resolve(process.cwd(), 'uploads');
}

export function getLegacyAssetsPath(): string {
  return '/var/lib/hunter/assets';
}

/**
 * Ensures DATABASE_URL points to an existing SQLite file.
 * Priority:
 * 1) Existing explicit DATABASE_URL file path.
 * 2) /opt/hunter/state/dev.db
 * 3) Legacy paths (../dev.db, ./dev.db, /opt/hunter/dev.db)
 */
export function ensureDatabaseUrlForRuntime(): string {
  const cwd = process.cwd();
  const configured = String(process.env.DATABASE_URL || '').trim();
  const stateDb = getStateDbPath();

  const configuredFile = normalizeFileDatabaseUrl(configured, cwd);
  if (configuredFile && fs.existsSync(configuredFile.absolutePath)) {
    if (configuredFile.absolutePath !== stateDb && fs.existsSync(stateDb)) {
      process.env.DATABASE_URL = `file:${stateDb}`;
      warnOnce(
        'db',
        `DATABASE_URL legacy (${configuredFile.absolutePath}) detectado. Se usará state DB ${stateDb}.`,
      );
      return process.env.DATABASE_URL;
    }
    process.env.DATABASE_URL = configuredFile.url;
    return process.env.DATABASE_URL;
  }

  if (fs.existsSync(stateDb)) {
    process.env.DATABASE_URL = `file:${stateDb}`;
    warnOnce('db', `DATABASE_URL no válido o inexistente. Fallback a state DB ${stateDb}.`);
    return process.env.DATABASE_URL;
  }

  const legacy = firstExistingFile([
    path.resolve(cwd, '../dev.db'),
    path.resolve(cwd, './dev.db'),
    DEFAULT_LEGACY_DB,
  ]);
  if (legacy) {
    process.env.DATABASE_URL = `file:${legacy}`;
    warnOnce('db', `State DB no encontrado. Fallback temporal a ruta legacy ${legacy}.`);
    return process.env.DATABASE_URL;
  }

  if (configuredFile) {
    process.env.DATABASE_URL = configuredFile.url;
    warnOnce('db', `No se encontró state DB ni legacy DB. Se mantiene DATABASE_URL=${configuredFile.url}.`);
    return process.env.DATABASE_URL;
  }

  return configured;
}

export function resolveUploadsBaseDir(): string {
  const stateUploads = getStateUploadsPath();
  if (fs.existsSync(stateUploads)) return stateUploads;

  const legacyUploads = getLegacyUploadsPath();
  if (fs.existsSync(legacyUploads)) {
    warnOnce(
      'uploads',
      `Directorio state/uploads no existe. Fallback temporal a uploads legacy ${legacyUploads}.`,
    );
    return legacyUploads;
  }

  return stateUploads;
}

export function resolveAssetsBaseDir(): string {
  const stateAssets = getStateAssetsPath();
  if (fs.existsSync(stateAssets)) return stateAssets;

  const legacyAssets = getLegacyAssetsPath();
  if (fs.existsSync(legacyAssets)) {
    warnOnce(
      'assets',
      `Directorio state/assets no existe. Fallback temporal a assets legacy ${legacyAssets}.`,
    );
    return legacyAssets;
  }

  return stateAssets;
}

export function resolveMediaPathCandidates(mediaPath: string): string[] {
  const raw = String(mediaPath || '').trim();
  if (!raw) return [];
  const candidates = new Set<string>();
  if (path.isAbsolute(raw)) candidates.add(raw);
  candidates.add(path.resolve(process.cwd(), raw));
  candidates.add(path.resolve(path.join(__dirname, '..'), raw));
  candidates.add(path.resolve(process.cwd(), 'dist', raw));

  const uploadsBase = resolveUploadsBaseDir();
  candidates.add(path.resolve(uploadsBase, raw));
  candidates.add(path.resolve(getLegacyUploadsPath(), raw));
  return Array.from(candidates);
}
