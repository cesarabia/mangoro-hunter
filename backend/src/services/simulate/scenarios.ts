export type ScenarioStep = {
  inboundText: string;
  inboundOffsetHours?: number;
  action?: 'INBOUND_MESSAGE' | 'AI_SUGGEST' | 'WORKSPACE_CHECK';
  setProgramSlug?: string;
  expect?: {
    contactFields?: Array<
      'candidateName' | 'comuna' | 'ciudad' | 'region' | 'rut' | 'email' | 'availabilityText'
    >;
    stage?: string;
    programIdSet?: boolean;
    agentRun?: {
      eventType?: string;
      programSlug?: string;
      status?: string;
    };
    outbound?: {
      sentDelta?: number;
      blockedDelta?: number;
      lastBlockedReasonContains?: string;
      lastTextContains?: string[];
      lastTextNotContains?: string[];
    };
    workspaceSetup?: {
      workspaceId: string;
      programsSlugs?: string[];
      inboundRunAgentEnabled?: boolean;
      invites?: Array<{ email: string; role: string; assignedOnly?: boolean }>;
      ownerEmail?: string;
      ownerOnlyThisWorkspace?: boolean;
      assignmentFlow?: {
        memberEmail: string;
      };
    };
    phoneLineDuplicateConflict?: {
      /** Optional override; by default the scenario generates a unique waPhoneNumberId. */
      waPhoneNumberId?: string;
    };
    inboundRoutingSingleOwner?: {
      /** Optional override; by default the scenario generates a unique waPhoneNumberId. */
      waPhoneNumberId?: string;
    };
    inboundRoutingDefaultProgram?: {
      /** Optional override; by default the scenario generates a unique waPhoneNumberId. */
      waPhoneNumberId?: string;
    };
    inboundProgramMenu?: {
      /** Optional override; by default the scenario generates a unique waPhoneNumberId. */
      waPhoneNumberId?: string;
    };
    platformSuperadminGate?: boolean;
    ssclinicalStageAssign?: {
      workspaceId?: string;
    };
    ssclinicalHandoffInteresadoNotification?: {
      workspaceId?: string;
    };
    stageAdminConfigurable?: {
      workspaceId?: string;
      slug?: string;
    };
    stageDefinitionsCrudBasic?: {
      workspaceId?: string;
      slug?: string;
    };
    inviteExistingUserAccept?: boolean;
    copilotArchiveRestore?: boolean;
    copilotContextFollowup?: boolean;
  };
};

