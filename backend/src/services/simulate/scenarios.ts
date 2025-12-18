export type ScenarioStep = {
  inboundText: string;
  inboundOffsetHours?: number;
  action?: 'INBOUND_MESSAGE' | 'AI_SUGGEST';
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
        inboundText: '✅ PUENTE ALTO / REGION METROPOLITANA / RUT 12.345.678-9',
        expect: {
          outbound: {
            lastTextContains: ['puente alto'],
            lastTextNotContains: ['comuna/ciudad', 'comuna y ciudad'],
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
      { inboundText: 'Hola', expect: { stage: 'PROGRAM_SELECTION', outbound: { sentDelta: 1 } } },
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
        expect: { outbound: { blockedDelta: 1, lastBlockedReasonContains: 'OUTSIDE_24H' }, stage: 'PROGRAM_SELECTION' },
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
      { inboundText: 'Hola', expect: { outbound: { blockedDelta: 1, lastBlockedReasonContains: 'SAFE_OUTBOUND' }, stage: 'PROGRAM_SELECTION' } },
    ],
  },
  {
    id: 'no_contactar_block',
    name: 'NO_CONTACTAR: bloquea outbound',
    description: 'Si el contacto está NO_CONTACTAR, el sistema bloquea cualquier envío.',
    contactNoContact: true,
    steps: [
      { inboundText: 'Hola', expect: { outbound: { blockedDelta: 1, lastBlockedReasonContains: 'NO_CONTACTAR' }, stage: 'PROGRAM_SELECTION' } },
    ],
  },
  {
    id: 'program_select_assign',
    name: 'Programs: menú y asignación por opción',
    description: 'Si una conversación no tiene Program y hay varios activos, muestra menú y asigna al elegir 1/2/3.',
    steps: [
      { inboundText: 'Hola', expect: { stage: 'PROGRAM_SELECTION', outbound: { sentDelta: 1 } } },
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
];

export function getScenario(id: string): ScenarioDefinition | null {
  const key = String(id || '').trim();
  return SCENARIOS.find((s) => s.id === key) || null;
}
