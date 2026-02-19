import { prisma } from '../db/client';
import {
  DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
  DEFAULT_TEMPLATE_INTERVIEW_INVITE,
  DEFAULT_WHATSAPP_BASE_URL,
  getSystemConfig,
} from './configService';
import { loadTemplateConfig } from './templateService';

export type TemplateCatalogEntry = {
  name: string;
  category: string | null;
  language: string | null;
  status: string | null;
  source: 'META' | 'CONFIG';
};

export type WorkspaceTemplateCatalogResult = {
  templates: TemplateCatalogEntry[];
  defaults: {
    recruit: string;
    interview: string;
  };
  sync: {
    metaEnabled: boolean;
    synced: boolean;
    syncError: string | null;
    wabaId: string | null;
  };
};

function normalizeName(value: unknown): string {
  return String(value || '').trim();
}

function normalizeNullable(value: unknown): string | null {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed : null;
}

function inferConfiguredTemplateLanguage(templateName: string, globalLanguage: string | null): string | null {
  const normalizedGlobal = normalizeNullable(globalLanguage);
  const key = String(templateName || '').trim().toLowerCase();
  if (!key) return normalizedGlobal;

  // Legacy internal defaults were created in es_CL.
  const isLegacyDefault =
    key === String(DEFAULT_TEMPLATE_GENERAL_FOLLOWUP || '').trim().toLowerCase() ||
    key === String(DEFAULT_TEMPLATE_INTERVIEW_INVITE || '').trim().toLowerCase();
  if (isLegacyDefault) return normalizedGlobal || 'es_CL';

  // For workspace-specific Meta templates, prefer generic Spanish unless explicitly configured otherwise.
  if (normalizedGlobal && normalizedGlobal.toLowerCase() !== 'es_cl') return normalizedGlobal;
  return 'es';
}

function upsertTemplate(entries: Map<string, TemplateCatalogEntry>, next: TemplateCatalogEntry): void {
  const key = next.name.toLowerCase();
  const existing = entries.get(key);
  if (!existing) {
    entries.set(key, next);
    return;
  }
  // Prefer META metadata over CONFIG fallback.
  if (existing.source !== 'META' && next.source === 'META') {
    entries.set(key, next);
    return;
  }
  entries.set(key, {
    ...existing,
    category: next.category || existing.category,
    language: next.language || existing.language,
    status: next.status || existing.status,
    source: existing.source === 'META' || next.source === 'META' ? 'META' : 'CONFIG',
  });
}

