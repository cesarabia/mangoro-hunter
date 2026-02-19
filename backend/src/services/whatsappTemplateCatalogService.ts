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
      language: normalizeNullable((config as any)?.templateLanguageCode),
      status: 'CONFIGURADA',
      source: 'CONFIG',
    });
  }

  const token = String((config as any)?.whatsappToken || '').trim();
  const baseUrl = String((config as any)?.whatsappBaseUrl || DEFAULT_WHATSAPP_BASE_URL).trim() || DEFAULT_WHATSAPP_BASE_URL;
  const wabaId =
    normalizeName(activeLines.find((l: any) => String(l?.wabaId || '').trim())?.wabaId) || null;

  const metaEnabled = Boolean(token && wabaId);
  let syncError: string | null = null;
  let synced = false;

  if (metaEnabled && wabaId) {
    const meta = await fetchMetaTemplates({ baseUrl, token, wabaId });
    if (meta.error) {
      syncError = meta.error;
    } else {
      synced = true;
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
    }
  }

  const templates = Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'));

  return {
    templates,
    defaults,
    sync: {
      metaEnabled,
      synced,
      syncError,
      wabaId,
    },
  };
}
