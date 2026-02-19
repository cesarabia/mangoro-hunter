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
      lastBlockedReasonNotContains?: string;
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
    ssclinicalStaffWhatsAppNotification?: {
      workspaceId?: string;
    };
    staffInboxListCases?: {
      workspaceId?: string;
    };
    staffClientsNewUsesListCases?: {
      workspaceId?: string;
    };
    staffCasesNewOk?: {
      workspaceId?: string;
    };
    staffReplyToNotificationUpdatesCase?: {
      workspaceId?: string;
    };
    staffNotificationTemplateVariables?: {
      workspaceId?: string;
    };
    ssclinicalNotificationRequiresAvailability?: {
      workspaceId?: string;
    };
    staffModeRouting?: {
      workspaceId?: string;
    };
    staffMenuSwitchProgram?: {
      workspaceId?: string;
    };
    roleSwitchModeClienteStaff?: {
      workspaceId?: string;
    };
    notificationTemplateVarsRender?: {
      workspaceId?: string;
    };
    availabilityConfirmedPreventsHallucination?: {
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
    clientNoCannedRepeat?: {
      workspaceId?: string;
    };
    clientFreeTextFields?: {
      workspaceId?: string;
    };
    staffCaseSummaryWorks?: {
      workspaceId?: string;
    };
    staffErrorTransparent?: {
      workspaceId?: string;
    };
    latencyTimeoutBehavior?: {
      workspaceId?: string;
    };
    clientLocationFreeText?: {
      workspaceId?: string;
    };
    clientRepeatedMessagesNoCannedRepeat?: {
      workspaceId?: string;
    };
    interviewScheduleConflict?: {
      workspaceId?: string;
    };
    workspaceCreationWizardGates?: {
      workspaceId?: string;
      template?: string;
    };
    phoneLineTransfer?: {
      waPhoneNumberId?: string;
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
    id: 'inbound_burst_no_silence',
    name: 'Inbound burst: debounce/coalescing sin silencio',
    description:
      'Valida que 3 mensajes seguidos no dejen la conversación muda y evita bloqueos ANTI_LOOP_SAME_TEXT.',
    programSlug: 'recruitment',
    contactWaId: 'sandbox',
    steps: [
      { inboundText: 'Hola', expect: { outbound: { sentDelta: 1, blockedDelta: 0, lastBlockedReasonNotContains: 'ANTI_LOOP_SAME_TEXT' } } },
      { inboundText: 'Quiero postular', expect: { outbound: { sentDelta: 1, blockedDelta: 0, lastBlockedReasonNotContains: 'ANTI_LOOP_SAME_TEXT' } } },
      { inboundText: 'Tengo estacionamiento', expect: { outbound: { sentDelta: 1, blockedDelta: 0, lastBlockedReasonNotContains: 'ANTI_LOOP_SAME_TEXT' } } },
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
    id: 'template_outside_24h_first_contact',
    name: 'Template outside 24h: primer contacto',
    description:
      'Si la conversación está fuera de 24h, debe usar TEMPLATE automáticamente (sin bloquear por OUTSIDE_24H_REQUIRES_TEMPLATE).',
    steps: [
      {
        inboundText: 'Hola',
        inboundOffsetHours: -26,
        expect: { outbound: { sentDelta: 1, blockedDelta: 0, lastBlockedReasonNotContains: 'OUTSIDE_24H' } },
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
    id: 'workspace_creation_wizard_gates',
    name: 'Setup Wizard: creación workspace + gates',
    description:
      'Crea workspace de escenario con template y valida gates mínimos del Setup Wizard (phoneline/programs/routing/users/automations/notificaciones).',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check wizard gates',
        expect: { workspaceCreationWizardGates: { workspaceId: 'scenario-wizard-gates', template: 'SUPPORT' } },
      },
    ],
  },
  {
    id: 'phone_line_transfer',
    name: 'PhoneLine: transferencia atómica entre workspaces',
    description:
      'Valida transferencia de PhoneLine entre workspaces (archive-only) con unicidad activa de waPhoneNumberId.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check phone line transfer',
        expect: { phoneLineTransfer: {} },
      },
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
    id: 'ssclinical_staff_whatsapp_notification',
    name: 'SSClinical: INTERESADO -> WhatsApp al staff (o bloqueado con razón)',
    description:
      'Valida que al pasar a INTERESADO se intente notificar por WhatsApp al staff (según Membership.staffWhatsAppE164), respetando SAFE MODE/24h y dejando logs + fallback in-app.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check ssclinical staff whatsapp',
        expect: { ssclinicalStaffWhatsAppNotification: { workspaceId: 'ssclinical' } },
      },
    ],
  },
  {
    id: 'stage_notify_whatsapp_fallback_inapp',
    name: 'Stage notify: WhatsApp staff + fallback in-app',
    description:
      'Valida notificación al staff cuando stage pasa a INTERESADO y fallback in-app cuando el envío WhatsApp es bloqueado por guardrails.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check stage notify whatsapp fallback',
        expect: { ssclinicalStaffWhatsAppNotification: { workspaceId: 'ssclinical' } },
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
  {
    id: 'staff_inbox_list_cases',
    name: 'Staff Mode: LIST_CASES',
    description:
      'Valida que una conversación STAFF pueda listar casos asignados usando RUN_TOOL LIST_CASES (sin LLM).',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check staff list cases',
        expect: { staffInboxListCases: { workspaceId: 'scenario-staff-tools' } },
      },
    ],
  },
  {
    id: 'staff_clients_new_uses_list_cases',
    name: 'Staff: "clientes nuevos" -> LIST_CASES',
    description:
      'Valida que el staff pueda escribir "clientes nuevos" y que el agente use LIST_CASES (tools) antes de responder.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check staff clientes nuevos',
        expect: { staffClientsNewUsesListCases: { workspaceId: 'scenario-staff-clients-new' } },
      },
    ],
  },
  {
    id: 'staff_cases_new_ok',
    name: 'Staff: casos nuevos (router determinístico)',
    description:
      'Valida que "casos nuevos" en conversación STAFF llama LIST_CASES y responde listado, sin loops de tools legacy.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check staff cases new ok',
        expect: { staffCasesNewOk: { workspaceId: 'scenario-staff-cases-new-ok' } },
      },
    ],
  },
  {
    id: 'interview_schedule_conflict',
    name: 'Agenda: conflicto de entrevista',
    description:
      'Agenda 2 candidatos en el mismo slot y valida que el segundo reciba alternativas (sin doble reserva).',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check interview schedule conflict',
        expect: { interviewScheduleConflict: { workspaceId: 'scenario-interview-conflict' } },
      },
    ],
  },
  {
    id: 'client_location_free_text',
    name: 'CLIENT: ubicación en texto libre',
    description:
      'Valida que entradas libres como “Pudahuel”, “Santiago, Pudahuel” y “Providencia” se interpreten como ubicación sin forzar formato rígido.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check client location free text',
        expect: { clientLocationFreeText: { workspaceId: 'scenario-client-location-free-text' } },
      },
    ],
  },
  {
    id: 'client_repeated_messages_no_canned_repeat',
    name: 'CLIENT: mensajes seguidos sin repetición enlatada',
    description:
      'Valida que múltiples respuestas iguales no queden en loop textual exacto y evita formato rígido/menús 1-2.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check client repeated no canned repeat',
        expect: {
          clientRepeatedMessagesNoCannedRepeat: { workspaceId: 'scenario-client-repeated-no-canned' },
        },
      },
    ],
  },
  {
    id: 'client_no_canned_repeat',
    name: 'CLIENT: no canned repeat (alias)',
    description:
      'Alias de validación para respuestas sin repetición enlatada, sin formato rígido y sin bloqueos ANTI_LOOP_SAME_TEXT.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check client no canned repeat',
        expect: {
          clientNoCannedRepeat: { workspaceId: 'scenario-client-no-canned-repeat' },
        },
      },
    ],
  },
  {
    id: 'client_free_text_fields',
    name: 'CLIENT: extracción de campos en texto libre',
    description:
      'Valida que ubicación/nombre en texto libre se interpreten sin exigir formato tipo “Comuna: …”.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check client free text fields',
        expect: { clientFreeTextFields: { workspaceId: 'scenario-client-free-text-fields' } },
      },
    ],
  },
  {
    id: 'staff_cases_new_includes_new_intake',
    name: 'STAFF: casos nuevos incluye NEW_INTAKE',
    description:
      'Valida que “casos nuevos” incluya conversaciones reales en etapa inicial (NEW_INTAKE/NUEVO equivalentes).',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check staff cases new includes intake',
        expect: { staffClientsNewUsesListCases: { workspaceId: 'scenario-staff-cases-new-intake' } },
      },
    ],
  },
  {
    id: 'staff_case_summary_works',
    name: 'STAFF: lista + resumen de casos',
    description:
      'Valida que “lista postulantes” y “dame resumen de cada caso” devuelvan datos reales usando LIST_CASES/GET_CASE_SUMMARY.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check staff case summary works',
        expect: { staffCaseSummaryWorks: { workspaceId: 'scenario-staff-case-summary' } },
      },
    ],
  },
  {
    id: 'staff_error_transparent',
    name: 'STAFF: error transparente',
    description:
      'Simula un fallo de consulta y valida que la respuesta sea honesta (sin “estoy obteniendo…”).',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check staff error transparent',
        expect: { staffErrorTransparent: { workspaceId: 'scenario-staff-error-transparent' } },
      },
    ],
  },
  {
    id: 'latency_timeout_behavior',
    name: 'Runtime: timeout/technical fallback transparente',
    description:
      'Valida que ante bloqueo técnico equivalente a timeout no quede silencio y se emita mensaje técnico honesto.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check latency timeout behavior',
        expect: { latencyTimeoutBehavior: { workspaceId: 'scenario-latency-timeout-behavior' } },
      },
    ],
  },
  {
    id: 'staff_notification_template_variables',
    name: 'Staff Mode: template variables en NOTIFY_STAFF_WHATSAPP',
    description:
      'Valida que NOTIFY_STAFF_WHATSAPP renderice variables determinísticamente y no deje {{placeholders}} sin reemplazar.',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check staff template vars',
        expect: { staffNotificationTemplateVariables: { workspaceId: 'scenario-staff-template-vars' } },
      },
    ],
  },
  {
    id: 'ssclinical_notification_requires_availability',
    name: 'SSClinical: NOTIFY_STAFF_WHATSAPP requireAvailability',
    description:
      'Valida que requireAvailability=true salte la notificación si falta preferencia horaria (sin generar outbound).',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check ssclinical require availability',
        expect: { ssclinicalNotificationRequiresAvailability: { workspaceId: 'scenario-require-availability' } },
      },
    ],
  },
  {
    id: 'staff_reply_to_notification_updates_case',
    name: 'Staff Mode: reply-to notificación -> actualiza caso',
    description:
      'Simula reply (context.id) a una notificación WhatsApp, resuelve relatedConversationId y aplica SET_STAGE vía RUN_TOOL (sin copiar IDs).',
    steps: [
      {
        action: 'WORKSPACE_CHECK',
        inboundText: 'check staff reply-to updates case',
        expect: { staffReplyToNotificationUpdatesCase: { workspaceId: 'scenario-staff-replyto' } },
      },
    ],
  },
  {
    id: 'staff_mode_routing',
    name: 'V2.3: routing STAFF por número',
    description:
      'Valida que un inbound desde un número configurado como staff enruta a conversación STAFF (y NO a admin/client).',
    steps: [
      { action: 'WORKSPACE_CHECK', inboundText: 'check staff mode routing', expect: { staffModeRouting: { workspaceId: 'scenario-persona-routing' } } },
    ],
  },
  {
    id: 'staff_menu_switch_program',
    name: 'V2.3: staff usa “menu” para cambiar Program',
    description:
      'Valida que una conversación STAFF pueda ejecutar el comando “menu” y elegir un Program permitido (sin mostrar inactivos).',
    steps: [
      { action: 'WORKSPACE_CHECK', inboundText: 'check staff menu switch', expect: { staffMenuSwitchProgram: { workspaceId: 'scenario-staff-menu-switch' } } },
    ],
  },
  {
    id: 'role_switch_mode_cliente_staff',
    name: 'V2.3: cambio de rol por WhatsApp (modo ...)',
    description:
      'Valida que el comando “modo cliente/staff/proveedor” persiste activePersonaKind con TTL y que “modo auto” limpia el override.',
    steps: [
      { action: 'WORKSPACE_CHECK', inboundText: 'check persona switch', expect: { roleSwitchModeClienteStaff: { workspaceId: 'scenario-persona-switch' } } },
    ],
  },
  {
    id: 'notification_template_vars_render',
    name: 'V2.3: templates determinísticos (staff/partner) sin placeholders',
    description:
      'Valida que NOTIFY_STAFF_WHATSAPP y NOTIFY_PARTNER_WHATSAPP rendericen variables determinísticamente y registren NotificationLog snapshot.',
    steps: [
      { action: 'WORKSPACE_CHECK', inboundText: 'check notification template vars render', expect: { notificationTemplateVarsRender: { workspaceId: 'scenario-notification-vars' } } },
    ],
  },
  {
    id: 'availability_confirmed_prevents_hallucination',
    name: 'V2.3: availabilityParsed solo si confirmado',
    description:
      'Valida que el resumen/notificación use availabilityParsed solo si availabilityConfirmedAt existe; si no, usa availabilityRaw.',
    steps: [
      { action: 'WORKSPACE_CHECK', inboundText: 'check availability confirm gating', expect: { availabilityConfirmedPreventsHallucination: { workspaceId: 'scenario-availability-confirm' } } },
    ],
  },
];

export function getScenario(id: string): ScenarioDefinition | null {
  const key = String(id || '').trim();
  return SCENARIOS.find((s) => s.id === key) || null;
}