async function fetchMetaTemplates(args: {
  baseUrl: string;
  token: string;
  wabaId: string;
}): Promise<{ data: any[]; error: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${args.baseUrl.replace(/\/+$/, '')}/${args.wabaId}/message_templates?limit=200&fields=name,status,category,language`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${args.token}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return { data: [], error: `HTTP ${res.status}${text ? `: ${text.slice(0, 220)}` : ''}` };
    }
    const json = (await res.json()) as any;
    const rows = Array.isArray(json?.data) ? json.data : [];
    return { data: rows, error: null };
  } catch (err: any) {
    const message = err?.name === 'AbortError' ? 'timeout' : String(err?.message || 'request_failed');
    return { data: [], error: message };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWabaIdFromPhoneNumber(args: {
  baseUrl: string;
  token: string;
  waPhoneNumberId: string;
}): Promise<{ wabaId: string | null; error: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${args.baseUrl.replace(/\/+$/, '')}/${args.waPhoneNumberId}?fields=whatsapp_business_account`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${args.token}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return { wabaId: null, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 220)}` : ''}` };
    }
    const json = (await res.json()) as any;
    const wabaId = normalizeName((json as any)?.whatsapp_business_account?.id);
    if (!wabaId) {
      return { wabaId: null, error: 'WABA_ID_NOT_FOUND' };
    }
    return { wabaId, error: null };
  } catch (err: any) {
    const message = err?.name === 'AbortError' ? 'timeout' : String(err?.message || 'request_failed');
    return { wabaId: null, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

function toFriendlySyncError(raw: string | null): string | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  const low = text.toLowerCase();
  if (low.includes('nonexisting field (message_templates) on node type (user)')) {
    return 'No se pudo sincronizar desde Meta: el WABA ID configurado no es válido para plantillas. Revisa el wabaId de la línea o reconecta la integración.';
  }
  if (low.includes('waba_id_not_found')) {
    return 'No se pudo sincronizar desde Meta: no encontramos el WABA asociado al phone_number_id de la línea.';
  }
  if (low.includes('unsupported post request') || low.includes('object with id')) {
    return 'No se pudo sincronizar desde Meta: revisa permisos/token y que el phone_number_id / wabaId pertenezcan a tu cuenta.';
  }
  if (low.includes('timeout')) {
    return 'Meta tardó demasiado en responder al sincronizar plantillas. Intenta de nuevo en unos segundos.';
  }
  return `No se pudo sincronizar catálogo Meta (${text.slice(0, 180)}).`;
}

export async function listWorkspaceTemplateCatalog(workspaceId: string): Promise<WorkspaceTemplateCatalogResult> {
  const [config, templateConfig, workspace, activeLines] = await Promise.all([
    getSystemConfig(),
    loadTemplateConfig(undefined, workspaceId),
    prisma.workspace
      .findUnique({
        where: { id: workspaceId },
        select: {
          id: true,
          archivedAt: true,
          templateRecruitmentStartName: true as any,
          templateInterviewConfirmationName: true as any,
        } as any,
      })
      .catch(() => null),
    prisma.phoneLine
      .findMany({
        where: { workspaceId, archivedAt: null, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, wabaId: true, waPhoneNumberId: true },
      })
      .catch(() => [] as any[]),
  ]);

  const defaults = {
    recruit: templateConfig.templateGeneralFollowup || DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
    interview: templateConfig.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE,
  };

  const entries = new Map<string, TemplateCatalogEntry>();
  const configuredNames = [
    defaults.recruit,
    defaults.interview,
    normalizeName((workspace as any)?.templateRecruitmentStartName),
    normalizeName((workspace as any)?.templateInterviewConfirmationName),
    normalizeName((config as any)?.templateGeneralFollowup),
    normalizeName((config as any)?.templateInterviewInvite),
  ].filter(Boolean);

  for (const name of configuredNames) {
    upsertTemplate(entries, {
      name,
      category: null,
      language: inferConfiguredTemplateLanguage(name, normalizeNullable((config as any)?.templateLanguageCode)),
      status: 'CONFIGURADA',
      source: 'CONFIG',
    });
  }

  const token = String((config as any)?.whatsappToken || '').trim();
  const baseUrl = String((config as any)?.whatsappBaseUrl || DEFAULT_WHATSAPP_BASE_URL).trim() || DEFAULT_WHATSAPP_BASE_URL;
  const explicitWabaIds = Array.from(
    new Set(
      activeLines
        .map((l: any) => normalizeName(l?.wabaId))
        .filter(Boolean)
    )
  );
  const phoneNumberIds = Array.from(
    new Set(
      activeLines
        .map((l: any) => normalizeName(l?.waPhoneNumberId))
        .filter(Boolean)
    )
  );

  const metaEnabled = Boolean(token && (explicitWabaIds.length > 0 || phoneNumberIds.length > 0));
  let syncErrorRaw: string | null = null;
  let synced = false;
  let resolvedWabaId: string | null = explicitWabaIds[0] || null;

  if (metaEnabled && token) {
    const candidateWabaIds = new Set<string>(explicitWabaIds);

    // If line does not have a valid WABA configured, try to resolve from phone_number_id.
    for (const phoneId of phoneNumberIds) {
      if (!phoneId) continue;
      const resolved = await fetchWabaIdFromPhoneNumber({ baseUrl, token, waPhoneNumberId: phoneId });
      if (resolved.wabaId) {
        candidateWabaIds.add(resolved.wabaId);
      } else if (!syncErrorRaw && resolved.error) {
        syncErrorRaw = resolved.error;
      }
    }

    for (const candidate of candidateWabaIds) {
      const meta = await fetchMetaTemplates({ baseUrl, token, wabaId: candidate });
      if (meta.error) {
        syncErrorRaw = meta.error;
        continue;
      }
      synced = true;
      resolvedWabaId = candidate;
      syncErrorRaw = null;
      for (const row of meta.data) {
        const name = normalizeName((row as any)?.name);
        if (!name) continue;
        const language =
          normalizeNullable((row as any)?.language) ||
          normalizeNullable((row as any)?.language?.code) ||
          normalizeNullable((row as any)?.language?.policy);
        upsertTemplate(entries, {
          name,
          category: normalizeNullable((row as any)?.category),
          language,
          status: normalizeNullable((row as any)?.status),
          source: 'META',
        });
      }
      break;
    }
  }

  const templates = Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'));

  return {
    templates,
    defaults,
    sync: {
      metaEnabled,
      synced,
      syncError: toFriendlySyncError(syncErrorRaw),
      wabaId: resolvedWabaId,
    },
  };
}
