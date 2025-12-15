import { prisma } from '../db/client';
import { DateTime } from 'luxon';
import { SystemConfig } from '@prisma/client';

export type SellerEventType = 'VISIT' | 'SALE';

export function isPitchRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /\b(pitch|discurso|guion|script|elevator)\b/.test(normalized);
}

export function detectSellerEvent(text: string): { type: SellerEventType; data: any } | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  const wantsRegister = /\b(registr|registro|anota|log)\b/.test(normalized);
  const isVisit = /\bvisita|visité|visite\b/.test(normalized);
  const isSale = /\bventa|vend[ií]|vendi|cerr[eé]\b/.test(normalized);

  if (wantsRegister && isVisit) {
    return { type: 'VISIT', data: extractSellerEventData(text) };
  }
  if (wantsRegister && isSale) {
    return { type: 'SALE', data: extractSellerEventData(text) };
  }
  return null;
}

export function isDailySummaryRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /\b(resumen|reporte)\b/.test(normalized) && /\b(diario|hoy|día)\b/.test(normalized);
}

export function isWeeklySummaryRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /\b(resumen|reporte)\b/.test(normalized) && /\b(semanal|semana)\b/.test(normalized);
}

export async function createSellerEvent(params: {
  conversationId: string;
  contactId: string;
  type: SellerEventType;
  rawText: string;
  occurredAt?: Date;
  data?: any;
}) {
  const occurredAt = params.occurredAt ?? new Date();
  const dataJson = typeof params.data !== 'undefined' ? JSON.stringify(params.data) : null;
  return prisma.sellerEvent.create({
    data: {
      conversationId: params.conversationId,
      contactId: params.contactId,
      type: params.type,
      occurredAt,
      rawText: params.rawText,
      dataJson
    }
  });
}

export async function buildSellerSummary(params: {
  contactId: string;
  config: SystemConfig;
  range: 'DAY' | 'WEEK';
  now?: Date;
}): Promise<{
  refKey: string;
  label: string;
  visits: number;
  sales: number;
  totalAmountClp: number | null;
  lines: string[];
}> {
  const tz = (params.config.interviewTimezone || 'America/Santiago').trim() || 'America/Santiago';
  const now = DateTime.fromJSDate(params.now ?? new Date(), { zone: tz });
  const startLocal = params.range === 'DAY' ? now.startOf('day') : now.startOf('week');
  const endLocal = params.range === 'DAY' ? startLocal.plus({ days: 1 }) : startLocal.plus({ weeks: 1 });
  const startUtc = startLocal.toUTC().toJSDate();
  const endUtc = endLocal.toUTC().toJSDate();

  const events = await prisma.sellerEvent.findMany({
    where: {
      contactId: params.contactId,
      occurredAt: { gte: startUtc, lt: endUtc }
    },
    orderBy: { occurredAt: 'asc' }
  });

  const visits = events.filter(e => e.type === 'VISIT').length;
  const sales = events.filter(e => e.type === 'SALE').length;
  const amounts = events
    .map(e => safeJsonParse(e.dataJson)?.amountClp)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const totalAmountClp = amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) : null;

  const lines = events.slice(-8).map(event => {
    const timeLabel = DateTime.fromJSDate(event.occurredAt, { zone: tz }).toFormat('HH:mm');
    const typeLabel = event.type === 'SALE' ? 'Venta' : 'Visita';
    const snippet = event.rawText.replace(/\s+/g, ' ').trim().slice(0, 140);
    return `- ${timeLabel} · ${typeLabel}: ${snippet}${snippet.length >= 140 ? '…' : ''}`;
  });

  const dateKey = startLocal.toISODate() || now.toISODate() || 'unknown';
  const refKey = params.range === 'DAY' ? dateKey : startLocal.toFormat("kkkk-'W'WW");
  const label = params.range === 'DAY' ? `Resumen diario (${dateKey})` : `Resumen semanal (${refKey})`;

  return { refKey, label, visits, sales, totalAmountClp, lines };
}

function extractSellerEventData(text: string): { amountClp: number | null; units: number | null } {
  const amountClp = extractAmountClp(text);
  const units = extractUnits(text);
  return { amountClp, units };
}

function extractAmountClp(text: string): number | null {
  const match = text.match(/(?:\\$\\s*|\\bclp\\b\\s*)([0-9]{1,3}(?:[\\.,][0-9]{3})*|[0-9]+)/i);
  if (!match?.[1]) return null;
  const normalized = match[1].replace(/\\./g, '').replace(/,/g, '').trim();
  const value = parseInt(normalized, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractUnits(text: string): number | null {
  const match = text.match(/\\b(\\d{1,3})\\s*(?:packs?|planes?|unidades?)\\b/i);
  if (!match?.[1]) return null;
  const value = parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function safeJsonParse(value?: string | null): any | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
