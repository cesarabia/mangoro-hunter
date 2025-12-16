import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import {
  DEFAULT_INTERVIEW_SLOT_MINUTES,
  DEFAULT_INTERVIEW_TIMEZONE,
  getSystemConfig
} from '../services/configService';
import { getContactDisplayName } from '../utils/contactDisplay';
import { resolveInterviewSlotFromDayTime } from '../services/interviewSchedulerService';

export async function registerAgendaRoutes(app: FastifyInstance) {
  app.get('/reservations', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const query = request.query as {
      from?: string;
      to?: string;
      days?: string;
      includeInactive?: string;
    };

    const now = new Date();
    const daysRaw = query?.days ? parseInt(query.days, 10) : 14;
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 60 ? daysRaw : 14;
    const from = query?.from ? new Date(query.from) : now;
    const to = query?.to ? new Date(query.to) : new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return reply.code(400).send({ error: 'Parámetros "from/to" inválidos. Usa ISO 8601.' });
    }

    const includeInactive = query?.includeInactive === 'true';
    const config = await getSystemConfig();

    const reservations = await prisma.interviewReservation.findMany({
      where: {
        startAt: { gte: from, lt: to },
        ...(includeInactive ? {} : { activeKey: 'ACTIVE' })
      },
      orderBy: { startAt: 'asc' },
      include: {
        contact: true,
        conversation: true
      }
    });

    return {
      timezone: config.interviewTimezone || DEFAULT_INTERVIEW_TIMEZONE,
      slotMinutes: config.interviewSlotMinutes || DEFAULT_INTERVIEW_SLOT_MINUTES,
      from: from.toISOString(),
      to: to.toISOString(),
      includeInactive,
      reservations: reservations.map(reservation => ({
        id: reservation.id,
        conversationId: reservation.conversationId,
        contactId: reservation.contactId,
        contactWaId: reservation.contact?.waId || null,
        contactName: reservation.contact ? getContactDisplayName(reservation.contact) : null,
        startAt: reservation.startAt.toISOString(),
        endAt: reservation.endAt.toISOString(),
        timezone: reservation.timezone,
        location: reservation.location,
        status: reservation.status,
        active: reservation.activeKey === 'ACTIVE',
        interviewStatus: reservation.conversation?.interviewStatus || null,
        createdAt: reservation.createdAt.toISOString(),
        updatedAt: reservation.updatedAt.toISOString()
      }))
    };
  });

  app.post('/blocks', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = request.body as {
      day?: string;
      time?: string;
      location?: string | null;
      reason?: string | null;
      tag?: string | null;
    };

    const day = (body.day || '').trim();
    const time = (body.time || '').trim();
    if (!day || !time) {
      return reply.code(400).send({ error: '"day" y "time" son obligatorios (ej: Martes, 13:00).' });
    }

    const config = await getSystemConfig();
    const resolved = resolveInterviewSlotFromDayTime({
      day,
      time,
      location: body.location ?? null,
      config
    });
    if (!resolved.ok) {
      return reply.code(400).send({ error: resolved.message });
    }

    const reason = typeof body.reason === 'string' ? body.reason.trim() : null;
    const tag = typeof body.tag === 'string' ? body.tag.trim() : null;

    try {
      const block = await prisma.interviewSlotBlock.create({
        data: {
          startAt: resolved.slot.startAt,
          endAt: resolved.slot.endAt,
          timezone: resolved.slot.timezone,
          location: resolved.slot.location,
          reason: reason && reason.length > 0 ? reason : null,
          tag: tag && tag.length > 0 ? tag : null
        }
      });

      return {
        ok: true,
        block: {
          id: block.id,
          startAt: block.startAt.toISOString(),
          endAt: block.endAt.toISOString(),
          timezone: block.timezone,
          location: block.location,
          reason: block.reason,
          tag: block.tag
        }
      };
    } catch (err: any) {
      // Unique constraint => already blocked
      const existing = await prisma.interviewSlotBlock.findFirst({
        where: { startAt: resolved.slot.startAt, location: resolved.slot.location },
        orderBy: { createdAt: 'desc' }
      });
      if (!existing) {
        request.log.error({ err }, 'No se pudo crear bloqueo agenda');
        return reply.code(500).send({ error: 'No se pudo crear el bloqueo.' });
      }

      if (existing.archivedAt) {
        const revived = await prisma.interviewSlotBlock.update({
          where: { id: existing.id },
          data: {
            archivedAt: null,
            endAt: resolved.slot.endAt,
            timezone: resolved.slot.timezone,
            reason: reason && reason.length > 0 ? reason : null,
            tag: tag && tag.length > 0 ? tag : null
          }
        });
        return {
          ok: true,
          block: {
            id: revived.id,
            startAt: revived.startAt.toISOString(),
            endAt: revived.endAt.toISOString(),
            timezone: revived.timezone,
            location: revived.location,
            reason: revived.reason,
            tag: revived.tag
          },
          revived: true
        };
      }
      return {
        ok: true,
        block: {
          id: existing.id,
          startAt: existing.startAt.toISOString(),
          endAt: existing.endAt.toISOString(),
          timezone: existing.timezone,
          location: existing.location,
          reason: existing.reason,
          tag: existing.tag
        },
        alreadyExisted: true
      };
    }
  });

  app.delete('/blocks/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { id } = request.params as { id: string };
    try {
      await prisma.interviewSlotBlock.update({
        where: { id },
        data: { archivedAt: new Date() }
      });
      return { ok: true };
    } catch {
      return reply.code(404).send({ error: 'Bloqueo no encontrado' });
    }
  });
}

function isAdmin(request: any): boolean {
  return request.user?.role === 'ADMIN';
}
