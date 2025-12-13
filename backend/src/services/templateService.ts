import { FastifyBaseLogger } from 'fastify';
import { prisma } from '../db/client';
import {
  DEFAULT_INTERVIEW_DAY,
  DEFAULT_INTERVIEW_LOCATION,
  DEFAULT_INTERVIEW_TIME,
  DEFAULT_JOB_TITLE,
  DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
  DEFAULT_TEMPLATE_INTERVIEW_INVITE,
  DEFAULT_TEMPLATE_LANGUAGE_CODE
} from './configService';

export interface TemplateConfig {
  templateInterviewInvite: string | null;
  templateGeneralFollowup: string | null;
  templateLanguageCode: string | null;
  defaultJobTitle: string | null;
  defaultInterviewDay: string | null;
  defaultInterviewTime: string | null;
  defaultInterviewLocation: string | null;
  testPhoneNumber: string | null;
}

function defaults(): TemplateConfig {
  return {
    templateInterviewInvite: DEFAULT_TEMPLATE_INTERVIEW_INVITE,
    templateGeneralFollowup: DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
    templateLanguageCode: DEFAULT_TEMPLATE_LANGUAGE_CODE,
    defaultJobTitle: DEFAULT_JOB_TITLE,
    defaultInterviewDay: DEFAULT_INTERVIEW_DAY,
    defaultInterviewTime: DEFAULT_INTERVIEW_TIME,
    defaultInterviewLocation: DEFAULT_INTERVIEW_LOCATION,
    testPhoneNumber: null
  };
}

export async function loadTemplateConfig(logger?: FastifyBaseLogger): Promise<TemplateConfig> {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { id: 1 },
      select: {
        templateInterviewInvite: true,
        templateGeneralFollowup: true,
        templateLanguageCode: true,
        defaultJobTitle: true,
        defaultInterviewDay: true,
        defaultInterviewTime: true,
        defaultInterviewLocation: true,
        testPhoneNumber: true
      }
    });
    const base = defaults();
    return {
      templateInterviewInvite: config?.templateInterviewInvite || base.templateInterviewInvite,
      templateGeneralFollowup: config?.templateGeneralFollowup || base.templateGeneralFollowup,
      templateLanguageCode: config?.templateLanguageCode || base.templateLanguageCode,
      defaultJobTitle: config?.defaultJobTitle || base.defaultJobTitle,
      defaultInterviewDay: config?.defaultInterviewDay || base.defaultInterviewDay,
      defaultInterviewTime: config?.defaultInterviewTime || base.defaultInterviewTime,
      defaultInterviewLocation: config?.defaultInterviewLocation || base.defaultInterviewLocation,
      testPhoneNumber: config?.testPhoneNumber || null
    };
  } catch (err: any) {
    if (err?.code === 'P2022') {
      logger?.error({ err }, 'Template columns missing in SystemConfig');
      return defaults();
    }
    throw err;
  }
}

export function selectTemplateForMode(
  mode: 'RECRUIT' | 'INTERVIEW' | 'OFF',
  templates: TemplateConfig
): string {
  if (mode === 'INTERVIEW') {
    return templates.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE;
  }
  return templates.templateGeneralFollowup || DEFAULT_TEMPLATE_GENERAL_FOLLOWUP;
}

export function resolveTemplateVariables(
  templateName: string,
  providedVariables: string[] | undefined,
  templates: TemplateConfig,
  conversationOverrides?: {
    interviewDay?: string | null;
    interviewTime?: string | null;
    interviewLocation?: string | null;
    jobTitle?: string | null;
  }
): string[] {
  const normalized =
    Array.isArray(providedVariables) && providedVariables.length > 0
      ? providedVariables.map(value => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
      : [];

  if (templateName === (templates.templateGeneralFollowup || DEFAULT_TEMPLATE_GENERAL_FOLLOWUP)) {
    const v1 =
      normalized[0] ||
      conversationOverrides?.jobTitle ||
      templates.defaultJobTitle ||
      DEFAULT_JOB_TITLE;
    return [v1];
  }

  if (templateName === (templates.templateInterviewInvite || DEFAULT_TEMPLATE_INTERVIEW_INVITE)) {
    return [
      normalized[0] ||
        conversationOverrides?.interviewDay ||
        templates.defaultInterviewDay ||
        DEFAULT_INTERVIEW_DAY,
      normalized[1] ||
        conversationOverrides?.interviewTime ||
        templates.defaultInterviewTime ||
        DEFAULT_INTERVIEW_TIME,
      normalized[2] ||
        conversationOverrides?.interviewLocation ||
        templates.defaultInterviewLocation ||
        DEFAULT_INTERVIEW_LOCATION
    ];
  }

  return normalized;
}
