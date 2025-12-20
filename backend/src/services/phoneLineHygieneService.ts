import { prisma } from '../db/client';
import { serializeJson } from '../utils/json';
import { normalizeChilePhoneE164 } from '../utils/phone';

type Logger = { info: (obj: any, msg?: string) => void; warn: (obj: any, msg?: string) => void };

type HygieneResult = {
  scanned: number;
  normalized: number;
  sanitized: number;
};

export async function runPhoneLinePhoneE164Hygiene(params?: { logger?: Logger }): Promise<HygieneResult> {
  const logger = params?.logger;
  const lines = await prisma.phoneLine.findMany({
    where: { archivedAt: null, phoneE164: { not: null } },
    select: { id: true, workspaceId: true, phoneE164: true, needsAttention: true },
  });

  let normalized = 0;
  let sanitized = 0;

  for (const line of lines) {
    const raw = String(line.phoneE164 || '').trim();
    if (!raw) continue;

    try {
      const next = normalizeChilePhoneE164(raw);
      if (!next) continue;
      if (next !== raw) {
        await prisma.phoneLine
          .update({
            where: { id: line.id },
            data: { phoneE164: next, needsAttention: false },
          })
          .catch(() => null);
        normalized += 1;
        await prisma.configChangeLog
          .create({
            data: {
              workspaceId: line.workspaceId,
              userId: null,
              type: 'PHONE_LINE_PHONE_E164_NORMALIZED',
              beforeJson: serializeJson({ phoneLineId: line.id, phoneE164: 'redacted' }),
              afterJson: serializeJson({ phoneLineId: line.id, phoneE164: next }),
            },
          })
          .catch(() => {});
      } else if (line.needsAttention) {
        await prisma.phoneLine
          .update({
            where: { id: line.id },
            data: { needsAttention: false },
          })
          .catch(() => null);
      }
    } catch {
      await prisma.phoneLine
        .update({
          where: { id: line.id },
          data: { phoneE164: null, needsAttention: true },
        })
        .catch(() => null);
      sanitized += 1;
      await prisma.configChangeLog
        .create({
          data: {
            workspaceId: line.workspaceId,
            userId: null,
            type: 'PHONE_LINE_PHONE_E164_SANITIZED',
            beforeJson: serializeJson({ phoneLineId: line.id, phoneE164: 'redacted' }),
            afterJson: serializeJson({ phoneLineId: line.id, phoneE164: null, needsAttention: true }),
          },
        })
        .catch(() => {});
    }
  }

  const result: HygieneResult = { scanned: lines.length, normalized, sanitized };
  if (logger) {
    if (result.normalized || result.sanitized) {
      logger.info({ phoneLines: result }, 'PhoneLine hygiene: phoneE164 normalized/sanitized');
    } else {
      logger.info({ phoneLines: result }, 'PhoneLine hygiene: no changes');
    }
  }
  return result;
}

