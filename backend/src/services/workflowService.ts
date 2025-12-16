import { SystemConfig } from '@prisma/client';

export type WorkflowTrigger = 'onRecruitDataUpdated' | 'onInactivity';

export type WorkflowStage =
  | 'NEW_INTAKE'
  | 'WAITING_CANDIDATE'
  | 'RECRUIT_COMPLETE'
  | 'DISQUALIFIED'
  | 'STALE_NO_RESPONSE'
  | 'ARCHIVED';

export type WorkflowRule = {
  id: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  conditions: {
    minimumComplete?: boolean;
    missingFields?: boolean;
    inactivityDaysGte?: number;
    stagesIn?: WorkflowStage[];
  };
  actions: {
    setStatus?: 'NEW' | 'OPEN' | 'CLOSED';
    setStage?: WorkflowStage;
    notifyAdmin?: string;
  };
};

export const DEFAULT_WORKFLOW_INACTIVITY_DAYS = 7;
export const DEFAULT_WORKFLOW_ARCHIVE_DAYS = 30;

export const DEFAULT_WORKFLOW_RULES: WorkflowRule[] = [
  {
    id: 'recruit_complete',
    enabled: true,
    trigger: 'onRecruitDataUpdated',
    conditions: { minimumComplete: true },
    actions: { setStatus: 'OPEN', setStage: 'RECRUIT_COMPLETE', notifyAdmin: 'RECRUIT_READY' }
  },
  {
    id: 'waiting_candidate',
    enabled: true,
    trigger: 'onRecruitDataUpdated',
    conditions: { missingFields: true },
    actions: { setStage: 'WAITING_CANDIDATE' }
  },
  {
    id: 'stale_no_response',
    enabled: true,
    trigger: 'onInactivity',
    conditions: { inactivityDaysGte: DEFAULT_WORKFLOW_INACTIVITY_DAYS, stagesIn: ['NEW_INTAKE', 'WAITING_CANDIDATE'] },
    actions: { setStage: 'STALE_NO_RESPONSE' }
  },
  {
    id: 'auto_archive',
    enabled: false,
    trigger: 'onInactivity',
    conditions: { inactivityDaysGte: DEFAULT_WORKFLOW_ARCHIVE_DAYS, stagesIn: ['STALE_NO_RESPONSE'] },
    actions: { setStage: 'ARCHIVED', setStatus: 'CLOSED' }
  }
];

function safeJsonParse<T>(value: string | null | undefined): T | null {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function loadWorkflowRules(config: SystemConfig): WorkflowRule[] {
  const parsed = safeJsonParse<unknown>(config.workflowRules);
  if (!Array.isArray(parsed)) return DEFAULT_WORKFLOW_RULES;
  const rules: WorkflowRule[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof (raw as any).id === 'string' ? (raw as any).id.trim() : '';
    const enabled = typeof (raw as any).enabled === 'boolean' ? (raw as any).enabled : true;
    const trigger = (raw as any).trigger as WorkflowTrigger;
    if (!id || (trigger !== 'onRecruitDataUpdated' && trigger !== 'onInactivity')) continue;
    const conditions = (raw as any).conditions && typeof (raw as any).conditions === 'object' ? (raw as any).conditions : {};
    const actions = (raw as any).actions && typeof (raw as any).actions === 'object' ? (raw as any).actions : {};
    rules.push({
      id,
      enabled,
      trigger,
      conditions: {
        minimumComplete: Boolean((conditions as any).minimumComplete),
        missingFields: Boolean((conditions as any).missingFields),
        inactivityDaysGte:
          typeof (conditions as any).inactivityDaysGte === 'number'
            ? (conditions as any).inactivityDaysGte
            : undefined,
        stagesIn: Array.isArray((conditions as any).stagesIn) ? (conditions as any).stagesIn : undefined
      },
      actions: {
        setStatus: (actions as any).setStatus,
        setStage: (actions as any).setStage,
        notifyAdmin: typeof (actions as any).notifyAdmin === 'string' ? (actions as any).notifyAdmin : undefined
      }
    });
  }
  return rules.length > 0 ? rules : DEFAULT_WORKFLOW_RULES;
}

export function getWorkflowInactivityDays(config: SystemConfig): number {
  const days = typeof config.workflowInactivityDays === 'number' ? config.workflowInactivityDays : null;
  if (!days || days < 1 || days > 365) return DEFAULT_WORKFLOW_INACTIVITY_DAYS;
  return Math.floor(days);
}

export function getWorkflowArchiveDays(config: SystemConfig): number {
  const days = typeof config.workflowArchiveDays === 'number' ? config.workflowArchiveDays : null;
  if (!days || days < 1 || days > 3650) return DEFAULT_WORKFLOW_ARCHIVE_DAYS;
  return Math.floor(days);
}

export function matchRule(params: {
  rule: WorkflowRule;
  trigger: WorkflowTrigger;
  stage: WorkflowStage;
  minimumComplete: boolean;
  missingFields: string[];
  inactivityDays?: number | null;
}): boolean {
  const { rule } = params;
  if (!rule.enabled) return false;
  if (rule.trigger !== params.trigger) return false;

  if (rule.conditions.stagesIn && rule.conditions.stagesIn.length > 0) {
    if (!rule.conditions.stagesIn.includes(params.stage)) return false;
  }
  if (rule.conditions.minimumComplete && !params.minimumComplete) return false;
  if (rule.conditions.missingFields && params.missingFields.length === 0) return false;
  if (typeof rule.conditions.inactivityDaysGte === 'number') {
    const days = typeof params.inactivityDays === 'number' ? params.inactivityDays : null;
    if (days == null || days < rule.conditions.inactivityDaysGte) return false;
  }
  return true;
}

