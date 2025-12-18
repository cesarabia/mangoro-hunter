import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';
import { resolveWorkspaceAccess, isWorkspaceOwner } from '../services/workspaceAuthService';

function isMissingColumnError(err: any): boolean {
  return Boolean(err && typeof err === 'object' && err.code === 'P2022');
}

function slugify(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function safeParseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function safeJsonParse(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeString(value: unknown): string | null | undefined {
  if (typeof value === 'undefined') return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeUrl(value: unknown): string | null | undefined {
  const str = safeString(value);
  if (typeof str !== 'string') return str;
  try {
    const url = new URL(str);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    return url.toString().replace(/\/+$/g, '');
  } catch {
    return null;
  }
}

function normalizeTestMethod(value: unknown): 'GET' | 'HEAD' | null | undefined {
  const str = safeString(value);
  if (typeof str !== 'string') return str;
  const upper = str.toUpperCase().trim();
  if (upper === 'GET' || upper === 'HEAD') return upper;
  return null;
}

function normalizeTestPath(value: unknown): string | null | undefined {
  const str = safeString(value);
  if (typeof str !== 'string') return str;
  const trimmed = str.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (normalized.length > 200) return null;
  if (/\s/.test(normalized)) return null;
  return normalized;
}

function normalizeAuthType(value: unknown): 'BEARER_TOKEN' | 'HEADER' | null | undefined {
  const str = safeString(value);
  if (typeof str !== 'string') return str;
  const upper = str.toUpperCase().replace(/[\s-]+/g, '_');
  if (upper === 'BEARER_TOKEN') return 'BEARER_TOKEN';
  if (upper === 'HEADER') return 'HEADER';
  return null;
}

function safeParseDomains(value: unknown): string[] {
  const raw = safeParseStringArray(value);
  const out: string[] = [];
  for (const d of raw) {
    const dom = d.toLowerCase().trim();
    if (!dom) continue;
    if (!out.includes(dom)) out.push(dom);
  }
  return out;
}

function parseDomainsJson(value: string | null | undefined): string[] {
  return safeParseDomains(safeJsonParse(value) || []);
}

function isPrivateOrLocalHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split('.').map((p) => parseInt(p, 10));
    if (parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const str = String(value);
  if (str.length <= 4) return '****';
  return `${str.slice(0, 2)}****${str.slice(-2)}`;
}

export async function registerConnectorRoutes(app: FastifyInstance) {
  app.get('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    try {
      const connectors = await prisma.workspaceConnector.findMany({
        where: { workspaceId: access.workspaceId, archivedAt: null },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          baseUrl: true as any,
          testPath: true as any,
          testMethod: true as any,
          authType: true as any,
          authHeaderName: true as any,
          authToken: true as any,
          allowedDomainsJson: true as any,
          timeoutMs: true as any,
          maxPayloadBytes: true as any,
          lastTestedAt: true as any,
          lastTestOk: true as any,
          lastTestError: true as any,
          actionsJson: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        } as any,
      });

      return connectors.map((c: any) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        baseUrl: c.baseUrl || null,
        testPath: c.testPath || null,
        testMethod: c.testMethod || null,
        authType: c.authType || 'BEARER_TOKEN',
        authHeaderName: c.authHeaderName || 'Authorization',
        hasToken: Boolean(c.authToken),
        tokenMasked: maskSecret(c.authToken),
        allowedDomains: parseDomainsJson(c.allowedDomainsJson),
        timeoutMs: typeof c.timeoutMs === 'number' ? c.timeoutMs : null,
        maxPayloadBytes: typeof c.maxPayloadBytes === 'number' ? c.maxPayloadBytes : null,
        lastTestedAt: c.lastTestedAt ? new Date(c.lastTestedAt).toISOString() : null,
        lastTestOk: typeof c.lastTestOk === 'boolean' ? c.lastTestOk : null,
        lastTestError: c.lastTestError || null,
        actions: safeParseStringArray(safeJsonParse(c.actionsJson)),
        isActive: c.isActive,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      }));
    } catch (err: any) {
      if (isMissingColumnError(err)) {
        return reply.code(409).send({ error: 'Campos de Connectors no disponibles. Ejecuta migraciones.' });
      }
      throw err;
    }
  });

  app.post('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const body = request.body as {
      name?: string;
      slug?: string;
      description?: string | null;
      isActive?: boolean;
      actions?: string[] | null;
      baseUrl?: string | null;
      testPath?: string | null;
      testMethod?: string | null;
      authType?: string | null;
      authHeaderName?: string | null;
      authToken?: string | null;
      allowedDomains?: string[] | null;
      timeoutMs?: number | null;
      maxPayloadBytes?: number | null;
    };

    const name = String(body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: '"name" es requerido.' });

    const slug = slugify(body?.slug ? String(body.slug) : name);
    if (!slug) return reply.code(400).send({ error: '"slug" inválido.' });

    const actions = safeParseStringArray(body?.actions ?? []);
    const baseUrl = normalizeUrl(body?.baseUrl);
    if (typeof body?.baseUrl !== 'undefined' && baseUrl === null) {
      return reply.code(400).send({ error: '"baseUrl" inválida (usa http/https).' });
    }
    if (typeof baseUrl === 'string') {
      const host = (() => {
        try { return new URL(baseUrl).hostname; } catch { return ''; }
      })();
      if (isPrivateOrLocalHostname(host)) {
        return reply.code(400).send({ error: 'baseUrl no puede apuntar a host local/privado.' });
      }
    }

    const rawTestPath = typeof body?.testPath === 'string' ? body.testPath.trim() : '';
    const testPath = normalizeTestPath(body?.testPath);
    if (typeof body?.testPath !== 'undefined' && rawTestPath && testPath === null) {
      return reply.code(400).send({ error: '"testPath" inválido. Usa un path tipo /health.' });
    }

    const rawTestMethod = typeof body?.testMethod === 'string' ? body.testMethod.trim() : '';
    const testMethod = normalizeTestMethod(body?.testMethod);
    if (typeof body?.testMethod !== 'undefined' && rawTestMethod && testMethod === null) {
      return reply.code(400).send({ error: '"testMethod" inválido (GET | HEAD).' });
    }

    const authType = normalizeAuthType(body?.authType);
    if (typeof body?.authType !== 'undefined' && authType === null) {
      return reply.code(400).send({ error: '"authType" inválido (BEARER_TOKEN | HEADER).' });
    }
    const authHeaderName = safeString(body?.authHeaderName);
    const authToken = safeString(body?.authToken);
    const allowedDomains = safeParseDomains(body?.allowedDomains ?? []);
    const timeoutMsRaw = body?.timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === 'number' && Number.isFinite(timeoutMsRaw)
        ? Math.max(1000, Math.min(60000, Math.floor(timeoutMsRaw)))
        : null;
    const maxPayloadBytesRaw = body?.maxPayloadBytes;
    const maxPayloadBytes =
      typeof maxPayloadBytesRaw === 'number' && Number.isFinite(maxPayloadBytesRaw)
        ? Math.max(1024, Math.min(5_000_000, Math.floor(maxPayloadBytesRaw)))
        : null;

    const inferredDomains = (() => {
      if (allowedDomains.length > 0) return allowedDomains;
      if (typeof baseUrl !== 'string') return [];
      try {
        const host = new URL(baseUrl).hostname.toLowerCase();
        return host ? [host] : [];
      } catch {
        return [];
      }
    })();

    let created: any;
    try {
      created = await prisma.workspaceConnector.create({
        data: {
          workspaceId: access.workspaceId,
          name,
          slug,
          description: body?.description ? String(body.description).trim() : null,
          baseUrl,
          testPath,
          testMethod,
          authType: authType || 'BEARER_TOKEN',
          authHeaderName: typeof authHeaderName === 'string' ? authHeaderName : 'Authorization',
          authToken: typeof authToken === 'string' ? authToken : null,
          allowedDomainsJson: inferredDomains.length > 0 ? serializeJson(inferredDomains) : null,
          timeoutMs,
          maxPayloadBytes,
          isActive: typeof body?.isActive === 'boolean' ? body.isActive : true,
          actionsJson: actions.length > 0 ? serializeJson(actions) : null,
        } as any,
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          baseUrl: true as any,
          testPath: true as any,
          testMethod: true as any,
          authType: true as any,
          authHeaderName: true as any,
          authToken: true as any,
          allowedDomainsJson: true as any,
          timeoutMs: true as any,
          maxPayloadBytes: true as any,
          actionsJson: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        } as any,
      });
    } catch (err: any) {
      if (isMissingColumnError(err)) {
        return reply.code(409).send({ error: 'Campos de Connectors no disponibles. Ejecuta migraciones.' });
      }
      throw err;
    }

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId || null,
          type: 'CONNECTOR_CREATED',
          beforeJson: null,
          afterJson: serializeJson({ connectorId: created.id, slug: created.slug }),
        },
      })
      .catch(() => {});

    return {
      id: created.id,
      name: created.name,
      slug: created.slug,
      description: created.description,
      baseUrl: created.baseUrl || null,
      testPath: (created as any).testPath || null,
      testMethod: (created as any).testMethod || null,
      authType: created.authType || 'BEARER_TOKEN',
      authHeaderName: created.authHeaderName || 'Authorization',
      hasToken: Boolean(created.authToken),
      tokenMasked: maskSecret(created.authToken),
      allowedDomains: parseDomainsJson(created.allowedDomainsJson),
      timeoutMs: typeof created.timeoutMs === 'number' ? created.timeoutMs : null,
      maxPayloadBytes: typeof created.maxPayloadBytes === 'number' ? created.maxPayloadBytes : null,
      actions: safeParseStringArray(safeJsonParse(created.actionsJson)),
      isActive: created.isActive,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  });

  app.patch('/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });

    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      slug?: string;
      description?: string | null;
      isActive?: boolean;
      actions?: string[] | null;
      baseUrl?: string | null;
      testPath?: string | null;
      testMethod?: string | null;
      authType?: string | null;
      authHeaderName?: string | null;
      authToken?: string | null;
      allowedDomains?: string[] | null;
      timeoutMs?: number | null;
      maxPayloadBytes?: number | null;
      archivedAt?: string | null;
      archived?: boolean;
    };

    let existing: any;
    try {
      existing = await prisma.workspaceConnector.findFirst({
        where: { id, workspaceId: access.workspaceId },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          baseUrl: true as any,
          testPath: true as any,
          testMethod: true as any,
          authType: true as any,
          authHeaderName: true as any,
          authToken: true as any,
          allowedDomainsJson: true as any,
          timeoutMs: true as any,
          maxPayloadBytes: true as any,
          actionsJson: true,
          isActive: true,
          archivedAt: true,
        } as any,
      });
    } catch (err: any) {
      if (isMissingColumnError(err)) {
        return reply.code(409).send({ error: 'Campos de Connectors no disponibles. Ejecuta migraciones.' });
      }
      throw err;
    }
    if (!existing) return reply.code(404).send({ error: 'No encontrado' });

    const data: Record<string, any> = {};
    if (typeof body.name === 'string') data.name = body.name.trim();
    if (typeof body.slug === 'string') data.slug = slugify(body.slug);
    if (typeof body.description !== 'undefined') data.description = body.description ? String(body.description).trim() : null;
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive;
    if (typeof body.actions !== 'undefined') {
      const actions = safeParseStringArray(body.actions ?? []);
      data.actionsJson = actions.length > 0 ? serializeJson(actions) : null;
    }
    if (typeof body.baseUrl !== 'undefined') {
      const baseUrl = normalizeUrl(body.baseUrl);
      if (baseUrl === null) return reply.code(400).send({ error: '"baseUrl" inválida (usa http/https).' });
      if (typeof baseUrl === 'string') {
        const host = (() => {
          try { return new URL(baseUrl).hostname; } catch { return ''; }
        })();
        if (isPrivateOrLocalHostname(host)) {
          return reply.code(400).send({ error: 'baseUrl no puede apuntar a host local/privado.' });
        }
      }
      data.baseUrl = baseUrl;
    }
    if (typeof body.testPath !== 'undefined') {
      const raw = typeof body.testPath === 'string' ? body.testPath.trim() : '';
      const testPath = normalizeTestPath(body.testPath);
      if (raw && testPath === null) return reply.code(400).send({ error: '"testPath" inválido. Usa un path tipo /health.' });
      data.testPath = testPath;
    }
    if (typeof body.testMethod !== 'undefined') {
      const raw = typeof body.testMethod === 'string' ? body.testMethod.trim() : '';
      const testMethod = normalizeTestMethod(body.testMethod);
      if (raw && testMethod === null) return reply.code(400).send({ error: '"testMethod" inválido (GET | HEAD).' });
      data.testMethod = testMethod;
    }
    if (typeof body.authType !== 'undefined') {
      const authType = normalizeAuthType(body.authType);
      if (authType === null) return reply.code(400).send({ error: '"authType" inválido (BEARER_TOKEN | HEADER).' });
      data.authType = authType;
    }
    if (typeof body.authHeaderName !== 'undefined') {
      const header = safeString(body.authHeaderName);
      data.authHeaderName = typeof header === 'string' ? header : header === null ? null : undefined;
    }
    if (typeof body.authToken !== 'undefined') {
      const tok = safeString(body.authToken);
      data.authToken = typeof tok === 'string' ? tok : tok === null ? null : undefined;
    }
    if (typeof body.allowedDomains !== 'undefined') {
      const domains = safeParseDomains(body.allowedDomains ?? []);
      data.allowedDomainsJson = domains.length > 0 ? serializeJson(domains) : null;
    }
    if (typeof body.timeoutMs !== 'undefined') {
      if (body.timeoutMs === null) data.timeoutMs = null;
      else if (typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)) {
        data.timeoutMs = Math.max(1000, Math.min(60000, Math.floor(body.timeoutMs)));
      } else {
        return reply.code(400).send({ error: '"timeoutMs" inválido.' });
      }
    }
    if (typeof body.maxPayloadBytes !== 'undefined') {
      if (body.maxPayloadBytes === null) data.maxPayloadBytes = null;
      else if (typeof body.maxPayloadBytes === 'number' && Number.isFinite(body.maxPayloadBytes)) {
        data.maxPayloadBytes = Math.max(1024, Math.min(5_000_000, Math.floor(body.maxPayloadBytes)));
      } else {
        return reply.code(400).send({ error: '"maxPayloadBytes" inválido.' });
      }
    }
    if (typeof body.archived !== 'undefined') {
      data.archivedAt = body.archived ? new Date() : null;
    } else if (typeof body.archivedAt !== 'undefined') {
      data.archivedAt = body.archivedAt ? new Date(body.archivedAt) : null;
    }

    let updated: any;
    try {
      updated = await prisma.workspaceConnector.update({
        where: { id },
        data,
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          baseUrl: true as any,
          testPath: true as any,
          testMethod: true as any,
          authType: true as any,
          authHeaderName: true as any,
          authToken: true as any,
          allowedDomainsJson: true as any,
          timeoutMs: true as any,
          maxPayloadBytes: true as any,
          lastTestedAt: true as any,
          lastTestOk: true as any,
          lastTestError: true as any,
          actionsJson: true,
          isActive: true,
          archivedAt: true,
          createdAt: true,
          updatedAt: true,
        } as any,
      });
    } catch (err: any) {
      if (isMissingColumnError(err)) {
        return reply.code(409).send({ error: 'Campos de Connectors no disponibles. Ejecuta migraciones.' });
      }
      throw err;
    }

    await prisma.configChangeLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          userId: request.user?.userId || null,
          type: 'CONNECTOR_UPDATED',
          beforeJson: serializeJson({ id: existing.id, name: existing.name, slug: existing.slug, isActive: existing.isActive, archivedAt: existing.archivedAt }),
          afterJson: serializeJson({ id: updated.id, name: updated.name, slug: updated.slug, isActive: updated.isActive, archivedAt: updated.archivedAt }),
        },
      })
      .catch(() => {});

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      description: updated.description,
      baseUrl: updated.baseUrl || null,
      testPath: (updated as any).testPath || null,
      testMethod: (updated as any).testMethod || null,
      authType: updated.authType || 'BEARER_TOKEN',
      authHeaderName: updated.authHeaderName || 'Authorization',
      hasToken: Boolean(updated.authToken),
      tokenMasked: maskSecret(updated.authToken),
      allowedDomains: parseDomainsJson(updated.allowedDomainsJson),
      timeoutMs: typeof updated.timeoutMs === 'number' ? updated.timeoutMs : null,
      maxPayloadBytes: typeof updated.maxPayloadBytes === 'number' ? updated.maxPayloadBytes : null,
      lastTestedAt: updated.lastTestedAt ? new Date(updated.lastTestedAt).toISOString() : null,
      lastTestOk: typeof updated.lastTestOk === 'boolean' ? updated.lastTestOk : null,
      lastTestError: updated.lastTestError || null,
      actions: safeParseStringArray(safeJsonParse(updated.actionsJson)),
      isActive: updated.isActive,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null,
    };
  });

  app.post('/:id/test', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceOwner(request, access)) return reply.code(403).send({ error: 'Forbidden' });
    const { id } = request.params as { id: string };
    const body = request.body as { path?: string | null; method?: string | null };

    let connector: any;
    try {
      connector = await prisma.workspaceConnector.findFirst({
        where: { id, workspaceId: access.workspaceId, archivedAt: null },
        select: {
          id: true,
          name: true,
          slug: true,
          baseUrl: true as any,
          testPath: true as any,
          testMethod: true as any,
          authType: true as any,
          authHeaderName: true as any,
          authToken: true as any,
          allowedDomainsJson: true as any,
          timeoutMs: true as any,
          maxPayloadBytes: true as any,
          isActive: true,
        } as any,
      });
    } catch (err: any) {
      if (isMissingColumnError(err)) {
        return reply.code(409).send({ error: 'Campos de Connectors no disponibles. Ejecuta migraciones.' });
      }
      throw err;
    }
    if (!connector) return reply.code(404).send({ error: 'No encontrado.' });
    if (!connector.isActive) return reply.code(400).send({ error: 'Connector inactivo.' });

    const baseUrl = typeof connector.baseUrl === 'string' ? connector.baseUrl.trim() : '';
    if (!baseUrl) return reply.code(400).send({ error: 'Define baseUrl antes de testear.' });

    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return reply.code(400).send({ error: 'baseUrl inválida.' });
    }
    if (!['https:', 'http:'].includes(url.protocol)) {
      return reply.code(400).send({ error: 'baseUrl debe ser http/https.' });
    }
    if (isPrivateOrLocalHostname(url.hostname)) {
      return reply.code(400).send({ error: 'baseUrl no puede apuntar a host local/privado.' });
    }
    const allowedDomains = parseDomainsJson(connector.allowedDomainsJson);
    if (allowedDomains.length > 0 && !allowedDomains.includes(url.hostname.toLowerCase())) {
      return reply.code(400).send({ error: `Dominio bloqueado. Debe estar en allowlist: ${allowedDomains.join(', ')}` });
    }

    const timeoutMs = typeof connector.timeoutMs === 'number' && Number.isFinite(connector.timeoutMs) ? connector.timeoutMs : 8000;
    const maxPayloadBytes = typeof connector.maxPayloadBytes === 'number' && Number.isFinite(connector.maxPayloadBytes) ? connector.maxPayloadBytes : 200_000;
    const authType = String(connector.authType || 'BEARER_TOKEN').toUpperCase();
    const authHeaderName = String(connector.authHeaderName || 'Authorization').trim() || 'Authorization';
    const authToken = typeof connector.authToken === 'string' ? connector.authToken : null;

    const overridePath = typeof body?.path === 'string' ? body.path : null;
    const overrideMethod = typeof body?.method === 'string' ? body.method : null;
    const testPath = normalizeTestPath(overridePath) ?? (connector as any).testPath ?? null;
    const testMethod = normalizeTestMethod(overrideMethod) ?? (connector as any).testMethod ?? 'GET';
    if (typeof overridePath === 'string' && overridePath.trim() && testPath === null) {
      return reply.code(400).send({ error: '"path" inválido. Usa un path tipo /health.' });
    }
    if (typeof overrideMethod === 'string' && overrideMethod.trim() && normalizeTestMethod(overrideMethod) === null) {
      return reply.code(400).send({ error: '"method" inválido (GET | HEAD).' });
    }
    if (testPath) {
      const basePath = url.pathname.replace(/\/+$/g, '');
      const extra = String(testPath).replace(/^\/+/g, '');
      url.pathname = `${basePath}/${extra}`.replace(/\/{2,}/g, '/');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs).unref();

    const headers: Record<string, string> = { 'User-Agent': 'HunterCRM-ConnectorTest/1.0' };
    if (authToken) {
      if (authType === 'HEADER') headers[authHeaderName] = authToken;
      else headers['Authorization'] = `Bearer ${authToken}`;
    }

    const startedAt = Date.now();
    let ok = false;
    let statusCode: number | null = null;
    let error: string | null = null;
    let responseSnippet: string | null = null;

    try {
      const res = await fetch(url.toString(), { method: testMethod, headers, signal: controller.signal });
      statusCode = res.status;
      if (testMethod !== 'HEAD') {
        const buf = Buffer.from(await res.arrayBuffer());
        responseSnippet = buf.slice(0, Math.min(buf.length, maxPayloadBytes, 2048)).toString('utf8');
      }
      ok = res.ok;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err: any) {
      error = err?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err?.message || 'error';
      ok = false;
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - startedAt;

    // Audit call (no secrets).
    await prisma.connectorCallLog
      .create({
        data: {
          workspaceId: access.workspaceId,
          connectorId: connector.id,
          userId: request.user?.userId || null,
          kind: 'TEST',
          action: testMethod,
          requestJson: serializeJson({ method: testMethod, url: url.toString(), host: url.hostname, timeoutMs }),
          responseJson: serializeJson({ statusCode, durationMs, snippet: responseSnippet ? responseSnippet.slice(0, 512) : null }),
          ok,
          error,
          statusCode,
        } as any,
      })
      .catch(() => {});

    // Store last test on connector (best-effort).
    await prisma.workspaceConnector
      .update({
        where: { id: connector.id },
        data: {
          lastTestedAt: new Date(),
          lastTestOk: ok,
          lastTestError: ok ? null : error,
        } as any,
      })
      .catch(() => {});

    return reply.send({
      ok,
      statusCode,
      durationMs,
      error,
      snippet: responseSnippet ? responseSnippet.slice(0, 512) : null,
      tested: { method: testMethod, path: testPath || '/', url: url.toString() },
    });
  });
}