export type ScenarioDefinition = {
  id: string;
  name: string;
  description: string;
  programSlug?: string;
  contactWaId?: string | null;
  contactNoContact?: boolean;
  steps: ScenarioStep[];
};

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: 'admin_hola_responde',
    name: 'Admin: Hola responde',
    description: 'Valida que el número admin (allowlist) recibe respuesta ante "Hola" (sin bloqueo).',
    contactWaId: '56982345846',
    steps: [
      { inboundText: 'Hola', expect: { outbound: { sentDelta: 1 } } },
    ],
  },
  {
    id: 'test_hola_responde',
    name: 'Test: Hola responde',
    description: 'Valida que el número de prueba (allowlist) recibe respuesta ante "Hola" (sin bloqueo).',
    contactWaId: '56994830202',
    steps: [
      { inboundText: 'Hola', expect: { outbound: { sentDelta: 1 } } },
    ],
  },
  {
    id: 'location_loop_rm',
    name: 'Loop comuna/ciudad (RM)',
    description:
      'Reproduce el caso donde el candidato envía comuna/ciudad en formatos mixtos para evitar loops.',
    programSlug: 'recruitment',
    steps: [
      {
        inboundText: '✅ Santiago/Ñuñoa / Región Metropolitana / RUT 12.345.678-9',
        expect: {
          outbound: {
            lastTextNotContains: [
              'comuna/ciudad',
              'comuna y ciudad',
              'me falta comuna',
              'me falta la comuna',
              'me falta ciudad',
              'me falta la ciudad',
              'cual es tu comuna',
              'cual es tu ciudad',
            ],
          },
        },
      },
      {
        inboundText: 'Tengo disponibilidad inmediata',
        expect: {
          outbound: {
            lastTextNotContains: ['comuna/ciudad', 'comuna y ciudad'],
          },
        },
      },
    ],
  },
  {
    id: 'displayname_garbage',
    name: 'DisplayName basura ≠ candidateName',
    description: 'Valida que frases tipo "Más información" no se usen como candidateName.',
    programSlug: 'recruitment',
    steps: [
      { inboundText: 'Más información', expect: { contactFields: [] } },
      { inboundText: 'Me llamo Pablo Urrutia Rivas', expect: { contactFields: ['candidateName'] } },
    ],
  },
  {
    id: 'program_menu_dedupe',
    name: 'Anti-loop: dedupeKey evita duplicados',
    description: 'Dispara el menú de selección de Program dos veces y verifica que el segundo envío queda bloqueado.',
    steps: [
      { inboundText: 'Hola', expect: { outbound: { sentDelta: 1, lastTextContains: ['¿Sobre qué programa', 'Responde con el número'] } } },
      { inboundText: 'Hola', expect: { outbound: { blockedDelta: 1, lastBlockedReasonContains: 'ANTI_LOOP' } } },
    ],
  },
  {
    id: 'window_24h_template',
    name: 'Guardrail 24h: bloquea SESSION_TEXT',
    description: 'Si la conversación está fuera de 24h, se bloquea SESSION_TEXT (requiere TEMPLATE).',
    steps: [
      {
        inboundText: 'Hola',
        inboundOffsetHours: -26,
        expect: { outbound: { blockedDelta: 1, lastBlockedReasonContains: 'OUTSIDE_24H' } },
      },
    ],
  },
  {
    id: 'safe_mode_block',
    name: 'SAFE MODE: bloquea fuera allowlist',
    description: 'En ALLOWLIST_ONLY, bloquear envíos a waId fuera de allowlist y dejar blockedReason.',
    // Nota: esto corre en workspace sandbox y NO envía WhatsApp real.
    // Evita usar teléfonos sintéticos que parezcan reales: usamos un waId no-numérico solo para sandbox.
    contactWaId: 'sandbox-not-allowed',
    steps: [
      { inboundText: 'Hola', expect: { outbound: { blockedDelta: 1, lastBlockedReasonContains: 'SAFE_OUTBOUND' } } },
    ],
  },
  {
    id: 'no_contactar_block',
    name: 'NO_CONTACTAR: bloquea outbound',
    description: 'Si el contacto está NO_CONTACTAR, el sistema bloquea cualquier envío.',
    contactNoContact: true,
    steps: [
      { inboundText: 'Hola', expect: { outbound: { blockedDelta: 1, lastBlockedReasonContains: 'NO_CONTACTAR' } } },
    ],
  },
  {
    id: 'program_select_assign',
    name: 'Programs: menú y asignación por opción',
    description: 'Si una conversación no tiene Program y hay varios activos, muestra menú y asigna al elegir 1/2/3.',
    steps: [
      { inboundText: 'Hola', expect: { outbound: { sentDelta: 1, lastTextContains: ['¿Sobre qué programa', 'Responde con el número'] } } },
      { inboundText: '1', expect: { programIdSet: true } },
    ],
  },
  {
    id: 'program_switch_inbound',
    name: 'Program switch: inbound usa Program actual',
    description: 'Al cambiar Program en la conversación, el siguiente inbound debe correr con el Program nuevo.',
    programSlug: 'recruitment',
    contactWaId: 'sandbox',
    steps: [
      { inboundText: 'Hola', expect: { agentRun: { eventType: 'INBOUND_MESSAGE', programSlug: 'recruitment' } } },
      { setProgramSlug: 'sales', inboundText: 'Hola', expect: { agentRun: { eventType: 'INBOUND_MESSAGE', programSlug: 'sales' } } },
    ],
  },
  {
    id: 'program_switch_suggest',
    name: 'Program switch: Sugerir respeta Program',
    description: 'El endpoint de sugerencias debe usar el Program actual de la conversación (no legacy aiMode).',
    programSlug: 'recruitment',
    contactWaId: 'sandbox',
    steps: [
      { inboundText: 'Hola', expect: { agentRun: { eventType: 'INBOUND_MESSAGE', programSlug: 'recruitment' } } },
      { setProgramSlug: 'sales', action: 'AI_SUGGEST', inboundText: 'Necesito un pitch corto para suero terapia', expect: { agentRun: { eventType: 'AI_SUGGEST', programSlug: 'sales' } } },
    ],
  },
  {
    id: 'program_switch_suggest_and_inbound',
    name: 'Program switch: Sugerir + inbound (consistencia total)',
    description:
      'Al cambiar Program en la conversación, tanto Sugerir como el siguiente inbound deben usar el Program nuevo.',
    programSlug: 'recruitment',
    contactWaId: 'sandbox',
    steps: [
      { inboundText: 'Hola', expect: { agentRun: { eventType: 'INBOUND_MESSAGE', programSlug: 'recruitment' } } },
      {
        setProgramSlug: 'sales',
        action: 'AI_SUGGEST',
        inboundText: 'Necesito un pitch corto para suero terapia',
        expect: { agentRun: { eventType: 'AI_SUGGEST', programSlug: 'sales' } },
      },
      { inboundText: 'Hola', expect: { agentRun: { eventType: 'INBOUND_MESSAGE', programSlug: 'sales' } } },
    ],
  },
  {
    id: 'wa_number_duplicate_conflict',
    name: 'PhoneLines: conflicto waPhoneNumberId (cross-workspace)',
    description:
      'Valida que un waPhoneNumberId activo no pueda existir en 2 workspaces: el segundo intento debe fallar con 409 + payload de conflicto.',
    steps: [
      { action: 'WORKSPACE_CHECK', inboundText: 'check waPhoneNumberId conflict', expect: { phoneLineDuplicateConflict: {} } },
    ],
  },
  {
    id: 'inbound_routing_single_owner',
    name: 'Inbound routing: single owner (phoneLine resuelto)',
    description:
      'Valida que un inbound con phone_number_id se enruta a un único workspace/PhoneLine; si hay 1 match, crea conversación en ese workspace.',
    steps: [
      { action: 'WORKSPACE_CHECK', inboundText: 'check inbound routing', expect: { inboundRoutingSingleOwner: {} } },
    ],
  },
  {
    id: 'inbound_routing_default_program',
    name: 'Inbound routing: aplica Default Program de PhoneLine',
    description:
      'Valida que, si una conversación existe sin programId, al entrar un INBOUND se setea programId desde PhoneLine.defaultProgramId.',
    steps: [
      { action: 'WORKSPACE_CHECK', inboundText: 'check inbound default program', expect: { inboundRoutingDefaultProgram: {} } },
    ],
  },
  {
    id: 'inbound_program_menu',
    name: 'PhoneLines: inbound modo Menú de Programs',
    description:
      'Valida que un PhoneLine con inboundMode=MENU muestre un menú limitado a Programs permitidos y permita asignar Program por opción.',
    steps: [
      { action: 'WORKSPACE_CHECK', inboundText: 'check inbound program menu', expect: { inboundProgramMenu: {} } },
    ],
  },
  {
    id: 'invite_existing_user_accept',
    name: 'Invites: aceptar usuario existente',
    description:
      'Valida que un usuario ya existente pueda aceptar una invitación sin reset de password (accept-existing).',
    steps: [{ action: 'WORKSPACE_CHECK', inboundText: 'check invite accept existing', expect: { inviteExistingUserAccept: true } }],
  },
  {
    id: 'copilot_archive_restore',
    name: 'Copilot: archivar y restaurar thread',
    description:
      'Valida que un hilo de Copilot se pueda archivar y restaurar, y que el historial lo refleje.',
    steps: [{ action: 'WORKSPACE_CHECK', inboundText: 'check copilot archive restore', expect: { copilotArchiveRestore: true } }],
  },
  {
    id: 'ssclinical_onboarding',
    name: 'SSClinical: setup onboarding (multi-cliente)',
    description:
      'Valida que SSClinical esté sembrado (Programs + inbound RUN_AGENT) y que existan invitaciones piloto.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check ssclinical',
        expect: {
          workspaceSetup: {
            workspaceId: 'ssclinical',
            programsSlugs: [
              'coordinadora-ssclinical-suero-hidratante-y-terapia',
              'enfermera-lider-coordinadora',
              'enfermera-domicilio',
              'medico-orden-medica',
            ],
            inboundRunAgentEnabled: true,
            invites: [
              { email: 'csarabia@ssclinical.cl', role: 'OWNER' },
              { email: 'contacto@ssclinical.cl', role: 'MEMBER', assignedOnly: true },
            ],
            ownerEmail: 'csarabia@ssclinical.cl',
            ownerOnlyThisWorkspace: true,
          },
        },
      },
    ],
  },
  {
    id: 'ssclinical_assignment_flow',
    name: 'SSClinical: assignedOnly + asignación (setup)',
    description:
      'Valida que el usuario MEMBER assignedOnly exista (post-aceptación) y que el workspace soporte el flujo de asignación.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check ssclinical assignment',
        expect: {
          workspaceSetup: {
            workspaceId: 'ssclinical',
            assignmentFlow: { memberEmail: 'contacto@ssclinical.cl' },
          },
        },
      },
    ],
  },
  {
    id: 'program_menu_command_menu',
    name: 'Programs: comando "menu" (cambiar program)',
    description:
      'Valida que el mensaje "menu" muestre el menú incluso si ya hay un Program asignado, y que al elegir se cambie el Program.',
    programSlug: 'recruitment',
    contactWaId: 'sandbox',
    steps: [
      {
        inboundText: 'menu',
        expect: { outbound: { sentDelta: 1, lastTextContains: ['¿Sobre qué programa', 'Responde con el número'] } },
      },
      {
        inboundText: 'sales',
        expect: {
          programIdSet: true,
          agentRun: { eventType: 'PROGRAM_SELECTION', programSlug: 'sales' },
          outbound: { sentDelta: 1, lastTextContains: ['Te atenderé con el programa', '¿En qué te puedo ayudar?'] },
        },
      },
      { inboundText: 'Hola', expect: { agentRun: { eventType: 'INBOUND_MESSAGE', programSlug: 'sales' } } },
    ],
  },
  {
    id: 'stage_definitions_crud_basic',
    name: 'Stages: CRUD básico (default + orden)',
    description:
      'Crea un stage, lo marca como default y valida que el workspace tenga exactamente 1 default activo.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check stage crud basic',
        expect: { stageDefinitionsCrudBasic: { workspaceId: 'scenario-stage-crud', slug: 'PREPARANDO_ENVIO' } },
      },
    ],
  },
  {
    id: 'ssclinical_handoff_interesado_notification',
    name: 'SSClinical: INTERESADO -> asigna + notifica',
    description:
      'Valida que al marcar Stage INTERESADO se asigne a enfermera líder y se cree notificación in-app (NOTIFICATION_CREATED).',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check ssclinical interesado notify',
        expect: { ssclinicalHandoffInteresadoNotification: { workspaceId: 'ssclinical' } },
      },
    ],
  },
  {
    id: 'copilot_context_followup',
    name: 'Copilot: follow-up (sí) ejecuta lo prometido',
    description:
      'Valida que si Copilot ofrece listar Automations y el usuario responde "sí", lista sin repreguntar.',
    steps: [{ action: 'WORKSPACE_CHECK', inboundText: 'check copilot followup', expect: { copilotContextFollowup: true } }],
  },
  {
    id: 'platform_superadmin_gate',
    name: 'Platform: gate SUPERADMIN',
    description: 'Valida que /api/platform/* esté protegido por platformRole=SUPERADMIN (sin mezclar ADMIN workspace).',
    steps: [{ action: 'WORKSPACE_CHECK', inboundText: 'check platform superadmin gate', expect: { platformSuperadminGate: true } }],
  },
  {
    id: 'ssclinical_stage_assign',
    name: 'SSClinical: stage INTERESADO auto-asigna',
    description:
      'Valida que al cambiar Stage a INTERESADO se dispare la automation STAGE_CHANGED y se asigne automáticamente a la enfermera líder configurada.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check ssclinical stage assign',
        expect: { ssclinicalStageAssign: { workspaceId: 'ssclinical' } },
      },
    ],
  },
  {
    id: 'stage_admin_configurable',
    name: 'Stages: configurables por workspace',
    description:
      'Crea un Stage custom y valida que se pueda setear en una conversación (sin hardcode).',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check stage configurable',
        expect: { stageAdminConfigurable: { workspaceId: 'scenario-stage-config', slug: 'PREPARANDO_ENVIO' } },
      },
    ],
  },
];

export function getScenario(id: string): ScenarioDefinition | null {
  const key = String(id || '').trim();
  return SCENARIOS.find((s) => s.id === key) || null;
}
