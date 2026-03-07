import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prisma } from '../db/client';
import { getStateAssetsPath, resolveAssetsBaseDir } from '../utils/statePaths';

const MAX_ASSET_BYTES = 100 * 1024 * 1024;

export function getWorkspaceAssetsRoot(): string {
  return resolveAssetsBaseDir();
}

export function sanitizeAssetSlug(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function sanitizeFileName(value: string): string {
  const cleaned = String(value || 'asset.pdf')
    .replace(/[\\/]+/g, '_')
    .replace(/\s+/g, '_')
    .trim();
  const base = cleaned || 'asset.pdf';
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

function decodeBase64Payload(dataBase64: string): Buffer {
  const input = String(dataBase64 || '').trim();
  const match = input.match(/^data:[^;]+;base64,(.*)$/i);
  const payload = match ? match[1] : input;
  return Buffer.from(payload, 'base64');
}

export function buildWorkspaceAssetPublicUrl(asset: { publicId: string; fileName: string }): string {
  return `/public/assets/${encodeURIComponent(String(asset.publicId || ''))}/${encodeURIComponent(String(asset.fileName || 'asset.pdf'))}`;
}

export function resolveWorkspaceAssetAbsolutePath(asset: { storagePath: string }): string {
  const storagePath = String(asset.storagePath || '');
  const roots = Array.from(new Set([getWorkspaceAssetsRoot(), getStateAssetsPath()])).filter(Boolean);
  for (const root of roots) {
    const candidate = path.resolve(root, storagePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  const fallbackRoot = roots[0] || getWorkspaceAssetsRoot();
  return path.resolve(fallbackRoot, storagePath);
}

async function ensureAssetsDirectory(workspaceId: string): Promise<{ root: string; dir: string }> {
  let root = getWorkspaceAssetsRoot();
  try {
    await fs.promises.mkdir(root, { recursive: true });
  } catch (err: any) {
    const fallback = getStateAssetsPath();
    if (fallback && fallback !== root) {
      await fs.promises.mkdir(fallback, { recursive: true });
      root = fallback;
    } else {
      throw err;
    }
  }
  const dir = path.join(root, workspaceId);
  await fs.promises.mkdir(dir, { recursive: true });
  return { root, dir };
}

export async function listWorkspaceAssets(workspaceId: string, includeArchived = false) {
  const rows = await prisma.workspaceAsset.findMany({
    where: {
      workspaceId,
      ...(includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ archivedAt: 'asc' }, { createdAt: 'desc' }],
  });
  return rows.map((asset) => ({
    ...asset,
    publicUrl: String(asset.audience || '').toUpperCase() === 'PUBLIC' ? buildWorkspaceAssetPublicUrl(asset) : null,
    missing: !fs.existsSync(resolveWorkspaceAssetAbsolutePath(asset as any)),
  }));
}

export async function createWorkspaceAsset(params: {
  workspaceId: string;
  title: string;
  slug: string;
  description?: string | null;
  audience?: 'PUBLIC' | 'INTERNAL' | string | null;
  fileName: string;
  mimeType: string;
  dataBase64: string;
}) {
  const title = String(params.title || '').trim();
  if (!title) throw new Error('title es obligatorio');

  const slug = sanitizeAssetSlug(params.slug || title);
  if (!slug) throw new Error('slug inválido');

  const mimeType = String(params.mimeType || '').trim().toLowerCase();
  if (mimeType !== 'application/pdf') throw new Error('Solo se permiten PDFs (application/pdf).');

  const buffer = decodeBase64Payload(params.dataBase64);
  if (!buffer || buffer.length <= 0) throw new Error('Archivo vacío o inválido');
  if (buffer.length > MAX_ASSET_BYTES) throw new Error('PDF demasiado grande (máx 100MB).');

  const audience = String(params.audience || 'PUBLIC').trim().toUpperCase() === 'INTERNAL' ? 'INTERNAL' : 'PUBLIC';
  const fileName = sanitizeFileName(params.fileName || `${slug}.pdf`);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  const existing = await prisma.workspaceAsset.findFirst({
    where: { workspaceId: params.workspaceId, slug, archivedAt: null },
    select: { id: true },
  });
  if (existing?.id) throw new Error(`Ya existe un asset activo con slug "${slug}".`);

  const assetId = crypto.randomUUID();
  const publicId = crypto.randomBytes(18).toString('hex');
  const { root, dir } = await ensureAssetsDirectory(params.workspaceId);
  const storedFileName = `${assetId}_${fileName}`;
  const absolutePath = path.join(dir, storedFileName);
  await fs.promises.writeFile(absolutePath, buffer);

  const relativePath = path.relative(root, absolutePath).replace(/\\/g, '/');

  const created = await prisma.workspaceAsset.create({
    data: {
      id: assetId,
      workspaceId: params.workspaceId,
      slug,
      title,
      description: String(params.description || '').trim() || null,
      audience,
      mimeType,
      fileName,
      sizeBytes: buffer.length,
      sha256,
      storagePath: relativePath,
      publicId,
    },
  });

  return {
    ...created,
    publicUrl: audience === 'PUBLIC' ? buildWorkspaceAssetPublicUrl(created) : null,
  };
}

export async function setWorkspaceAssetArchived(params: {
  workspaceId: string;
  assetId: string;
  archived: boolean;
}) {
  const existing = await prisma.workspaceAsset.findFirst({
    where: { id: params.assetId, workspaceId: params.workspaceId },
  });
  if (!existing) throw new Error('Asset no encontrado');
  const updated = await prisma.workspaceAsset.update({
    where: { id: existing.id },
    data: { archivedAt: params.archived ? new Date() : null },
  });
  return {
    ...updated,
    publicUrl: String(updated.audience || '').toUpperCase() === 'PUBLIC' ? buildWorkspaceAssetPublicUrl(updated) : null,
  };
}

export async function findPublicWorkspaceAsset(publicId: string) {
  const row = await prisma.workspaceAsset.findFirst({
    where: {
      publicId: String(publicId || '').trim(),
      archivedAt: null,
      audience: 'PUBLIC',
    },
  });
  return row;
}

export async function findWorkspaceAssetForDownload(params: {
  workspaceId: string;
  assetId: string;
  includeInternal?: boolean;
}) {
  const row = await prisma.workspaceAsset.findFirst({
    where: {
      id: params.assetId,
      workspaceId: params.workspaceId,
      archivedAt: null,
      ...(params.includeInternal ? {} : { audience: 'PUBLIC' }),
    },
  });
  return row;
}
