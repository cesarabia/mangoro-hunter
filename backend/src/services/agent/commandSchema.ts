import { z } from 'zod';

const JsonRecordSchema = z.record(z.string(), z.unknown());

export const AgentCommandUpsertProfileFieldsSchema = z.object({
  command: z.literal('UPSERT_PROFILE_FIELDS'),
  contactId: z.string().min(1),
  patch: z
    .object({
      candidateName: z.string().min(1).nullable().optional(),
      email: z.string().min(1).nullable().optional(),
      rut: z.string().min(1).nullable().optional(),
      comuna: z.string().min(1).nullable().optional(),
      ciudad: z.string().min(1).nullable().optional(),
      region: z.string().min(1).nullable().optional(),
      experienceYears: z.number().int().min(0).max(80).nullable().optional(),
      terrainExperience: z.boolean().nullable().optional(),
      availabilityText: z.string().min(1).nullable().optional(),
    })
    .strict(),
  confidenceByField: z.record(z.string(), z.number().min(0).max(1)).optional(),
  sourceMessageId: z.string().min(1).optional(),
});

export const AgentCommandSetConversationStatusSchema = z.object({
  command: z.literal('SET_CONVERSATION_STATUS'),
  conversationId: z.string().min(1),
  status: z.enum(['NEW', 'OPEN', 'CLOSED']),
  reason: z.string().min(1).optional(),
});

export const AgentCommandSetConversationStageSchema = z.object({
  command: z.literal('SET_CONVERSATION_STAGE'),
  conversationId: z.string().min(1),
  stage: z.string().min(1),
  reason: z.string().min(1).optional(),
});

export const AgentCommandSetConversationProgramSchema = z.object({
  command: z.literal('SET_CONVERSATION_PROGRAM'),
  conversationId: z.string().min(1),
  programId: z.string().min(1),
  reason: z.string().min(1).optional(),
});

export const AgentCommandAddConversationNoteSchema = z.object({
  command: z.literal('ADD_CONVERSATION_NOTE'),
  conversationId: z.string().min(1),
  note: z.string().min(1),
  visibility: z.enum(['SYSTEM', 'ADMIN']).default('SYSTEM'),
});

export const AgentCommandSetNoContactarSchema = z.object({
  command: z.literal('SET_NO_CONTACTAR'),
  contactId: z.string().min(1),
  value: z.boolean(),
  reason: z.string().min(1),
});

export const AgentCommandScheduleInterviewSchema = z.object({
  command: z.literal('SCHEDULE_INTERVIEW'),
  conversationId: z.string().min(1),
  datetimeISO: z.string().min(1).optional(),
  day: z.string().min(1).optional(),
  time: z.string().min(1).optional(),
  locationText: z.string().min(1).optional(),
  requiresConfirmation: z.boolean().default(true),
});

export const AgentCommandSendMessageSchema = z.object({
  command: z.literal('SEND_MESSAGE'),
  conversationId: z.string().min(1),
  channel: z.literal('WHATSAPP'),
  type: z.enum(['SESSION_TEXT', 'TEMPLATE']),
  text: z.string().min(1).optional(),
  templateName: z.string().min(1).optional(),
  templateVars: z.record(z.string(), z.string()).optional(),
  dedupeKey: z.string().min(1),
});

export const AgentCommandNotifyAdminSchema = z.object({
  command: z.literal('NOTIFY_ADMIN'),
  workspaceId: z.string().min(1),
  eventType: z.string().min(1),
  severity: z.enum(['INFO', 'WARN', 'ERROR']).default('INFO'),
  text: z.string().min(1),
  conversationId: z.string().min(1).optional(),
});

export const AgentCommandRunToolSchema = z.object({
  command: z.literal('RUN_TOOL'),
  toolName: z.string().min(1),
  args: JsonRecordSchema.optional(),
});

export const AgentCommandSchema = z.discriminatedUnion('command', [
  AgentCommandUpsertProfileFieldsSchema,
  AgentCommandSetConversationStatusSchema,
  AgentCommandSetConversationStageSchema,
  AgentCommandSetConversationProgramSchema,
  AgentCommandAddConversationNoteSchema,
  AgentCommandSetNoContactarSchema,
  AgentCommandScheduleInterviewSchema,
  AgentCommandSendMessageSchema,
  AgentCommandNotifyAdminSchema,
  AgentCommandRunToolSchema,
]);

export type AgentCommand = z.infer<typeof AgentCommandSchema>;

export const AgentResponseSchema = z.object({
  agent: z.string().min(1),
  version: z.number().int().min(1),
  commands: z.array(AgentCommandSchema),
  notes: z.string().optional(),
});

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

