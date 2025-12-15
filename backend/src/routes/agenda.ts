import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client';
import {
  DEFAULT_INTERVIEW_SLOT_MINUTES,
  DEFAULT_INTERVIEW_TIMEZONE,
  getSystemConfig
} from '../services/configService';
import { getContactDisplayName } from '../utils/contactDisplay';

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
}

function isAdmin(request: any): boolean {
  return request.user?.role === 'ADMIN';
}
