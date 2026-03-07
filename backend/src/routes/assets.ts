import fs from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';
import {
  createWorkspaceAsset,
  findPublicWorkspaceAsset,
  findWorkspaceAssetForDownload,
  listWorkspaceAssets,
  resolveWorkspaceAssetAbsolutePath,
  setWorkspaceAssetArchived,
} from '../services/workspaceAssetService';
import { resolveWorkspaceAccess, isWorkspaceAdmin } from '../services/workspaceAuthService';
import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';

export async function registerAssetRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const includeArchived = String((request.query as any)?.includeArchived || '').trim() === '1';
    const rows = await listWorkspaceAssets(access.workspaceId, includeArchived);
    return rows.map((row: any) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      slug: row.slug,
      title: row.title,
      description: row.description,
      audience: row.audience,
      mimeType: row.mimeType,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      archivedAt: row.archivedAt ? new Date(row.archivedAt).toISOString() : null,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      publicUrl: row.publicUrl,
    }));
  });

  app.post('/upload', { preValidation: [app.authenticate], bodyLimit: 150_000_000 } as any, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const body = (request.body || {}) as {
      title?: string;
      slug?: string;
      description?: string | null;
      audience?: 'PUBLIC' | 'INTERNAL';
      fileName?: string;
      mimeType?: string;
      dataBase64?: string;
    };

    try {
      const created = await createWorkspaceAsset({
        workspaceId: access.workspaceId,
        title: String(body.title || '').trim(),
        slug: String(body.slug || '').trim(),
        description: typeof body.description === 'string' ? body.description : null,
        audience: body.audience || 'PUBLIC',
        fileName: String(body.fileName || '').trim(),
        mimeType: String(body.mimeType || '').trim(),
        dataBase64: String(body.dataBase64 || '').trim(),
      });

      await prisma.configChangeLog
        .create({
          data: {
            workspaceId: access.workspaceId,
            userId: request.user?.userId ? String(request.user.userId) : null,
            type: 'WORKSPACE_ASSET_UPLOAD',
            afterJson: serializeJson({
              assetId: created.id,
              slug: created.slug,
              title: created.title,
              audience: created.audience,
              sizeBytes: created.sizeBytes,
            }),
          },
        })
        .catch(() => {});

      return {
        id: created.id,
        slug: created.slug,
        title: created.title,
        description: created.description,
        audience: created.audience,
        mimeType: created.mimeType,
        fileName: created.fileName,
        sizeBytes: created.sizeBytes,
        publicUrl: created.publicUrl,
        createdAt: created.createdAt ? new Date(created.createdAt).toISOString() : null,
      };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : 'No se pudo subir el asset';
      return reply.code(400).send({ error: message });
    }
  });

  app.patch('/:assetId/archive', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { assetId } = request.params as { assetId: string };
    const body = (request.body || {}) as { archived?: boolean };
    const archived = Boolean(body?.archived);

    try {
      const updated = await setWorkspaceAssetArchived({
        workspaceId: access.workspaceId,
        assetId,
        archived,
      });

      await prisma.configChangeLog
        .create({
          data: {
            workspaceId: access.workspaceId,
            userId: request.user?.userId ? String(request.user.userId) : null,
            type: archived ? 'WORKSPACE_ASSET_ARCHIVE' : 'WORKSPACE_ASSET_RESTORE',
            afterJson: serializeJson({ assetId: updated.id, archivedAt: updated.archivedAt }),
          },
        })
        .catch(() => {});

      return {
        id: updated.id,
        archivedAt: updated.archivedAt ? new Date(updated.archivedAt).toISOString() : null,
      };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : 'No se pudo actualizar el asset';
      return reply.code(400).send({ error: message });
    }
  });

  app.delete('/:assetId', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { assetId } = request.params as { assetId: string };
    try {
      await setWorkspaceAssetArchived({ workspaceId: access.workspaceId, assetId, archived: true });
      return { ok: true, archived: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'No se pudo archivar el asset' });
    }
  });

  app.get('/:assetId/download', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    const { assetId } = request.params as { assetId: string };
    const row = await findWorkspaceAssetForDownload({
      workspaceId: access.workspaceId,
      assetId,
      includeInternal: true,
    });
    if (!row) return reply.code(404).send({ error: 'Asset no encontrado' });

    const absolutePath = resolveWorkspaceAssetAbsolutePath(row as any);
    if (!fs.existsSync(absolutePath)) return reply.code(404).send({ error: 'Archivo no encontrado en disco' });

    reply.header('Content-Type', row.mimeType || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${path.basename(row.fileName || 'archivo.pdf')}"`);
    return reply.send(fs.createReadStream(absolutePath));
  });
}

export function registerPublicAssetRoutes(app: FastifyInstance) {
  app.get('/public/assets/:publicId/:fileName', async (request, reply) => {
    const { publicId } = request.params as { publicId: string; fileName: string };
    const row = await findPublicWorkspaceAsset(publicId);
    if (!row) return reply.code(404).send({ error: 'Asset no encontrado' });

    const absolutePath = resolveWorkspaceAssetAbsolutePath(row as any);
    if (!fs.existsSync(absolutePath)) return reply.code(404).send({ error: 'Archivo no encontrado en disco' });

    reply.header('Cache-Control', 'public, max-age=3600');
    reply.header('Content-Type', row.mimeType || 'application/pdf');
    return reply.send(fs.createReadStream(absolutePath));
  });
}
