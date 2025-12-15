import { Prisma, SystemConfig } from '@prisma/client';
import { DateTime } from 'luxon';
import { prisma } from '../db/client';

type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

type AvailabilityInterval = {
  startMinutes: number;
  endMinutes: number;
};

export type InterviewSlot = {
  day: string;
  time: string;
  location: string;
  timezone: string;
  startAt: Date;
  endAt: Date;
};

export type InterviewLocationConfig = {
  label: string;
  exactAddress: string | null;
  instructions: string | null;
};

export type ScheduleAttemptResult =
  | {
      ok: true;
      kind: 'SCHEDULED' | 'RESCHEDULED' | 'UNCHANGED';
      slot: InterviewSlot;
      reservationId: string;
      previousReservationId: string | null;
    }
  | {
      ok: false;
      reason: 'MISSING' | 'BAD_INPUT' | 'OUTSIDE_AVAILABILITY' | 'CONFLICT';
      message: string;
      alternatives: InterviewSlot[];
    };

const DEFAULT_TIMEZONE = 'America/Santiago';
const DEFAULT_SLOT_MINUTES = 30;

const DEFAULT_WEEKLY_AVAILABILITY: Record<Weekday, AvailabilityInterval[]> = {
  1: [{ startMinutes: 9 * 60, endMinutes: 18 * 60 }],
  2: [{ startMinutes: 9 * 60, endMinutes: 18 * 60 }],
  3: [{ startMinutes: 9 * 60, endMinutes: 18 * 60 }],
  4: [{ startMinutes: 9 * 60, endMinutes: 18 * 60 }],
  5: [{ startMinutes: 9 * 60, endMinutes: 18 * 60 }],
  6: [],
  7: [],
};

const SPANISH_WEEKDAYS: Record<string, Weekday> = {
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6,
  domingo: 7,
};

function normalizeTimezone(value?: string | null): string {
  const tz = (value || '').trim();
  return tz ? tz : DEFAULT_TIMEZONE;
}

function normalizeSlotMinutes(value: number | null | undefined): number {
  const raw = typeof value === 'number' ? Math.floor(value) : DEFAULT_SLOT_MINUTES;
  if (!Number.isFinite(raw) || raw <= 0 || raw > 8 * 60) return DEFAULT_SLOT_MINUTES;
  return raw;
}

