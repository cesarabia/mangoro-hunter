import { prisma } from '../db/client';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { getWorkspaceDefaultStageSlug } from './workspaceStageService';

export async function ensureStaffConversation(params: {
  workspaceId: string;
  phoneLineId: string;
  staffWaId: string;
  staffLabel: string;
  staffProgramId?: string | null;
}): Promise<{ contact: any; conversation: any }> {
  const waId = normalizeWhatsAppId(params.staffWaId);
  if (!waId) throw new Error('staff_wa_invalid');

  let contact = await prisma.contact.findFirst({
    where: {
      workspaceId: params.workspaceId,
      OR: [{ waId }, { phone: waId }, { phone: `+${waId}` }],
    },
  });
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        workspaceId: params.workspaceId,
        waId,
        phone: `+${waId}`,
        displayName: params.staffLabel,
        name: params.staffLabel,
      } as any,
    });
  } else {
    const patch: any = {};
    if (!contact.waId) patch.waId = waId;
    if (!contact.phone) patch.phone = `+${waId}`;
    if (!contact.displayName) patch.displayName = params.staffLabel;
    if (!contact.name) patch.name = params.staffLabel;
    if (Object.keys(patch).length > 0) {
      contact = await prisma.contact.update({ where: { id: contact.id }, data: patch });
    }
  }

  let conversation = await prisma.conversation.findFirst({
    where: {
      workspaceId: params.workspaceId,
      phoneLineId: params.phoneLineId,
      contactId: contact.id,
      isAdmin: false,
      archivedAt: null,
      conversationKind: 'STAFF',
    } as any,
    orderBy: { updatedAt: 'desc' },
  });
  if (!conversation) {
    const defaultStageSlug = await getWorkspaceDefaultStageSlug(params.workspaceId).catch(() => 'NEW_INTAKE');
    conversation = await prisma.conversation.create({
      data: {
        workspaceId: params.workspaceId,
        phoneLineId: params.phoneLineId,
        programId: params.staffProgramId || null,
        contactId: contact.id,
        status: 'OPEN',
        conversationStage: defaultStageSlug,
        stageChangedAt: new Date(),
        channel: 'whatsapp',
        isAdmin: false,
        aiMode: 'OFF',
        conversationKind: 'STAFF',
      } as any,
    });
  } else if (!conversation.programId && params.staffProgramId) {
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { programId: params.staffProgramId, updatedAt: new Date() },
    });
  }

  return { contact, conversation };
}

export async function ensurePartnerConversation(params: {
  workspaceId: string;
  phoneLineId: string;
  partnerWaId: string;
  partnerLabel: string;
  partnerProgramId?: string | null;
}): Promise<{ contact: any; conversation: any }> {
  const waId = normalizeWhatsAppId(params.partnerWaId);
  if (!waId) throw new Error('partner_wa_invalid');

  let contact = await prisma.contact.findFirst({
    where: {
      workspaceId: params.workspaceId,
      OR: [{ waId }, { phone: waId }, { phone: `+${waId}` }],
    },
  });
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        workspaceId: params.workspaceId,
        waId,
        phone: `+${waId}`,
        displayName: params.partnerLabel,
        name: params.partnerLabel,
      } as any,
    });
  } else {
    const patch: any = {};
    if (!contact.waId) patch.waId = waId;
    if (!contact.phone) patch.phone = `+${waId}`;
    if (!contact.displayName) patch.displayName = params.partnerLabel;
    if (!contact.name) patch.name = params.partnerLabel;
    if (Object.keys(patch).length > 0) {
      contact = await prisma.contact.update({ where: { id: contact.id }, data: patch });
    }
  }

  let conversation = await prisma.conversation.findFirst({
    where: {
      workspaceId: params.workspaceId,
      phoneLineId: params.phoneLineId,
      contactId: contact.id,
      isAdmin: false,
      archivedAt: null,
      conversationKind: 'PARTNER',
    } as any,
    orderBy: { updatedAt: 'desc' },
  });
  if (!conversation) {
    const defaultStageSlug = await getWorkspaceDefaultStageSlug(params.workspaceId).catch(() => 'NEW_INTAKE');
    conversation = await prisma.conversation.create({
      data: {
        workspaceId: params.workspaceId,
        phoneLineId: params.phoneLineId,
        programId: params.partnerProgramId || null,
        contactId: contact.id,
        status: 'OPEN',
        conversationStage: defaultStageSlug,
        stageChangedAt: new Date(),
        channel: 'whatsapp',
        isAdmin: false,
        aiMode: 'OFF',
        conversationKind: 'PARTNER',
      } as any,
    });
  } else if (!conversation.programId && params.partnerProgramId) {
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { programId: params.partnerProgramId, updatedAt: new Date() },
    });
  }

  return { contact, conversation };
}
