import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';

export type InboundPhoneLineRoutingResult =
  | { kind: 'RESOLVED'; workspaceId: string; phoneLineId: string }
  | { kind: 'NOT_FOUND'; waPhoneNumberId: string }
  | { kind: 'AMBIGUOUS'; waPhoneNumberId: string; matches: Array<{ workspaceId: string; phoneLineId: string }> };

export async function resolveInboundPhoneLineRouting(params: {
  waPhoneNumberId?: string | null;
}): Promise<InboundPhoneLineRoutingResult> {
  const raw = String(params.waPhoneNumberId || '').trim();
  // Simulation/internal calls may omit phone_number_id: fall back to default workspace/line.
  if (!raw) return { kind: 'RESOLVED', workspaceId: 'default', phoneLineId: 'default' };

  const matches = await prisma.phoneLine
    .findMany({
      where: {
        waPhoneNumberId: raw,
        archivedAt: null,
        isActive: true,
        workspace: { isSandbox: false, archivedAt: null },
      },
      select: { id: true, workspaceId: true },
      take: 3,
    })
    .catch(() => []);

  if (matches.length === 1) {
    return { kind: 'RESOLVED', workspaceId: matches[0].workspaceId, phoneLineId: matches[0].id };
  }
  if (matches.length === 0) {
    return { kind: 'NOT_FOUND', waPhoneNumberId: raw };
  }
  return {
    kind: 'AMBIGUOUS',
    waPhoneNumberId: raw,
    matches: matches.map((m) => ({ workspaceId: m.workspaceId, phoneLineId: m.id })),
  };
}

export async function logInboundRoutingError(params: {
  app: { log: any };
  kind: 'NOT_FOUND' | 'AMBIGUOUS';
  waPhoneNumberId: string;
  waMessageId: string | null;
  from: string;
  matches?: Array<{ workspaceId: string; phoneLineId: string }>;
}) {
  const baseMeta = {
    waPhoneNumberId: params.waPhoneNumberId || null,
    waMessageId: params.waMessageId || null,
    from: params.from,
  };

  if (params.kind === 'NOT_FOUND') {
    params.app.log.error(
      { ...baseMeta, event: 'INBOUND_PHONE_LINE_NOT_FOUND' },
      'Inbound WhatsApp: phone_number_id no mapeado a ningún PhoneLine activo.',
    );
    await prisma.automationRunLog
      .create({
        data: {
          workspaceId: 'default',
          ruleId: null,
          conversationId: null,
          eventType: 'INBOUND_PHONE_LINE_NOT_FOUND',
          status: 'ERROR',
          inputJson: serializeJson({
            waPhoneNumberId: params.waPhoneNumberId,
            waMessageId: params.waMessageId,
            from: params.from,
          }),
          outputJson: null,
          error: `No existe PhoneLine activo para waPhoneNumberId=${params.waPhoneNumberId}`,
        } as any,
      })
      .catch(() => {});
    return;
  }

  const matches = Array.isArray(params.matches) ? params.matches : [];
  params.app.log.error(
    { ...baseMeta, event: 'INBOUND_PHONE_LINE_AMBIGUOUS', matches },
    'Inbound WhatsApp: phone_number_id ambiguo (más de un workspace con PhoneLine activo).',
  );

  const uniqueWorkspaceIds = Array.from(new Set(matches.map((m) => m.workspaceId)));
  await Promise.all(
    uniqueWorkspaceIds.map((wid) =>
      prisma.automationRunLog
        .create({
          data: {
            workspaceId: wid,
            ruleId: null,
            conversationId: null,
            eventType: 'INBOUND_PHONE_LINE_AMBIGUOUS',
            status: 'ERROR',
            inputJson: serializeJson({
              waPhoneNumberId: params.waPhoneNumberId,
              waMessageId: params.waMessageId,
              from: params.from,
              matches,
            }),
            outputJson: null,
            error: `Más de un PhoneLine activo para waPhoneNumberId=${params.waPhoneNumberId}. Resolver duplicado (mover/archivar).`,
          } as any,
        })
        .catch(() => {}),
    ),
  );
}