function normalizeLocation(value?: string | null): string | null {
  const trimmed = (value || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function safeJsonParse<T>(value?: string | null): T | null {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeDayLabel(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function dayToWeekday(day?: string | null): Weekday | null {
  if (!day) return null;
  const key = day.trim().toLowerCase();
  return SPANISH_WEEKDAYS[key] ?? null;
}

function parseTimeToMinutes(time: string): number | null {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function minutesToTime(minutes: number): string {
  const hh = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const mm = Math.floor(minutes % 60)
    .toString()
    .padStart(2, '0');
  return `${hh}:${mm}`;
}

function parseLocationItem(item: unknown): InterviewLocationConfig | null {
  if (typeof item === 'string') {
    const label = normalizeLocation(item);
    if (!label) return null;
    return { label, exactAddress: null, instructions: null };
  }
  if (item && typeof item === 'object') {
    const labelRaw = typeof (item as any).label === 'string' ? (item as any).label : null;
    const label = normalizeLocation(labelRaw);
    if (!label) return null;
    const exactAddressRaw =
      typeof (item as any).exactAddress === 'string' ? String((item as any).exactAddress).trim() : '';
    const instructionsRaw =
      typeof (item as any).instructions === 'string' ? String((item as any).instructions).trim() : '';
    return {
      label,
      exactAddress: exactAddressRaw ? exactAddressRaw : null,
      instructions: instructionsRaw ? instructionsRaw : null,
    };
  }
  return null;
}

export function getInterviewLocationConfigs(config: SystemConfig): InterviewLocationConfig[] {
  const parsed = safeJsonParse<unknown>(config.interviewLocations);
  if (Array.isArray(parsed)) {
    const items = parsed.map(parseLocationItem).filter(Boolean) as InterviewLocationConfig[];
    if (items.length > 0) return items;
  }
  const fallback = normalizeLocation(config.defaultInterviewLocation) || 'Online';
  return [{ label: fallback, exactAddress: null, instructions: null }];
}

export function resolveInterviewLocationConfig(
  config: SystemConfig,
  label?: string | null,
): InterviewLocationConfig | null {
  const normalized = normalizeLocation(label);
  if (!normalized) return null;
  const locations = getInterviewLocationConfigs(config);
  const match = locations.find((loc) => loc.label.toLowerCase() === normalized.toLowerCase());
  return match || null;
}

export function formatInterviewExactAddress(
  config: SystemConfig,
  label?: string | null,
): string | null {
  const loc = resolveInterviewLocationConfig(config, label);
  if (!loc) return null;
  if (!loc.exactAddress && !loc.instructions) return null;
  const lines: string[] = [];
  if (loc.exactAddress) lines.push(`Dirección exacta: ${loc.exactAddress}`);
  if (loc.instructions) lines.push(loc.instructions);
  return lines.join('\n');
}

function getLocations(config: SystemConfig): string[] {
  return getInterviewLocationConfigs(config).map((loc) => loc.label);
}

function getWeeklyAvailability(config: SystemConfig): Record<Weekday, AvailabilityInterval[]> {
  const parsed = safeJsonParse<unknown>(config.interviewWeeklyAvailability);
  if (!parsed || typeof parsed !== 'object') return DEFAULT_WEEKLY_AVAILABILITY;

  const availability: Record<Weekday, AvailabilityInterval[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
  const record = parsed as Record<string, unknown>;
  for (const [keyRaw, value] of Object.entries(record)) {
    const key = String(keyRaw || '').trim().toLowerCase();
    const weekday = SPANISH_WEEKDAYS[key] ?? null;
    if (!weekday) continue;
    if (!Array.isArray(value)) continue;

    const intervals: AvailabilityInterval[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const start = typeof (entry as any).start === 'string' ? (entry as any).start : null;
      const end = typeof (entry as any).end === 'string' ? (entry as any).end : null;
      if (!start || !end) continue;
      const startMinutes = parseTimeToMinutes(start);
      const endMinutes = parseTimeToMinutes(end);
      if (startMinutes === null || endMinutes === null) continue;
      if (startMinutes >= endMinutes) continue;
      intervals.push({ startMinutes, endMinutes });
    }
    availability[weekday] = intervals;
  }

  return availability;
}

function getExceptionDates(config: SystemConfig): Set<string> {
  const parsed = safeJsonParse<unknown>(config.interviewExceptions);
  if (!parsed) return new Set();
  const out = new Set<string>();
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) out.add(trimmed);
      } else if (entry && typeof entry === 'object' && typeof (entry as any).date === 'string') {
        const trimmed = String((entry as any).date).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) out.add(trimmed);
      }
    }
  }
  return out;
}

function isSlotWithinAvailability(params: {
  startLocal: DateTime;
  slotMinutes: number;
  availability: Record<Weekday, AvailabilityInterval[]>;
  exceptionDates: Set<string>;
}): boolean {
  const { startLocal, slotMinutes, availability, exceptionDates } = params;

  const dateKey = startLocal.toISODate();
  if (dateKey && exceptionDates.has(dateKey)) return false;

  const weekday = startLocal.weekday as Weekday;
  const intervals = availability[weekday] || [];
  if (intervals.length === 0) return false;

  const startMinutes = startLocal.hour * 60 + startLocal.minute;
  const endMinutes = startMinutes + slotMinutes;
  return intervals.some(interval => startMinutes >= interval.startMinutes && endMinutes <= interval.endMinutes);
}

function buildSlotFromLocal(params: {
  startLocal: DateTime;
  slotMinutes: number;
  location: string;
  timezone: string;
}): InterviewSlot {
  const { startLocal, slotMinutes, location, timezone } = params;
  const endLocal = startLocal.plus({ minutes: slotMinutes });
  const day = normalizeDayLabel(startLocal.setLocale('es-CL').toFormat('cccc'));
  const time = startLocal.toFormat('HH:mm');
  return {
    day,
    time,
    location,
    timezone,
    startAt: startLocal.toUTC().toJSDate(),
    endAt: endLocal.toUTC().toJSDate(),
  };
}

function computeNextOccurrence(params: {
  now: DateTime;
  weekday: Weekday;
  timeMinutes: number;
}): DateTime {
  const { now, weekday, timeMinutes } = params;
  const hour = Math.floor(timeMinutes / 60);
  const minute = timeMinutes % 60;

  const today = now.startOf('day');
  const diff = (weekday - (today.weekday as Weekday) + 7) % 7;
  let target = today.plus({ days: diff }).set({ hour, minute, second: 0, millisecond: 0 });
  if (target <= now) {
    target = target.plus({ days: 7 });
  }
  return target;
}

async function listActiveReservationsByStartAt(params: { startAtUtc: Date[]; location: string }) {
  const startAt = params.startAtUtc;
  if (startAt.length === 0) return [];
  const [reservations, blocks] = await prisma.$transaction([
    prisma.interviewReservation.findMany({
      where: {
        startAt: { in: startAt },
        location: params.location,
        activeKey: 'ACTIVE',
      },
      select: { id: true, startAt: true, location: true },
    }),
    prisma.interviewSlotBlock.findMany({
      where: {
        startAt: { in: startAt },
        location: params.location,
      },
      select: { id: true, startAt: true, location: true },
    }),
  ]);

  return [...reservations, ...blocks];
}

async function suggestAlternatives(params: {
  config: SystemConfig;
  location: string;
  timezone: string;
  slotMinutes: number;
  limit: number;
  searchDays: number;
  now: DateTime;
}): Promise<InterviewSlot[]> {
  const { config, location, timezone, slotMinutes, limit, searchDays, now } = params;
  const availability = getWeeklyAvailability(config);
  const exceptionDates = getExceptionDates(config);

  const candidates: DateTime[] = [];
  for (let offset = 0; offset < searchDays && candidates.length < limit * 20; offset++) {
    const dayStart = now.plus({ days: offset }).startOf('day');
    const weekday = dayStart.weekday as Weekday;
    const intervals = availability[weekday] || [];
    if (intervals.length === 0) continue;
    const dateKey = dayStart.toISODate();
    if (dateKey && exceptionDates.has(dateKey)) continue;

    for (const interval of intervals) {
      let slotStartMinutes = interval.startMinutes;
      const lastStart = interval.endMinutes - slotMinutes;
      while (slotStartMinutes <= lastStart) {
        const slotStart = dayStart.set({
          hour: Math.floor(slotStartMinutes / 60),
          minute: slotStartMinutes % 60,
          second: 0,
          millisecond: 0,
        });
        if (slotStart > now) {
          candidates.push(slotStart);
        }
        slotStartMinutes += slotMinutes;
      }
    }
  }

  const uniqueCandidates = candidates
    .sort((a, b) => a.toMillis() - b.toMillis())
    .filter((dt, idx, arr) => idx === 0 || dt.toMillis() !== arr[idx - 1].toMillis());

  const startAtUtc = uniqueCandidates.slice(0, limit * 10).map(dt => dt.toUTC().toJSDate());
  const active = await listActiveReservationsByStartAt({ startAtUtc, location });
  const busy = new Set(active.map(r => new Date(r.startAt).toISOString()));

  const alternatives: InterviewSlot[] = [];
  for (const candidate of uniqueCandidates) {
    if (alternatives.length >= limit) break;
    const iso = candidate.toUTC().toJSDate().toISOString();
    if (busy.has(iso)) continue;
    if (!isSlotWithinAvailability({ startLocal: candidate, slotMinutes, availability, exceptionDates })) continue;
    alternatives.push(buildSlotFromLocal({ startLocal: candidate, slotMinutes, location, timezone }));
  }
  return alternatives;
}

function formatAlternatives(alternatives: InterviewSlot[]): string {
  if (alternatives.length === 0) return '';
  const lines = alternatives.map(slot => `- ${slot.day} ${slot.time} (${slot.location})`);
  return lines.join('\n');
}

export function resolveInterviewSlotFromDayTime(params: {
  day: string;
  time: string;
  location?: string | null;
  config: SystemConfig;
  now?: Date;
}):
  | { ok: true; slot: InterviewSlot }
  | { ok: false; reason: 'BAD_INPUT' | 'OUTSIDE_AVAILABILITY'; message: string } {
  const timezone = normalizeTimezone(params.config.interviewTimezone);
  const slotMinutes = normalizeSlotMinutes(params.config.interviewSlotMinutes);
  const requestedLocation = normalizeLocation(params.location) || getLocations(params.config)[0];

  const weekday = dayToWeekday(params.day);
  if (!weekday) {
    return {
      ok: false,
      reason: 'BAD_INPUT',
      message: 'No pude interpretar el día. Usa un día de la semana (ej: martes).',
    };
  }
  const timeMinutes = parseTimeToMinutes(params.time);
  if (timeMinutes === null) {
    return {
      ok: false,
      reason: 'BAD_INPUT',
      message: 'No pude interpretar la hora. Usa formato HH:mm (ej: 13:00).',
    };
  }

  const nowLocal = DateTime.fromJSDate(params.now || new Date(), { zone: timezone });
  const startLocal = computeNextOccurrence({ now: nowLocal, weekday, timeMinutes });
  const availability = getWeeklyAvailability(params.config);
  const exceptionDates = getExceptionDates(params.config);

  if (!isSlotWithinAvailability({ startLocal, slotMinutes, availability, exceptionDates })) {
    return {
      ok: false,
      reason: 'OUTSIDE_AVAILABILITY',
      message: 'Ese horario está fuera de la disponibilidad configurada.',
    };
  }

  const desiredSlot = buildSlotFromLocal({
    startLocal,
    slotMinutes,
    location: requestedLocation,
    timezone,
  });

  return { ok: true, slot: desiredSlot };
}

export async function attemptScheduleInterview(params: {
  conversationId: string;
  contactId: string;
  day: string | null;
  time: string | null;
  location: string | null;
  config: SystemConfig;
  now?: Date;
}): Promise<ScheduleAttemptResult> {
  const timezone = normalizeTimezone(params.config.interviewTimezone);
  const slotMinutes = normalizeSlotMinutes(params.config.interviewSlotMinutes);
  const requestedLocation = normalizeLocation(params.location) || getLocations(params.config)[0];

  if (!params.day || !params.time) {
    const alternatives = await suggestAlternatives({
      config: params.config,
      location: requestedLocation,
      timezone,
      slotMinutes,
      limit: 5,
      searchDays: 14,
      now: DateTime.fromJSDate(params.now || new Date(), { zone: timezone }),
    });
    return {
      ok: false,
      reason: 'MISSING',
      message: 'Falta día u hora para agendar. Indica por ejemplo: "martes 13:00".',
      alternatives,
    };
  }

  const weekday = dayToWeekday(params.day);
  if (!weekday) {
    const alternatives = await suggestAlternatives({
      config: params.config,
      location: requestedLocation,
      timezone,
      slotMinutes,
      limit: 5,
      searchDays: 14,
      now: DateTime.fromJSDate(params.now || new Date(), { zone: timezone }),
    });
    return {
      ok: false,
      reason: 'BAD_INPUT',
      message: 'No pude interpretar el día. Usa un día de la semana (ej: martes).',
      alternatives,
    };
  }

  const timeMinutes = parseTimeToMinutes(params.time);
  if (timeMinutes === null) {
    const alternatives = await suggestAlternatives({
      config: params.config,
      location: requestedLocation,
      timezone,
      slotMinutes,
      limit: 5,
      searchDays: 14,
      now: DateTime.fromJSDate(params.now || new Date(), { zone: timezone }),
    });
    return {
      ok: false,
      reason: 'BAD_INPUT',
      message: 'No pude interpretar la hora. Usa formato HH:mm (ej: 13:00).',
      alternatives,
    };
  }

  const nowLocal = DateTime.fromJSDate(params.now || new Date(), { zone: timezone });
  const startLocal = computeNextOccurrence({ now: nowLocal, weekday, timeMinutes });
  const availability = getWeeklyAvailability(params.config);
  const exceptionDates = getExceptionDates(params.config);

  if (!isSlotWithinAvailability({ startLocal, slotMinutes, availability, exceptionDates })) {
    const alternatives = await suggestAlternatives({
      config: params.config,
      location: requestedLocation,
      timezone,
      slotMinutes,
      limit: 5,
      searchDays: 14,
      now: nowLocal,
    });
    return {
      ok: false,
      reason: 'OUTSIDE_AVAILABILITY',
      message: 'Ese horario está fuera de la disponibilidad configurada.',
      alternatives,
    };
  }

  const desiredSlot = buildSlotFromLocal({
    startLocal,
    slotMinutes,
    location: requestedLocation,
    timezone,
  });

  const blocked = await prisma.interviewSlotBlock.findFirst({
    where: {
      startAt: desiredSlot.startAt,
      location: desiredSlot.location,
    },
    select: { id: true },
  });
  if (blocked) {
    const alternatives = await suggestAlternatives({
      config: params.config,
      location: requestedLocation,
      timezone,
      slotMinutes,
      limit: 5,
      searchDays: 14,
      now: nowLocal,
    });
    return {
      ok: false,
      reason: 'CONFLICT',
      message: 'Ese horario ya está ocupado.',
      alternatives,
    };
  }

  try {
    const result = await prisma.$transaction(async tx => {
      const existingActive = await tx.interviewReservation.findFirst({
        where: { conversationId: params.conversationId, activeKey: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
      });

      const desiredStartIso = desiredSlot.startAt.toISOString();
      if (
        existingActive &&
        existingActive.location === desiredSlot.location &&
        existingActive.startAt.toISOString() === desiredStartIso
      ) {
        await tx.interviewReservation.update({
          where: { id: existingActive.id },
          data: {
            status: 'PENDING',
            timezone: desiredSlot.timezone,
            endAt: desiredSlot.endAt,
          },
        });
        return {
          kind: 'UNCHANGED' as const,
          reservationId: existingActive.id,
          previousReservationId: existingActive.id,
        };
      }

      const created = await tx.interviewReservation.create({
        data: {
          conversationId: params.conversationId,
          contactId: params.contactId,
          startAt: desiredSlot.startAt,
          endAt: desiredSlot.endAt,
          timezone: desiredSlot.timezone,
          location: desiredSlot.location,
          activeKey: 'ACTIVE',
          status: 'PENDING',
        },
      });

      if (existingActive) {
        await tx.interviewReservation.update({
          where: { id: existingActive.id },
          data: {
            status: 'RESCHEDULED',
            activeKey: null,
          },
        });
      }

      return {
        kind: existingActive ? ('RESCHEDULED' as const) : ('SCHEDULED' as const),
        reservationId: created.id,
        previousReservationId: existingActive?.id ?? null,
      };
    });

    return {
      ok: true,
      kind: result.kind,
      slot: desiredSlot,
      reservationId: result.reservationId,
      previousReservationId: result.previousReservationId,
    };
  } catch (err: any) {
    const isUnique =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
    if (!isUnique) {
      throw err;
    }

    const alternatives = await suggestAlternatives({
      config: params.config,
      location: requestedLocation,
      timezone,
      slotMinutes,
      limit: 5,
      searchDays: 14,
      now: nowLocal,
    });

    return {
      ok: false,
      reason: 'CONFLICT',
      message: 'Ese horario ya está ocupado.',
      alternatives,
    };
  }
}

export async function releaseActiveReservation(params: {
  conversationId: string;
  status: 'CANCELLED' | 'ON_HOLD';
}): Promise<{ released: boolean; reservationId: string | null }> {
  const existing = await prisma.interviewReservation.findFirst({
    where: { conversationId: params.conversationId, activeKey: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!existing) return { released: false, reservationId: null };
  await prisma.interviewReservation.update({
    where: { id: existing.id },
    data: {
      status: params.status,
      activeKey: null,
    },
  });
  return { released: true, reservationId: existing.id };
}

export async function confirmActiveReservation(conversationId: string): Promise<{ updated: boolean; reservationId: string | null }> {
  const existing = await prisma.interviewReservation.findFirst({
    where: { conversationId, activeKey: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!existing) return { updated: false, reservationId: null };
  await prisma.interviewReservation.update({
    where: { id: existing.id },
    data: { status: 'CONFIRMED' },
  });
  return { updated: true, reservationId: existing.id };
}

export function formatSlotHuman(slot: { day: string; time: string; location: string }): string {
  const when = `${slot.day} ${slot.time}`.trim();
  return slot.location ? `${when}, ${slot.location}` : when;
}

export function formatAlternativesHuman(alternatives: InterviewSlot[]): string {
  const body = formatAlternatives(alternatives);
  return body ? `Opciones:\n${body}` : '';
}
