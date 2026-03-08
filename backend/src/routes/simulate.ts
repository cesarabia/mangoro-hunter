import { FastifyInstance } from 'fastify';
import { handleInboundWhatsAppMessage } from '../services/whatsappInboundService';
import { getAdminWaIdAllowlist, getSystemConfig, getTestWaIdAllowlist } from '../services/configService';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { prisma } from '../db/client';
import { getInboundQueueHealthSnapshot, runAutomations } from '../services/automationRunnerService';
import { piiSanitizeText, stableHash } from '../services/agent/tools';
import { isWorkspaceAdmin, resolveWorkspaceAccess } from '../services/workspaceAuthService';
import { SCENARIOS, getScenario, ScenarioDefinition, ScenarioStep } from '../services/simulate/scenarios';
import { resolveReplyContextForInboundMessage, runAgent } from '../services/agent/agentRuntimeService';
import { executeAgentResponse } from '../services/agent/commandExecutorService';
import { buildLLMContext } from '../services/agent/llmContextBuilderService';
import { resolveInboundPhoneLineRouting } from '../services/phoneLineRoutingService';
import { normalizeWorkspaceTemplateId, seedWorkspaceTemplate } from '../services/workspaceTemplateService';
import { attemptScheduleInterview } from '../services/interviewSchedulerService';
import { createWorkspaceAsset, resolveWorkspaceAssetAbsolutePath } from '../services/workspaceAssetService';
import { listWorkspaceTemplateCatalog } from '../services/whatsappTemplateCatalogService';
import { triggerReadyForOpReview } from '../services/postulacionReviewService';
import { mapApplicationStateToStage, normalizeApplicationRole, normalizeApplicationState } from '../services/postulacionFlowService';
import fs from 'fs/promises';

export async function registerSimulationRoutes(app: FastifyInstance) {
  const normalizeForContains = (value: string): string =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const normalizeCandidateName = (value: string): string | null => {
    const cleaned = String(value || '')
      .replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;
    const words = cleaned.split(' ').filter(Boolean);
    if (words.length < 2 || words.length > 3) return null;
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  };

  const extractCandidateNameFromText = (text: string): string | null => {
    const cleaned = String(text || '').trim();
    if (!cleaned) return null;
    const match = cleaned.match(/(?:mi nombre es|me llamo)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,80})/i);
    if (!match?.[1]) return null;
    return normalizeCandidateName(match[1]);
  };

  const safeJsonParse = (value: string | null | undefined): any => {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const requireWorkspaceAdmin = async (request: any, reply: any) => {
    const access = await resolveWorkspaceAccess(request);
    if (!isWorkspaceAdmin(request, access)) {
      reply.code(403).send({ error: 'Forbidden' });
      return null;
    }
    return access;
  };

  // Agent OS Simulator (sandbox workspace; never sends WhatsApp).
  app.get('/scenarios', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!(await requireWorkspaceAdmin(request, reply))) return;
    return SCENARIOS.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      stepsCount: s.steps.length,
    }));
  });

  app.post('/scenario/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!(await requireWorkspaceAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    const scenario = getScenario(id);
    if (!scenario) return reply.code(404).send({ error: 'Scenario no encontrado.' });

    const body = request.body as { sanitizePii?: boolean };
    const sanitize = body?.sanitizePii !== false;

    const program = scenario.programSlug
      ? await prisma.program.findFirst({
          where: { workspaceId: 'sandbox', slug: scenario.programSlug, archivedAt: null },
          select: { id: true },
        })
      : null;

    const scenarioWaId = scenario.contactWaId ? String(scenario.contactWaId) : null;
    const contact = await (async () => {
      const baseData = {
        workspaceId: 'sandbox',
        displayName: sanitize ? `Sandbox Scenario (${scenario.id})` : `Sandbox Scenario (${scenario.id})`,
        waId: scenarioWaId,
        candidateName: null,
        candidateNameManual: null,
        email: null,
        rut: null,
        comuna: null,
        ciudad: null,
        region: null,
        experienceYears: null,
        terrainExperience: null,
        availabilityText: null,
        noContact: Boolean(scenario.contactNoContact),
        noContactAt: scenario.contactNoContact ? new Date() : null,
        noContactReason: scenario.contactNoContact ? `scenario:${scenario.id}` : null,
        archivedAt: null,
      } as any;

      // Reuse sandbox contacts by waId to avoid unique constraint collisions across scenario runs.
      if (scenarioWaId) {
        const existing = await prisma.contact
          .findFirst({
            where: { workspaceId: 'sandbox', waId: scenarioWaId },
            select: { id: true },
          })
          .catch(() => null);
        if (existing?.id) {
          return prisma.contact.update({
            where: { id: existing.id },
            data: baseData,
          });
        }
      }

      return prisma.contact.create({ data: baseData });
    })();
    const conversation = await prisma.conversation.create({
      data: {
        workspaceId: 'sandbox',
        phoneLineId: 'sandbox-default',
        programId: program?.id || null,
        contactId: contact.id,
        status: 'NEW',
        conversationStage: 'SANDBOX_SCENARIO',
        channel: 'sandbox',
        sandboxSourceConversationId: null,
      } as any,
    });

    const startedAt = new Date();
    const stepResults: any[] = [];
    let ok = true;

    for (const [idx, step] of scenario.steps.entries()) {
      const setProgramSlug = typeof (step as any).setProgramSlug === 'string' ? String((step as any).setProgramSlug).trim() : '';
      if (setProgramSlug) {
        const found = await prisma.program.findFirst({
          where: { workspaceId: 'sandbox', slug: setProgramSlug, archivedAt: null },
          select: { id: true, slug: true },
        });
        if (!found) {
          ok = false;
          stepResults.push({
            step: idx + 1,
            inboundMessageId: null,
            inboundText: String(step.inboundText || ''),
            inboundTimestamp: new Date().toISOString(),
            assertions: [{ ok: false, message: `setProgramSlug: program "${setProgramSlug}" no encontrado` }],
            outbound: { sentDelta: 0, blockedDelta: 0, lastBlockedReason: null },
            snapshot: null,
          });
          break;
        }
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { programId: found.id, updatedAt: new Date() },
        });
      }

      const action = String((step as any).action || 'INBOUND_MESSAGE').toUpperCase();
      const isWorkspaceCheck = action === 'WORKSPACE_CHECK';
      const inboundText = String(step.inboundText || '').trim();
      const offsetHours =
        typeof (step as any).inboundOffsetHours === 'number' && Number.isFinite((step as any).inboundOffsetHours)
          ? (step as any).inboundOffsetHours
          : null;
      const timestamp = offsetHours !== null ? new Date(Date.now() + offsetHours * 60 * 60 * 1000) : new Date();

      const outboundBefore = await prisma.outboundMessageLog.count({
        where: { conversationId: conversation.id },
      });
      const outboundBlockedBefore = await prisma.outboundMessageLog.count({
        where: { conversationId: conversation.id, blockedReason: { not: null } },
      });
      const outboundSentBefore = outboundBefore - outboundBlockedBefore;

      const message =
        action === 'AI_SUGGEST' || isWorkspaceCheck
          ? null
          : await prisma.message.create({
              data: {
                conversationId: conversation.id,
                direction: 'INBOUND',
                text: inboundText,
                rawPayload: JSON.stringify({ simulated: true, sandbox: true, scenario: scenario.id, step: idx }),
                timestamp,
                read: false,
              },
            });

      // Deterministic contact name extraction (mirrors inbound safety): scenarios should not depend on LLM
      // to set candidateName for explicit phrases like "Me llamo ...".
      if (message && inboundText) {
        const extracted = extractCandidateNameFromText(inboundText);
        if (extracted) {
          await prisma.contact
            .updateMany({
              where: {
                id: conversation.contactId,
                workspaceId: 'sandbox',
                candidateNameManual: null,
                OR: [{ candidateName: null }, { candidateName: '' }],
              } as any,
              data: { candidateName: extracted, name: extracted } as any,
            })
            .catch(() => {});
        }
      }

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });

      if (action === 'AI_SUGGEST') {
        try {
          await runAgent({
            workspaceId: 'sandbox',
            conversationId: conversation.id,
            eventType: 'AI_SUGGEST',
            inboundMessageId: null,
            draftText: inboundText,
          });
        } catch (err: any) {
          // swallow; assertion below will detect error via AgentRunLog
          app.log.warn({ err, scenario: scenario.id, step: idx }, 'Scenario AI_SUGGEST failed');
        }
      } else if (isWorkspaceCheck) {
        // No-op: assertions below can validate real workspace setup without running automations.
      } else {
        await runAutomations({
          app,
          workspaceId: 'sandbox',
          eventType: 'INBOUND_MESSAGE',
          conversationId: conversation.id,
          inboundMessageId: message?.id,
          inboundText,
          transportMode: 'NULL',
        });
      }

      const snap = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        include: { contact: true },
      });
      const lastAgentRun = await prisma.agentRunLog
        .findFirst({
          where: { workspaceId: 'sandbox', conversationId: conversation.id },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            eventType: true,
            error: true,
            createdAt: true,
            program: { select: { slug: true } },
          },
        })
        .catch(() => null);

      const outboundAfter = await prisma.outboundMessageLog.count({
        where: { conversationId: conversation.id },
      });
      const outboundBlockedAfter = await prisma.outboundMessageLog.count({
        where: { conversationId: conversation.id, blockedReason: { not: null } },
      });
      const outboundSentAfter = outboundAfter - outboundBlockedAfter;

      const lastOutbound = await prisma.outboundMessageLog.findFirst({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'desc' },
        select: { blockedReason: true, type: true, dedupeKey: true, createdAt: true },
      });
      const lastOutboundMsg = await prisma.message
        .findFirst({
          where: { conversationId: conversation.id, direction: 'OUTBOUND' },
          orderBy: { timestamp: 'desc' },
          select: { text: true, transcriptText: true },
        })
        .catch(() => null);
      const lastOutboundTextRaw = String(lastOutboundMsg?.transcriptText || lastOutboundMsg?.text || '').trim();
      const lastOutboundTextNorm = normalizeForContains(lastOutboundTextRaw);

      const assertions: Array<{ ok: boolean; message: string }> = [];
      const expectedFields = step.expect?.contactFields || [];
      for (const field of expectedFields) {
        const val = (snap?.contact as any)?.[field];
        const pass = val !== null && typeof val !== 'undefined' && String(val).trim() !== '';
        assertions.push({ ok: pass, message: pass ? `field ${field} OK` : `field ${field} missing` });
      }
      if (step.expect?.stage) {
        const pass = String(snap?.conversationStage || '') === String(step.expect.stage);
        assertions.push({ ok: pass, message: pass ? `stage OK (${step.expect.stage})` : `stage mismatch` });
      }
      if (typeof step.expect?.programIdSet === 'boolean') {
        const has = Boolean(snap?.programId);
        const pass = step.expect.programIdSet ? has : !has;
        assertions.push({ ok: pass, message: pass ? `programIdSet OK (${has})` : `programIdSet mismatch (got ${has})` });
      }
      if (step.expect?.agentRun) {
        const exp = step.expect.agentRun;
        const gotEvent = String(lastAgentRun?.eventType || '');
        const gotStatus = String(lastAgentRun?.status || '');
        const gotSlug = String((lastAgentRun as any)?.program?.slug || '');

        if (exp.eventType) {
          const pass = gotEvent === String(exp.eventType);
          assertions.push({ ok: pass, message: pass ? `agentRun eventType OK (${gotEvent})` : `agentRun eventType expected ${exp.eventType}, got ${gotEvent || '—'}` });
        }
        if (exp.programSlug) {
          const pass = gotSlug === String(exp.programSlug);
          assertions.push({ ok: pass, message: pass ? `agentRun programSlug OK (${gotSlug})` : `agentRun programSlug expected ${exp.programSlug}, got ${gotSlug || '—'}` });
        }
        if (exp.status) {
          const pass = gotStatus === String(exp.status);
          assertions.push({ ok: pass, message: pass ? `agentRun status OK (${gotStatus})` : `agentRun status expected ${exp.status}, got ${gotStatus || '—'}` });
        }
        if (!exp.status) {
          const pass = gotStatus !== 'ERROR';
          assertions.push({ ok: pass, message: pass ? `agentRun status OK (${gotStatus || '—'})` : `agentRun status ERROR: ${String((lastAgentRun as any)?.error || 'error')}` });
        }
      }
      const outboundExp = step.expect?.outbound;
      if (outboundExp) {
        if (typeof outboundExp.sentDelta === 'number') {
          const delta = outboundSentAfter - outboundSentBefore;
          const pass = delta === outboundExp.sentDelta;
          assertions.push({ ok: pass, message: pass ? `outbound sent Δ OK (${delta})` : `outbound sent Δ expected ${outboundExp.sentDelta}, got ${delta}` });
        }
        if (typeof outboundExp.blockedDelta === 'number') {
          const delta = outboundBlockedAfter - outboundBlockedBefore;
          const pass = delta === outboundExp.blockedDelta;
          assertions.push({ ok: pass, message: pass ? `outbound blocked Δ OK (${delta})` : `outbound blocked Δ expected ${outboundExp.blockedDelta}, got ${delta}` });
        }
        if (typeof outboundExp.lastBlockedReasonContains === 'string') {
          const needle = outboundExp.lastBlockedReasonContains;
          const hay = String(lastOutbound?.blockedReason || '');
          const pass = hay.includes(needle);
          assertions.push({ ok: pass, message: pass ? `blockedReason contains ${needle}` : `blockedReason missing "${needle}" (got "${hay || '—'}")` });
        }
        if (typeof (outboundExp as any).lastBlockedReasonNotContains === 'string') {
          const needle = String((outboundExp as any).lastBlockedReasonNotContains || '');
          const hay = String(lastOutbound?.blockedReason || '');
          const pass = !hay.includes(needle);
          assertions.push({ ok: pass, message: pass ? `blockedReason avoids ${needle}` : `blockedReason contains "${needle}" (got "${hay || '—'}")` });
        }
        if (Array.isArray((outboundExp as any).lastTextContains)) {
          const needles = (outboundExp as any).lastTextContains as any[];
          for (const rawNeedle of needles) {
            const needle = normalizeForContains(String(rawNeedle || ''));
            if (!needle) continue;
            const pass = lastOutboundTextNorm.includes(needle);
            assertions.push({ ok: pass, message: pass ? `outbound text contains "${needle}"` : `outbound text missing "${needle}" (got "${lastOutboundTextRaw || '—'}")` });
          }
        }
        if (Array.isArray((outboundExp as any).lastTextNotContains)) {
          const needles = (outboundExp as any).lastTextNotContains as any[];
          for (const rawNeedle of needles) {
            const needle = normalizeForContains(String(rawNeedle || ''));
            if (!needle) continue;
            const pass = !lastOutboundTextNorm.includes(needle);
            assertions.push({ ok: pass, message: pass ? `outbound text avoids "${needle}"` : `outbound text contains "${needle}" (got "${lastOutboundTextRaw || '—'}")` });
          }
        }
      }

      const wsSetup = (step.expect as any)?.workspaceSetup;
      if (wsSetup && typeof wsSetup === 'object') {
        const targetWorkspaceId = String(wsSetup.workspaceId || '').trim();
        if (!targetWorkspaceId) {
          assertions.push({ ok: false, message: 'workspaceSetup.workspaceId missing' });
        } else {
          const workspace = await prisma.workspace
            .findUnique({ where: { id: targetWorkspaceId }, select: { id: true, archivedAt: true } as any })
            .catch(() => null);
          assertions.push({
            ok: Boolean(workspace) && !workspace?.archivedAt,
            message: workspace ? (workspace.archivedAt ? `workspace ${targetWorkspaceId} is archived` : `workspace ${targetWorkspaceId} exists`) : `workspace ${targetWorkspaceId} missing`,
          });

          const programsSlugs = Array.isArray(wsSetup.programsSlugs) ? wsSetup.programsSlugs.map((s: any) => String(s || '').trim()).filter(Boolean) : [];
          if (programsSlugs.length > 0) {
            const found = await prisma.program.findMany({
              where: { workspaceId: targetWorkspaceId, slug: { in: programsSlugs }, archivedAt: null },
              select: { slug: true },
            });
            const foundSet = new Set(found.map((p) => p.slug));
            for (const slug of programsSlugs) {
              assertions.push({ ok: foundSet.has(slug), message: foundSet.has(slug) ? `program ${slug} OK` : `program ${slug} missing` });
            }
          }

          if (wsSetup.inboundRunAgentEnabled) {
            const rules = await prisma.automationRule.findMany({
              where: { workspaceId: targetWorkspaceId, trigger: 'INBOUND_MESSAGE', archivedAt: null, enabled: true },
              select: { actionsJson: true },
            });
            const hasRunAgent = rules.some((r) => {
              try {
                const parsed = JSON.parse(String((r as any).actionsJson || '[]'));
                if (!Array.isArray(parsed)) return false;
                return parsed.some((a: any) => String(a?.type || '').toUpperCase() === 'RUN_AGENT');
              } catch {
                return String((r as any).actionsJson || '').toUpperCase().includes('RUN_AGENT');
              }
            });
            assertions.push({ ok: hasRunAgent, message: hasRunAgent ? 'inbound RUN_AGENT rule OK' : 'missing inbound RUN_AGENT rule' });
          }

          const invites = Array.isArray(wsSetup.invites) ? wsSetup.invites : [];
          for (const inv of invites) {
            const email = String((inv as any)?.email || '').trim().toLowerCase();
            const role = String((inv as any)?.role || '').trim().toUpperCase();
            const assignedOnly = Boolean((inv as any)?.assignedOnly) && role === 'MEMBER';
            if (!email || !role) continue;
            const found = await prisma.workspaceInvite.findFirst({
              where: { workspaceId: targetWorkspaceId, email, role, assignedOnly, archivedAt: null } as any,
              select: { id: true },
            });
            assertions.push({
              ok: Boolean(found),
              message: found ? `invite ${email} (${role}${assignedOnly ? ', assignedOnly' : ''}) OK` : `invite ${email} (${role}${assignedOnly ? ', assignedOnly' : ''}) missing`,
            });
          }

          if (wsSetup.ownerEmail && wsSetup.ownerOnlyThisWorkspace) {
            const email = String(wsSetup.ownerEmail || '').trim().toLowerCase();
            const user = await prisma.user.findUnique({ where: { email }, select: { id: true } }).catch(() => null);
            if (!user?.id) {
              const invite = await prisma.workspaceInvite
                .findFirst({
                  where: { workspaceId: targetWorkspaceId, email, role: 'OWNER', archivedAt: null, acceptedAt: null, expiresAt: { gt: new Date() } } as any,
                  select: { id: true },
                })
                .catch(() => null);
              assertions.push({
                ok: Boolean(invite?.id),
                message: invite?.id
                  ? `owner user ${email} pendiente (invite existe; falta aceptar)`
                  : `owner user ${email} missing`,
              });
            } else {
              const memberships = await prisma.membership.findMany({
                where: { userId: user.id, archivedAt: null },
                select: { workspaceId: true, role: true },
              });
              const activeWs = new Set(memberships.map((m) => m.workspaceId));
              const onlyTarget = memberships.length > 0 && memberships.every((m) => String(m.workspaceId) === targetWorkspaceId);
              assertions.push({
                ok: onlyTarget,
                message: onlyTarget ? `owner memberships scoped to ${targetWorkspaceId}` : `owner has active memberships: ${Array.from(activeWs).join(', ') || '—'}`,
              });
              const inTarget = memberships.find((m) => String(m.workspaceId) === targetWorkspaceId);
              assertions.push({ ok: Boolean(inTarget) && String(inTarget?.role || '').toUpperCase() === 'OWNER', message: inTarget ? `owner role in ${targetWorkspaceId}: ${inTarget.role}` : `owner membership in ${targetWorkspaceId} missing` });
            }
          }

          const assignmentFlow = (wsSetup as any)?.assignmentFlow;
          if (assignmentFlow && typeof assignmentFlow === 'object') {
            const memberEmail = String((assignmentFlow as any)?.memberEmail || '').trim().toLowerCase();
            if (!memberEmail) {
              assertions.push({ ok: false, message: 'assignmentFlow.memberEmail missing' });
            } else {
              const memberUser = await prisma.user.findUnique({ where: { email: memberEmail }, select: { id: true, email: true } }).catch(() => null);
              if (!memberUser?.id) {
                const invite = await prisma.workspaceInvite
                  .findFirst({
                    where: { workspaceId: targetWorkspaceId, email: memberEmail, archivedAt: null, acceptedAt: null, expiresAt: { gt: new Date() } } as any,
                    select: { id: true },
                  })
                  .catch(() => null);
                assertions.push({
                  ok: Boolean(invite?.id),
                  message: invite?.id
                    ? `assignmentFlow: user ${memberEmail} pendiente (invite existe; falta aceptar)`
                    : `assignmentFlow: user ${memberEmail} missing (acepta la invitación)`,
                });
              } else {
                const memberMembership = await prisma.membership
                  .findFirst({
                    where: { workspaceId: targetWorkspaceId, userId: memberUser.id, archivedAt: null },
                    select: { id: true, role: true, assignedOnly: true as any },
                  })
                  .catch(() => null);
                const membershipOk =
                  Boolean(memberMembership?.id) &&
                  String(memberMembership?.role || '').toUpperCase() === 'MEMBER' &&
                  Boolean((memberMembership as any)?.assignedOnly);
                assertions.push({
                  ok: membershipOk,
                  message: membershipOk
                    ? `assignmentFlow: membership MEMBER assignedOnly OK (${memberEmail})`
                    : `assignmentFlow: membership missing/invalid (role=${memberMembership?.role || '—'}, assignedOnly=${Boolean((memberMembership as any)?.assignedOnly)})`,
                });

                const phoneLine = await prisma.phoneLine
                  .findFirst({
                    where: { workspaceId: targetWorkspaceId, archivedAt: null, isActive: true },
                    select: { id: true },
                  })
                  .catch(() => null);
                assertions.push({
                  ok: Boolean(phoneLine?.id),
                  message: phoneLine?.id ? 'assignmentFlow: phoneLine OK' : 'assignmentFlow: no active phoneLine in workspace',
                });
              }
            }
          }
        }
      }

      const phoneLineDup = (step.expect as any)?.phoneLineDuplicateConflict;
      if (phoneLineDup && typeof phoneLineDup === 'object') {
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const waPhoneNumberId =
          String((phoneLineDup as any)?.waPhoneNumberId || '').trim() ||
          `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

        const wsA = 'scenario-wa-conflict-a';
        const wsB = 'scenario-wa-conflict-b';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'phoneLineDuplicateConflict: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'phoneLineDuplicateConflict: auth header missing' });
        } else {
          // Prepare hidden workspaces + memberships (archived at the end; never delete).
          await prisma.workspace
            .upsert({
              where: { id: wsA },
              create: { id: wsA, name: 'Scenario WA Conflict A', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario WA Conflict A', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.workspace
            .upsert({
              where: { id: wsB },
              create: { id: wsB, name: 'Scenario WA Conflict B', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario WA Conflict B', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsA } },
              create: { userId, workspaceId: wsA, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsB } },
              create: { userId, workspaceId: wsB, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const createInA = await app.inject({
            method: 'POST',
            url: '/api/phone-lines',
            headers: {
              authorization: authHeader,
              'x-workspace-id': wsA,
              'content-type': 'application/json',
            },
            payload: JSON.stringify({
              alias: 'Scenario A',
              phoneE164: null,
              waPhoneNumberId,
              wabaId: null,
              defaultProgramId: null,
              isActive: true,
            }),
          });

          assertions.push({
            ok: createInA.statusCode === 200,
            message:
              createInA.statusCode === 200
                ? `phoneLineDuplicateConflict: created in ${wsA}`
                : `phoneLineDuplicateConflict: create in ${wsA} failed (${createInA.statusCode})`,
          });

          const createInB = await app.inject({
            method: 'POST',
            url: '/api/phone-lines',
            headers: {
              authorization: authHeader,
              'x-workspace-id': wsB,
              'content-type': 'application/json',
            },
            payload: JSON.stringify({
              alias: 'Scenario B',
              phoneE164: null,
              waPhoneNumberId,
              wabaId: null,
              defaultProgramId: null,
              isActive: true,
            }),
          });

          let body: any = null;
          try {
            body = JSON.parse(String(createInB.body || ''));
          } catch {
            body = null;
          }

          const is409 = createInB.statusCode === 409;
          const hasPayload = Boolean(body?.conflictWorkspaceId) && Boolean(body?.conflictPhoneLineId);
          const pointsToA = String(body?.conflictWorkspaceId || '') === wsA;

          assertions.push({
            ok: is409 && hasPayload,
            message: is409 && hasPayload ? 'phoneLineDuplicateConflict: got 409 + conflict payload' : `phoneLineDuplicateConflict: expected 409 + payload, got ${createInB.statusCode}`,
          });
          assertions.push({
            ok: !hasPayload || pointsToA,
            message: pointsToA ? `phoneLineDuplicateConflict: conflict points to ${wsA}` : `phoneLineDuplicateConflict: conflictWorkspaceId mismatch (${String(body?.conflictWorkspaceId || '—')})`,
          });

          // Cleanup: archive-only.
          await prisma.phoneLine
            .updateMany({
              where: { workspaceId: { in: [wsA, wsB] }, waPhoneNumberId },
              data: { isActive: false, archivedAt: now } as any,
            })
            .catch(() => {});
          await prisma.membership
            .updateMany({ where: { userId, workspaceId: { in: [wsA, wsB] } }, data: { archivedAt: now } as any })
            .catch(() => {});
          await prisma.workspace
            .updateMany({ where: { id: { in: [wsA, wsB] } }, data: { archivedAt: now } as any })
            .catch(() => {});
        }
      }

      const wizardGates = (step.expect as any)?.workspaceCreationWizardGates;
      if (wizardGates && typeof wizardGates === 'object') {
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const wsId = String((wizardGates as any)?.workspaceId || 'scenario-wizard-gates').trim() || 'scenario-wizard-gates';
        const template = normalizeWorkspaceTemplateId((wizardGates as any)?.template || 'SUPPORT');
        const now = new Date();
        const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

        if (!userId) {
          assertions.push({ ok: false, message: 'workspaceCreationWizardGates: userId missing' });
        } else {
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Setup Wizard', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Setup Wizard', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          await seedWorkspaceTemplate({ workspaceId: wsId, template, userId }).catch(() => {});

          const ws = await prisma.workspace.findUnique({
            where: { id: wsId },
            select: { id: true, clientDefaultProgramId: true as any, staffDefaultProgramId: true as any },
          });

          const activePrograms = await prisma.program.findMany({
            where: { workspaceId: wsId, archivedAt: null, isActive: true },
            select: { id: true },
          });

          const hasLine = await prisma.phoneLine.findFirst({
            where: { workspaceId: wsId, archivedAt: null, isActive: true },
            select: { id: true },
          });
          if (!hasLine?.id) {
            await prisma.phoneLine
              .create({
                data: {
                  workspaceId: wsId,
                  alias: 'Scenario Setup Line',
                  waPhoneNumberId,
                  phoneE164: null,
                  defaultProgramId: (ws as any)?.clientDefaultProgramId || null,
                  isActive: true,
                } as any,
              })
              .catch(() => {});
          }

          const me = await prisma.membership.findUnique({
            where: { userId_workspaceId: { userId, workspaceId: wsId } },
            select: { id: true, staffWhatsAppE164: true as any },
          });
          if (me?.id && !String((me as any).staffWhatsAppE164 || '').trim()) {
            await prisma.membership
              .update({
                where: { id: me.id },
                data: { staffWhatsAppE164: '+56982345846' } as any,
              })
              .catch(() => {});
          }

          const phoneLineOk = await prisma.phoneLine.findFirst({
            where: { workspaceId: wsId, archivedAt: null, isActive: true },
            select: { id: true },
          });
          const usersOk = await prisma.membership.findFirst({
            where: { workspaceId: wsId, archivedAt: null, staffWhatsAppE164: { not: null } } as any,
            select: { id: true },
          });
          const automations = await prisma.automationRule.findMany({
            where: { workspaceId: wsId, archivedAt: null },
            select: { trigger: true, enabled: true, actionsJson: true },
          });
          const hasInboundRunAgent = automations.some((a) => {
            if (!a.enabled || String(a.trigger || '').toUpperCase() !== 'INBOUND_MESSAGE') return false;
            try {
              const parsed = JSON.parse(String(a.actionsJson || '[]'));
              return Array.isArray(parsed) && parsed.some((x: any) => String(x?.type || '').toUpperCase() === 'RUN_AGENT');
            } catch {
              return false;
            }
          });
          const hasStageNotify = automations.some((a) => {
            if (!a.enabled || String(a.trigger || '').toUpperCase() !== 'STAGE_CHANGED') return false;
            try {
              const parsed = JSON.parse(String(a.actionsJson || '[]'));
              return (
                Array.isArray(parsed) &&
                parsed.some((x: any) =>
                  ['NOTIFY_STAFF_WHATSAPP', 'ASSIGN_TO_NURSE_LEADER'].includes(String(x?.type || '').toUpperCase()),
                )
              );
            } catch {
              return false;
            }
          });

          assertions.push({ ok: Boolean(phoneLineOk?.id), message: phoneLineOk?.id ? 'workspaceCreationWizardGates: PhoneLine OK' : 'workspaceCreationWizardGates: PhoneLine missing' });
          assertions.push({
            ok: activePrograms.length >= 2,
            message:
              activePrograms.length >= 2
                ? `workspaceCreationWizardGates: Programs OK (${activePrograms.length})`
                : `workspaceCreationWizardGates: Programs insuficientes (${activePrograms.length})`,
          });
          assertions.push({
            ok: Boolean((ws as any)?.clientDefaultProgramId) && Boolean((ws as any)?.staffDefaultProgramId),
            message:
              Boolean((ws as any)?.clientDefaultProgramId) && Boolean((ws as any)?.staffDefaultProgramId)
                ? 'workspaceCreationWizardGates: Routing defaults OK'
                : 'workspaceCreationWizardGates: faltan defaults CLIENT/STAFF',
          });
          assertions.push({ ok: Boolean(usersOk?.id), message: usersOk?.id ? 'workspaceCreationWizardGates: Usuarios staffWhatsApp OK' : 'workspaceCreationWizardGates: falta staffWhatsApp' });
          assertions.push({ ok: hasInboundRunAgent, message: hasInboundRunAgent ? 'workspaceCreationWizardGates: Automation RUN_AGENT OK' : 'workspaceCreationWizardGates: falta RUN_AGENT' });
          assertions.push({ ok: hasStageNotify, message: hasStageNotify ? 'workspaceCreationWizardGates: Notificaciones stage OK' : 'workspaceCreationWizardGates: falta stage->notify' });

          await prisma.phoneLine.updateMany({ where: { workspaceId: wsId }, data: { isActive: false, archivedAt: now } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const phoneLineTransfer = (step.expect as any)?.phoneLineTransfer;
      if (phoneLineTransfer && typeof phoneLineTransfer === 'object') {
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const waPhoneNumberId =
          String((phoneLineTransfer as any)?.waPhoneNumberId || '').trim() ||
          `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const wsA = 'scenario-transfer-a';
        const wsB = 'scenario-transfer-b';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'phoneLineTransfer: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'phoneLineTransfer: auth header missing' });
        } else {
          await prisma.workspace
            .upsert({
              where: { id: wsA },
              create: { id: wsA, name: 'Scenario Transfer A', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Transfer A', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.workspace
            .upsert({
              where: { id: wsB },
              create: { id: wsB, name: 'Scenario Transfer B', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Transfer B', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsA } },
              create: { userId, workspaceId: wsA, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsB } },
              create: { userId, workspaceId: wsB, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const line = await prisma.phoneLine
            .create({
              data: {
                workspaceId: wsA,
                alias: 'Scenario Transfer Line',
                waPhoneNumberId,
                phoneE164: null,
                isActive: true,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          if (!line?.id) {
            assertions.push({ ok: false, message: 'phoneLineTransfer: failed to create source line' });
          } else {
            const transferRes = await app.inject({
              method: 'POST',
              url: `/api/phone-lines/${line.id}/transfer`,
              headers: {
                authorization: authHeader,
                'x-workspace-id': wsA,
                'content-type': 'application/json',
              },
              payload: JSON.stringify({ targetWorkspaceId: wsB }),
            });

            const ok = transferRes.statusCode === 200;
            assertions.push({
              ok,
              message: ok ? 'phoneLineTransfer: transfer endpoint OK' : `phoneLineTransfer: expected 200, got ${transferRes.statusCode}`,
            });

            const sourceArchived = await prisma.phoneLine.findUnique({
              where: { id: line.id },
              select: { archivedAt: true, isActive: true },
            });
            const targetExists = await prisma.phoneLine.findFirst({
              where: { workspaceId: wsB, waPhoneNumberId, archivedAt: null, isActive: true },
              select: { id: true },
            });

            assertions.push({
              ok: Boolean(sourceArchived?.archivedAt) && sourceArchived?.isActive === false,
              message:
                Boolean(sourceArchived?.archivedAt) && sourceArchived?.isActive === false
                  ? 'phoneLineTransfer: source archived OK'
                  : 'phoneLineTransfer: source not archived',
            });
            assertions.push({
              ok: Boolean(targetExists?.id),
              message: targetExists?.id ? 'phoneLineTransfer: target active line OK' : 'phoneLineTransfer: target line missing',
            });
          }

          await prisma.phoneLine
            .updateMany({
              where: { workspaceId: { in: [wsA, wsB] }, waPhoneNumberId },
              data: { isActive: false, archivedAt: now } as any,
            })
            .catch(() => {});
          await prisma.membership
            .updateMany({ where: { userId, workspaceId: { in: [wsA, wsB] } }, data: { archivedAt: now } as any })
            .catch(() => {});
          await prisma.workspace
            .updateMany({ where: { id: { in: [wsA, wsB] } }, data: { archivedAt: now } as any })
            .catch(() => {});
        }
      }

      const inboundRouting = (step.expect as any)?.inboundRoutingSingleOwner;
      if (inboundRouting && typeof inboundRouting === 'object') {
        const waPhoneNumberId =
          String((inboundRouting as any)?.waPhoneNumberId || '').trim() ||
          `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const wsId = 'scenario-inbound-routing';
        const lineId = 'scenario-inbound-routing-line';
        const now = new Date();

        await prisma.workspace
          .upsert({
            where: { id: wsId },
            create: { id: wsId, name: 'Scenario Inbound Routing', isSandbox: false, archivedAt: null } as any,
            update: { name: 'Scenario Inbound Routing', isSandbox: false, archivedAt: null } as any,
          })
          .catch(() => {});

        await prisma.phoneLine
          .upsert({
            where: { id: lineId },
            create: {
              id: lineId,
              workspaceId: wsId,
              alias: 'Scenario Inbound',
              phoneE164: null,
              waPhoneNumberId,
              wabaId: null,
              defaultProgramId: null,
              isActive: true,
              archivedAt: null,
            } as any,
            update: {
              workspaceId: wsId,
              alias: 'Scenario Inbound',
              phoneE164: null,
              waPhoneNumberId,
              wabaId: null,
              defaultProgramId: null,
              isActive: true,
              archivedAt: null,
            } as any,
          })
          .catch(() => {});

        const routingRes = await resolveInboundPhoneLineRouting({ waPhoneNumberId });
        const pass =
          routingRes.kind === 'RESOLVED' &&
          routingRes.workspaceId === wsId &&
          routingRes.phoneLineId === lineId;
        assertions.push({
          ok: pass,
          message: pass
            ? `inboundRoutingSingleOwner: RESOLVED to ${wsId}/${lineId}`
            : `inboundRoutingSingleOwner: expected RESOLVED to ${wsId}/${lineId}, got ${String(routingRes.kind)}`,
        });

        // Cleanup: archive-only to keep DEV tidy.
        await prisma.phoneLine
          .updateMany({ where: { id: lineId }, data: { isActive: false, archivedAt: now } as any })
          .catch(() => {});
        await prisma.workspace
          .updateMany({ where: { id: wsId }, data: { archivedAt: now } as any })
          .catch(() => {});
      }

      const inboundDefaultProgram = (step.expect as any)?.inboundRoutingDefaultProgram;
      if (inboundDefaultProgram && typeof inboundDefaultProgram === 'object') {
        const waPhoneNumberId =
          String((inboundDefaultProgram as any)?.waPhoneNumberId || '').trim() ||
          `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const wsId = 'scenario-inbound-default-program';
        const lineId = 'scenario-inbound-default-program-line';
        const programSlug = 'scenario-default-program';
        const now = new Date();

        await prisma.workspace
          .upsert({
            where: { id: wsId },
            create: { id: wsId, name: 'Scenario Inbound Default Program', isSandbox: false, archivedAt: null } as any,
            update: { name: 'Scenario Inbound Default Program', isSandbox: false, archivedAt: null } as any,
          })
          .catch(() => {});

        const program = await prisma.program
          .upsert({
            where: { workspaceId_slug: { workspaceId: wsId, slug: programSlug } } as any,
            create: {
              workspaceId: wsId,
              name: 'Scenario Default Program',
              slug: programSlug,
              description: 'Scenario program (default)',
              isActive: true,
              archivedAt: null,
              agentSystemPrompt:
                'Eres un agente de prueba. Responde en español de forma breve. Siempre incluye un SEND_MESSAGE si corresponde.',
            } as any,
            update: {
              name: 'Scenario Default Program',
              description: 'Scenario program (default)',
              isActive: true,
              archivedAt: null,
              agentSystemPrompt:
                'Eres un agente de prueba. Responde en español de forma breve. Siempre incluye un SEND_MESSAGE si corresponde.',
            } as any,
            select: { id: true, slug: true },
          })
          .catch(() => null);

        if (!program?.id) {
          assertions.push({ ok: false, message: 'inboundRoutingDefaultProgram: no se pudo crear Program de escenario' });
        } else {
          await prisma.phoneLine
            .upsert({
              where: { id: lineId },
              create: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Inbound Default',
                phoneE164: null,
                waPhoneNumberId,
                wabaId: null,
                defaultProgramId: program.id,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              update: {
                workspaceId: wsId,
                alias: 'Scenario Inbound Default',
                phoneE164: null,
                waPhoneNumberId,
                wabaId: null,
                defaultProgramId: program.id,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
            })
            .catch(() => {});

          const waFrom = '999';
          const contact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: waFrom } } as any,
              create: { workspaceId: wsId, waId: waFrom, phone: `+${waFrom}`, archivedAt: null } as any,
              update: { phone: `+${waFrom}`, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);

          const conversation = contact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: lineId,
                    programId: null,
                    contactId: contact.id,
                    status: 'NEW',
                    conversationStage: 'SANDBOX_SCENARIO',
                    channel: 'whatsapp',
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          if (!conversation?.id) {
            assertions.push({ ok: false, message: 'inboundRoutingDefaultProgram: no se pudo crear Conversation' });
          } else {
            const config = await getSystemConfig();
            const configOverride = { ...config, botAutoReply: false };
            const res = await handleInboundWhatsAppMessage(app, {
              waPhoneNumberId,
              from: waFrom,
              text: 'Hola',
              waMessageId: `scenario-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
              timestamp: Math.floor(Date.now() / 1000),
              profileName: null,
              media: null,
              rawPayload: { simulated: true, scenario: 'inbound_routing_default_program' },
              config: configOverride as any,
            } as any).catch(() => ({ conversationId: '' }));

            const updated = res?.conversationId
              ? await prisma.conversation
                  .findUnique({
                    where: { id: res.conversationId },
                    select: { programId: true, program: { select: { slug: true } } },
                  })
                  .catch(() => null)
              : null;
            const pass = Boolean(updated?.programId) && String(updated?.programId) === String(program.id);
            assertions.push({
              ok: pass,
              message: pass
                ? `inboundRoutingDefaultProgram: programId set OK (${updated?.program?.slug || '—'})`
                : `inboundRoutingDefaultProgram: expected programId=${program.id}, got ${String(updated?.programId || '—')}`,
            });
          }

          // Cleanup: archive-only to keep DEV tidy.
          await prisma.conversation
            .updateMany({ where: { workspaceId: wsId, phoneLineId: lineId }, data: { archivedAt: now } as any })
            .catch(() => {});
          await prisma.contact
            .updateMany({ where: { workspaceId: wsId, waId: waFrom }, data: { archivedAt: now } as any })
            .catch(() => {});
          await prisma.phoneLine
            .updateMany({ where: { id: lineId }, data: { isActive: false, archivedAt: now } as any })
            .catch(() => {});
          await prisma.program
            .updateMany({ where: { workspaceId: wsId, slug: programSlug }, data: { archivedAt: now } as any })
            .catch(() => {});
          await prisma.workspace
            .updateMany({ where: { id: wsId }, data: { archivedAt: now } as any })
            .catch(() => {});
        }
      }

      const inboundProgramMenu = (step.expect as any)?.inboundProgramMenu;
      if (inboundProgramMenu && typeof inboundProgramMenu === 'object') {
        const waPhoneNumberId =
          String((inboundProgramMenu as any)?.waPhoneNumberId || '').trim() ||
          `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const wsId = 'scenario-inbound-program-menu';
        const lineId = 'scenario-inbound-program-menu-line';
        const now = new Date();

        await prisma.workspace
          .upsert({
            where: { id: wsId },
            create: { id: wsId, name: 'Scenario Inbound Program Menu', isSandbox: false, archivedAt: null } as any,
            update: { name: 'Scenario Inbound Program Menu', isSandbox: false, archivedAt: null } as any,
          })
          .catch(() => {});

        const createProgram = async (slug: string, name: string) => {
          return prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug } } as any,
              create: {
                workspaceId: wsId,
                name,
                slug,
                description: 'Scenario program (menu)',
                isActive: true,
                archivedAt: null,
                agentSystemPrompt:
                  'Eres un agente de prueba. Responde en español de forma breve. Siempre incluye un SEND_MESSAGE si corresponde.',
              } as any,
              update: {
                name,
                description: 'Scenario program (menu)',
                isActive: true,
                archivedAt: null,
                agentSystemPrompt:
                  'Eres un agente de prueba. Responde en español de forma breve. Siempre incluye un SEND_MESSAGE si corresponde.',
              } as any,
              select: { id: true, name: true, slug: true },
            })
            .catch(() => null);
        };

        const progA = await createProgram('scenario-menu-a', 'Scenario Menu A');
        const progB = await createProgram('scenario-menu-b', 'Scenario Menu B');
        const progC = await createProgram('scenario-menu-c', 'Scenario Menu C');

        if (!progA?.id || !progB?.id || !progC?.id) {
          assertions.push({ ok: false, message: 'inboundProgramMenu: no se pudieron crear Programs de escenario' });
        } else {
          await prisma.phoneLine
            .upsert({
              where: { id: lineId },
              create: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Inbound Menu',
                phoneE164: null,
                waPhoneNumberId,
                wabaId: null,
                defaultProgramId: progC.id,
                inboundMode: 'MENU',
                programMenuIdsJson: JSON.stringify([progA.id, progB.id]),
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              update: {
                workspaceId: wsId,
                alias: 'Scenario Inbound Menu',
                phoneE164: null,
                waPhoneNumberId,
                wabaId: null,
                defaultProgramId: progC.id,
                inboundMode: 'MENU',
                programMenuIdsJson: JSON.stringify([progA.id, progB.id]),
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
            })
            .catch(() => {});

          // Use a sandbox waId so SAFE MODE does not block NULL transport scenarios.
          // We intentionally avoid synthetic "real-looking" phone numbers in DEV.
          const waFrom = 'sandbox';
          const contact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: waFrom } } as any,
              create: { workspaceId: wsId, waId: waFrom, phone: null, archivedAt: null } as any,
              update: { archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);

          const conversation = contact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: lineId,
                    programId: null,
                    contactId: contact.id,
                    status: 'NEW',
                    conversationStage: 'SANDBOX_SCENARIO',
                    channel: 'system',
                    isAdmin: false,
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          if (!conversation?.id) {
            assertions.push({ ok: false, message: 'inboundProgramMenu: no se pudo crear Conversation' });
          } else {
            const msg1 = await prisma.message
              .create({
                data: {
                  conversationId: conversation.id,
                  direction: 'INBOUND',
                  text: 'Hola',
                  rawPayload: JSON.stringify({ simulated: true, scenario: 'inbound_program_menu', step: 1 }),
                  timestamp: new Date(),
                  read: false,
                },
                select: { id: true },
              })
              .catch(() => null);

            await runAutomations({
              app,
              workspaceId: wsId,
              eventType: 'INBOUND_MESSAGE',
              conversationId: conversation.id,
              inboundMessageId: msg1?.id || null,
              inboundText: 'Hola',
              transportMode: 'NULL',
            });

            const convAfterMenu = await prisma.conversation
              .findUnique({
                where: { id: conversation.id },
                select: { conversationStage: true, stageTags: true, programId: true },
              })
              .catch(() => null);
            const tagsRaw = String((convAfterMenu as any)?.stageTags || '');
            const hasPendingTag = tagsRaw.includes('program_menu_pending');
            assertions.push({
              ok: hasPendingTag,
              message: hasPendingTag ? 'inboundProgramMenu: pending tag OK' : 'inboundProgramMenu: pending tag missing',
            });
            assertions.push({
              ok: !convAfterMenu?.programId,
              message: !convAfterMenu?.programId ? 'inboundProgramMenu: programId sigue null (menú)' : 'inboundProgramMenu: programId no debería setearse antes de elegir',
            });

            const lastOut = await prisma.message
              .findFirst({
                where: { conversationId: conversation.id, direction: 'OUTBOUND' },
                orderBy: { timestamp: 'desc' },
                select: { text: true, transcriptText: true },
              })
              .catch(() => null);
            const outText = String(lastOut?.transcriptText || lastOut?.text || '');
            assertions.push({
              ok: outText.includes('1)') && outText.includes('Scenario Menu A') && outText.includes('Scenario Menu B'),
              message: outText ? 'inboundProgramMenu: menú contiene A/B' : 'inboundProgramMenu: no se encontró outbound menú',
            });
            assertions.push({
              ok: !outText.includes('Scenario Menu C'),
              message: !outText.includes('Scenario Menu C') ? 'inboundProgramMenu: menú NO incluye C' : 'inboundProgramMenu: menú incluye Program no permitido (C)',
            });

            const msg2 = await prisma.message
              .create({
                data: {
                  conversationId: conversation.id,
                  direction: 'INBOUND',
                  text: '1',
                  rawPayload: JSON.stringify({ simulated: true, scenario: 'inbound_program_menu', step: 2 }),
                  timestamp: new Date(),
                  read: false,
                },
                select: { id: true },
              })
              .catch(() => null);
            await runAutomations({
              app,
              workspaceId: wsId,
              eventType: 'INBOUND_MESSAGE',
              conversationId: conversation.id,
              inboundMessageId: msg2?.id || null,
              inboundText: '1',
              transportMode: 'NULL',
            });

            const convAfterPick = await prisma.conversation
              .findUnique({ where: { id: conversation.id }, select: { programId: true } })
              .catch(() => null);
            const pickedOk = Boolean(convAfterPick?.programId) && String(convAfterPick?.programId) === String(progA.id);
            assertions.push({
              ok: pickedOk,
              message: pickedOk ? 'inboundProgramMenu: programId asignado por opción OK (1 => A)' : `inboundProgramMenu: expected programId=${progA.id}, got ${String(convAfterPick?.programId || '—')}`,
            });

            // Cleanup: archive-only to keep DEV tidy.
            await prisma.conversation.updateMany({ where: { id: conversation.id }, data: { archivedAt: now } as any }).catch(() => {});
            if (contact?.id) {
              await prisma.contact.updateMany({ where: { id: contact.id }, data: { archivedAt: now } as any }).catch(() => {});
            }
          }

          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { isActive: false, archivedAt: now } as any }).catch(() => {});
          await prisma.program.updateMany({ where: { workspaceId: wsId, slug: { in: ['scenario-menu-a', 'scenario-menu-b', 'scenario-menu-c'] } }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const inviteExistingUserAccept = (step.expect as any)?.inviteExistingUserAccept;
      if (inviteExistingUserAccept) {
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        if (!userId) {
          assertions.push({ ok: false, message: 'inviteExistingUserAccept: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'inviteExistingUserAccept: auth header missing' });
        } else {
          const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, passwordHash: true } }).catch(() => null);
          const email = String(user?.email || '').trim().toLowerCase();
          if (!email) {
            assertions.push({ ok: false, message: 'inviteExistingUserAccept: no se pudo resolver email del usuario' });
          } else {
            const wsId = 'scenario-invite-existing-user';
            const now = new Date();
            await prisma.workspace
              .upsert({
                where: { id: wsId },
                create: { id: wsId, name: 'Scenario Invite Existing User', isSandbox: false, archivedAt: null } as any,
                update: { name: 'Scenario Invite Existing User', isSandbox: false, archivedAt: null } as any,
              })
              .catch(() => {});

            const token = `scenario-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            const invite = await prisma.workspaceInvite
              .create({
                data: {
                  workspaceId: wsId,
                  email,
                  role: 'MEMBER',
                  assignedOnly: false,
                  token,
                  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                  archivedAt: null,
                } as any,
                select: { token: true, id: true },
              })
              .catch(() => null);
            if (!invite?.token) {
              assertions.push({ ok: false, message: 'inviteExistingUserAccept: no se pudo crear invite' });
            } else {
              const beforeHash = String(user?.passwordHash || '');
              const res = await app.inject({
                method: 'POST',
                url: `/api/invites/${encodeURIComponent(invite.token)}/accept-existing`,
                headers: { authorization: authHeader, 'content-type': 'application/json', 'x-workspace-id': 'default' },
                payload: JSON.stringify({}),
              });
              const ok = res.statusCode === 200;
              assertions.push({
                ok,
                message: ok ? 'inviteExistingUserAccept: accept-existing 200 OK' : `inviteExistingUserAccept: accept-existing failed (${res.statusCode})`,
              });

              const after = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }).catch(() => null);
              const hashOk = String(after?.passwordHash || '') === beforeHash;
              assertions.push({
                ok: hashOk,
                message: hashOk ? 'inviteExistingUserAccept: passwordHash no cambia (OK)' : 'inviteExistingUserAccept: passwordHash cambió (NO OK)',
              });

              const membership = await prisma.membership
                .findFirst({ where: { userId, workspaceId: wsId, archivedAt: null }, select: { role: true } })
                .catch(() => null);
              const membershipOk = Boolean(membership) && String(membership?.role || '').toUpperCase() === 'MEMBER';
              assertions.push({
                ok: membershipOk,
                message: membershipOk ? 'inviteExistingUserAccept: membership creada (MEMBER)' : 'inviteExistingUserAccept: membership missing/invalid',
              });

              // Cleanup: archive-only.
              await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
              await prisma.workspaceInvite.updateMany({ where: { id: invite.id }, data: { archivedAt: now } as any }).catch(() => {});
              await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
            }
          }
        }
      }

      const copilotArchiveRestore = (step.expect as any)?.copilotArchiveRestore;
      if (copilotArchiveRestore) {
        const authHeader = String((request.headers as any)?.authorization || '');
        const access = await resolveWorkspaceAccess(request);
        const wsId = access.workspaceId || 'default';
        if (!authHeader) {
          assertions.push({ ok: false, message: 'copilotArchiveRestore: auth header missing' });
        } else {
          const createRes = await app.inject({
            method: 'POST',
            url: '/api/copilot/threads',
            headers: { authorization: authHeader, 'x-workspace-id': wsId, 'content-type': 'application/json' },
            payload: JSON.stringify({ title: `Scenario Copilot Archive ${new Date().toISOString()}` }),
          });
          let createdJson: any = null;
          try {
            createdJson = JSON.parse(String(createRes.body || ''));
          } catch {
            createdJson = null;
          }
          const threadId = createdJson?.id ? String(createdJson.id) : '';
          assertions.push({
            ok: createRes.statusCode === 200 && Boolean(threadId),
            message: createRes.statusCode === 200 && threadId ? 'copilotArchiveRestore: thread creado OK' : `copilotArchiveRestore: create thread failed (${createRes.statusCode})`,
          });

          if (threadId) {
            const listActive = await app.inject({
              method: 'GET',
              url: '/api/copilot/threads',
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
            });
            const activeArr = (() => {
              try {
                const parsed = JSON.parse(String(listActive.body || '[]'));
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            })();
            assertions.push({
              ok: activeArr.some((t: any) => String(t?.id || '') === threadId),
              message: activeArr.some((t: any) => String(t?.id || '') === threadId) ? 'copilotArchiveRestore: thread aparece en activos' : 'copilotArchiveRestore: thread no aparece en activos',
            });

            const archRes = await app.inject({
              method: 'PATCH',
              url: `/api/copilot/threads/${encodeURIComponent(threadId)}`,
              headers: { authorization: authHeader, 'x-workspace-id': wsId, 'content-type': 'application/json' },
              payload: JSON.stringify({ archived: true }),
            });
            assertions.push({
              ok: archRes.statusCode === 200,
              message: archRes.statusCode === 200 ? 'copilotArchiveRestore: archivar OK' : `copilotArchiveRestore: archivar failed (${archRes.statusCode})`,
            });

            const listAfterArchive = await app.inject({
              method: 'GET',
              url: '/api/copilot/threads',
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
            });
            const activeAfter = (() => {
              try {
                const parsed = JSON.parse(String(listAfterArchive.body || '[]'));
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            })();
            assertions.push({
              ok: !activeAfter.some((t: any) => String(t?.id || '') === threadId),
              message: !activeAfter.some((t: any) => String(t?.id || '') === threadId) ? 'copilotArchiveRestore: thread NO aparece en activos tras archivar' : 'copilotArchiveRestore: thread sigue en activos tras archivar',
            });

            const listArchived = await app.inject({
              method: 'GET',
              url: '/api/copilot/threads?includeArchived=1',
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
            });
            const archivedArr = (() => {
              try {
                const parsed = JSON.parse(String(listArchived.body || '[]'));
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            })();
            const archivedRow = archivedArr.find((t: any) => String(t?.id || '') === threadId) || null;
            assertions.push({
              ok: Boolean(archivedRow) && Boolean(archivedRow?.archivedAt),
              message: Boolean(archivedRow) && archivedRow?.archivedAt ? 'copilotArchiveRestore: thread aparece en archivados' : 'copilotArchiveRestore: thread no aparece en archivados',
            });

            const restoreRes = await app.inject({
              method: 'PATCH',
              url: `/api/copilot/threads/${encodeURIComponent(threadId)}`,
              headers: { authorization: authHeader, 'x-workspace-id': wsId, 'content-type': 'application/json' },
              payload: JSON.stringify({ archived: false }),
            });
            assertions.push({
              ok: restoreRes.statusCode === 200,
              message: restoreRes.statusCode === 200 ? 'copilotArchiveRestore: restaurar OK' : `copilotArchiveRestore: restore failed (${restoreRes.statusCode})`,
            });

            const listAfterRestore = await app.inject({
              method: 'GET',
              url: '/api/copilot/threads',
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
            });
            const afterRestoreArr = (() => {
              try {
                const parsed = JSON.parse(String(listAfterRestore.body || '[]'));
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            })();
            assertions.push({
              ok: afterRestoreArr.some((t: any) => String(t?.id || '') === threadId),
              message: afterRestoreArr.some((t: any) => String(t?.id || '') === threadId) ? 'copilotArchiveRestore: thread vuelve a activos (OK)' : 'copilotArchiveRestore: thread no volvió a activos',
            });

            // Cleanup: archive again to keep history tidy.
            await app.inject({
              method: 'PATCH',
              url: `/api/copilot/threads/${encodeURIComponent(threadId)}`,
              headers: { authorization: authHeader, 'x-workspace-id': wsId, 'content-type': 'application/json' },
              payload: JSON.stringify({ archived: true }),
            });
          }
        }
      }

      const copilotContextFollowup = (step.expect as any)?.copilotContextFollowup;
      if (copilotContextFollowup) {
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const wsId = 'scenario-copilot-followup';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'copilotContextFollowup: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'copilotContextFollowup: auth header missing' });
        } else {
          // Ensure a workspace with enough Automations to trigger the follow-up prompt (>6).
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Copilot Followup', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Copilot Followup', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const existingCount = await prisma.automationRule.count({ where: { workspaceId: wsId, archivedAt: null } }).catch(() => 0);
          const needed = Math.max(0, 7 - existingCount);
          for (let i = 0; i < needed; i++) {
            await prisma.automationRule
              .create({
                data: {
                  workspaceId: wsId,
                  name: `Scenario rule ${i + 1}`,
                  enabled: true,
                  priority: 100 + i,
                  trigger: 'INBOUND_MESSAGE',
                  scopePhoneLineId: null,
                  scopeProgramId: null,
                  conditionsJson: '[]',
                  actionsJson: JSON.stringify([{ type: 'ADD_NOTE', note: 'noop' }]),
                  archivedAt: null,
                } as any,
              })
              .catch(() => {});
          }

          const askRes = await app.inject({
            method: 'POST',
            url: '/api/copilot/chat',
            headers: { authorization: authHeader, 'x-workspace-id': wsId, 'content-type': 'application/json' },
            payload: JSON.stringify({ text: 'explica automations', view: 'review', threadId: null }),
          });
          let askJson: any = null;
          try {
            askJson = JSON.parse(String(askRes.body || ''));
          } catch {
            askJson = null;
          }
          const threadId = String(askJson?.threadId || '').trim();
          const askOk = askRes.statusCode === 200 && Boolean(threadId);
          assertions.push({
            ok: askOk,
            message: askOk ? 'copilotContextFollowup: primer mensaje OK (thread creado)' : `copilotContextFollowup: /chat failed (${askRes.statusCode})`,
          });
          if (askOk) {
            const replyText = String(askJson?.reply || '');
            const prompted = replyText.toLowerCase().includes('responde') && replyText.toLowerCase().includes('si');
            assertions.push({
              ok: prompted,
              message: prompted ? 'copilotContextFollowup: Copilot pidió confirmación (OK)' : 'copilotContextFollowup: Copilot no pidió confirmación',
            });

            const yesRes = await app.inject({
              method: 'POST',
              url: '/api/copilot/chat',
              headers: { authorization: authHeader, 'x-workspace-id': wsId, 'content-type': 'application/json' },
              payload: JSON.stringify({ text: 'sí', view: 'review', threadId }),
            });
            let yesJson: any = null;
            try {
              yesJson = JSON.parse(String(yesRes.body || ''));
            } catch {
              yesJson = null;
            }
            const yesOk = yesRes.statusCode === 200 && String(yesJson?.reply || '').includes(`Automations en workspace \"${wsId}\"`);
            assertions.push({
              ok: yesOk,
              message: yesOk ? 'copilotContextFollowup: follow-up "sí" listó automations (OK)' : `copilotContextFollowup: follow-up failed (${yesRes.statusCode})`,
            });

            const thread = await prisma.copilotThread.findUnique({ where: { id: threadId }, select: { stateJson: true as any } }).catch(() => null);
            const stateCleared = !thread?.stateJson;
            assertions.push({
              ok: stateCleared,
              message: stateCleared ? 'copilotContextFollowup: stateJson limpiado (OK)' : 'copilotContextFollowup: stateJson sigue pendiente',
            });

            // Cleanup: archive-only.
            await prisma.copilotThread.updateMany({ where: { id: threadId }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.copilotRunLog.updateMany({ where: { threadId }, data: { status: 'SUCCESS' } as any }).catch(() => {});
          }

          await prisma.automationRule.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const platformGate = (step.expect as any)?.platformSuperadminGate;
      if (platformGate) {
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        if (!userId) {
          assertions.push({ ok: false, message: 'platformSuperadminGate: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'platformSuperadminGate: auth header missing' });
        } else {
          const user = await prisma.user
            .findUnique({ where: { id: userId }, select: { platformRole: true } })
            .catch(() => null);
          const expected = String(user?.platformRole || '').toUpperCase() === 'SUPERADMIN';

          const meRes = await app.inject({
            method: 'GET',
            url: '/api/platform/me',
            headers: { authorization: authHeader, 'x-workspace-id': 'default' },
          });
          let meJson: any = null;
          try {
            meJson = JSON.parse(String(meRes.body || ''));
          } catch {
            meJson = null;
          }
          const meOk = meRes.statusCode === 200 && typeof meJson?.platformAdmin === 'boolean';
          assertions.push({
            ok: meOk,
            message: meOk ? 'platformSuperadminGate: /api/platform/me OK' : `platformSuperadminGate: /api/platform/me failed (${meRes.statusCode})`,
          });
          if (meOk) {
            const pass = Boolean(meJson.platformAdmin) === expected;
            assertions.push({
              ok: pass,
              message: pass ? `platformSuperadminGate: platformAdmin=${expected} OK` : `platformSuperadminGate: expected platformAdmin=${expected}, got ${String(meJson.platformAdmin)}`,
            });
          }

          const wsRes = await app.inject({
            method: 'GET',
            url: '/api/platform/workspaces',
            headers: { authorization: authHeader, 'x-workspace-id': 'default' },
          });
          const passCode = expected ? wsRes.statusCode === 200 : wsRes.statusCode === 403;
          assertions.push({
            ok: passCode,
            message: passCode
              ? `platformSuperadminGate: /api/platform/workspaces ${expected ? '200' : '403'} OK`
              : `platformSuperadminGate: expected ${expected ? '200' : '403'}, got ${wsRes.statusCode}`,
          });
        }
      }

      const ssclinicalStageAssign = (step.expect as any)?.ssclinicalStageAssign;
      if (ssclinicalStageAssign && typeof ssclinicalStageAssign === 'object') {
        const wsId = String((ssclinicalStageAssign as any)?.workspaceId || 'ssclinical').trim() || 'ssclinical';
        const now = new Date();

        const ws = await prisma.workspace
          .findUnique({
            where: { id: wsId },
            select: { id: true, archivedAt: true, ssclinicalNurseLeaderEmail: true as any },
          } as any)
          .catch(() => null);
        assertions.push({
          ok: Boolean(ws?.id) && !ws?.archivedAt,
          message: ws?.id ? (ws.archivedAt ? `ssclinicalStageAssign: workspace ${wsId} archived` : `ssclinicalStageAssign: workspace ${wsId} OK`) : `ssclinicalStageAssign: workspace ${wsId} missing`,
        });

        const rules = await prisma.automationRule
          .findMany({
            where: { workspaceId: wsId, trigger: 'STAGE_CHANGED', enabled: true, archivedAt: null },
            select: { id: true, actionsJson: true },
          })
          .catch(() => []);
        const hasAssignRule = rules.some((r) => {
          try {
            const parsed = JSON.parse(String(r.actionsJson || '[]'));
            if (!Array.isArray(parsed)) return false;
            return parsed.some((a: any) => String(a?.type || '').toUpperCase() === 'ASSIGN_TO_NURSE_LEADER');
          } catch {
            return false;
          }
        });
        assertions.push({
          ok: hasAssignRule,
          message: hasAssignRule ? 'ssclinicalStageAssign: automation STAGE_CHANGED -> ASSIGN_TO_NURSE_LEADER OK' : 'ssclinicalStageAssign: missing automation STAGE_CHANGED assignment',
        });

        const leaderEmail = String((ws as any)?.ssclinicalNurseLeaderEmail || '').trim().toLowerCase();
        assertions.push({
          ok: Boolean(leaderEmail),
          message: leaderEmail ? `ssclinicalStageAssign: nurseLeaderEmail OK (${leaderEmail})` : 'ssclinicalStageAssign: nurseLeaderEmail missing (Config -> Workspace)',
        });

        const leaderUser = leaderEmail
          ? await prisma.user.findUnique({ where: { email: leaderEmail }, select: { id: true } }).catch(() => null)
          : null;
        const leaderMembership =
          leaderUser?.id
            ? await prisma.membership
                .findFirst({ where: { workspaceId: wsId, userId: leaderUser.id, archivedAt: null }, select: { id: true } })
                .catch(() => null)
            : null;
        assertions.push({
          ok: Boolean(leaderMembership?.id),
          message: leaderMembership?.id ? 'ssclinicalStageAssign: leader membership OK' : 'ssclinicalStageAssign: leader membership missing in workspace',
        });

        let phoneLine = await prisma.phoneLine
          .findFirst({ where: { workspaceId: wsId, archivedAt: null, isActive: true }, select: { id: true } })
          .catch(() => null);
        let tempPhoneLineId: string | null = null;
        if (!phoneLine?.id) {
          const id = `scenario-ssclinical-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          phoneLine = await prisma.phoneLine
            .create({
              data: {
                id,
                workspaceId: wsId,
                alias: 'Scenario SSClinical (temp)',
                phoneE164: null,
                waPhoneNumberId,
                wabaId: null,
                defaultProgramId: null,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          tempPhoneLineId = phoneLine?.id || null;
        }
        assertions.push({
          ok: Boolean(phoneLine?.id),
          message: phoneLine?.id
            ? tempPhoneLineId
              ? 'ssclinicalStageAssign: phoneLine temporal creada por scenario'
              : 'ssclinicalStageAssign: phoneLine OK'
            : 'ssclinicalStageAssign: no active phoneLine in workspace',
        });

        if (ws?.id && !ws.archivedAt && phoneLine?.id && leaderMembership?.id && hasAssignRule) {
          const contact = await prisma.contact
            .create({
              data: {
                workspaceId: wsId,
                displayName: 'Scenario SSClinical',
                candidateName: null,
                candidateNameManual: null,
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const conv = contact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: phoneLine.id,
                    programId: null,
                    contactId: contact.id,
                    status: 'NEW',
                    conversationStage: 'NUEVO',
                    channel: 'system',
                    isAdmin: false,
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          if (!conv?.id) {
            assertions.push({ ok: false, message: 'ssclinicalStageAssign: no se pudo crear conversación de prueba' });
          } else {
            await prisma.conversation
              .update({ where: { id: conv.id }, data: { conversationStage: 'INTERESADO', updatedAt: new Date() } as any })
              .catch(() => {});
            await runAutomations({
              app,
              workspaceId: wsId,
              eventType: 'STAGE_CHANGED',
              conversationId: conv.id,
              transportMode: 'NULL',
            });

            const updated = await prisma.conversation
              .findUnique({ where: { id: conv.id }, select: { assignedToId: true, conversationStage: true } })
              .catch(() => null);
            const assignedOk = Boolean(updated?.assignedToId) && String(updated?.assignedToId) === String(leaderUser?.id || '');
            assertions.push({
              ok: assignedOk,
              message: assignedOk ? 'ssclinicalStageAssign: assignedToId OK (auto)' : `ssclinicalStageAssign: expected assignedToId=${String(leaderUser?.id || '—')}, got ${String(updated?.assignedToId || '—')}`,
            });

            // Cleanup: archive-only.
            await prisma.conversation.updateMany({ where: { id: conv.id }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.contact.updateMany({ where: { id: contact?.id || '' }, data: { archivedAt: now } as any }).catch(() => {});
            if (tempPhoneLineId) {
              await prisma.phoneLine.updateMany({ where: { id: tempPhoneLineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
            }
          }
        }
      }

      const ssclinicalNotify = (step.expect as any)?.ssclinicalHandoffInteresadoNotification;
      if (ssclinicalNotify && typeof ssclinicalNotify === 'object') {
        const wsId = String((ssclinicalNotify as any)?.workspaceId || 'ssclinical').trim() || 'ssclinical';
        const now = new Date();

        const ws = await prisma.workspace
          .findUnique({
            where: { id: wsId },
            select: { id: true, archivedAt: true, ssclinicalNurseLeaderEmail: true as any },
          } as any)
          .catch(() => null);
        assertions.push({
          ok: Boolean(ws?.id) && !ws?.archivedAt,
          message: ws?.id ? (ws.archivedAt ? `ssclinicalNotify: workspace ${wsId} archived` : `ssclinicalNotify: workspace ${wsId} OK`) : `ssclinicalNotify: workspace ${wsId} missing`,
        });

        const leaderEmail = String((ws as any)?.ssclinicalNurseLeaderEmail || '').trim().toLowerCase();
        if (!leaderEmail) {
          assertions.push({ ok: false, message: 'ssclinicalNotify: nurseLeaderEmail missing' });
        } else {
          const leaderUser = await prisma.user.findUnique({ where: { email: leaderEmail }, select: { id: true } }).catch(() => null);
          const leaderMembership = leaderUser?.id
            ? await prisma.membership
                .findFirst({ where: { workspaceId: wsId, userId: leaderUser.id, archivedAt: null }, select: { id: true } })
                .catch(() => null)
            : null;
          assertions.push({
            ok: Boolean(leaderMembership?.id),
            message: leaderMembership?.id ? 'ssclinicalNotify: leader membership OK' : 'ssclinicalNotify: leader membership missing',
          });

          let phoneLine = await prisma.phoneLine.findFirst({
            where: { workspaceId: wsId, archivedAt: null, isActive: true },
            select: { id: true },
          });
          let tempPhoneLineId: string | null = null;
          if (!phoneLine?.id) {
            // For scenarios, create a temporary active PhoneLine to avoid depending on manual workspace setup.
            // This does NOT send WhatsApp real (transportMode=NULL) and is archive-only cleaned up.
            tempPhoneLineId = `scenario-ssclinical-notify-line-${Date.now()}`;
            const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
            const created = await prisma.phoneLine
              .create({
                data: {
                  id: tempPhoneLineId,
                  workspaceId: wsId,
                  alias: 'Scenario SSClinical (temp)',
                  phoneE164: null,
                  waPhoneNumberId,
                  isActive: true,
                  archivedAt: null,
                  needsAttention: false,
                } as any,
                select: { id: true },
              })
              .catch(() => null);
            phoneLine = created?.id ? { id: created.id } : null;
          }
          if (!phoneLine?.id || !leaderUser?.id) {
            assertions.push({ ok: false, message: 'ssclinicalNotify: phoneLine o leaderUser missing' });
          } else {
            const contact = await prisma.contact
              .create({
                data: { workspaceId: wsId, displayName: 'Scenario SSClinical Notify', comuna: 'Providencia', archivedAt: null } as any,
                select: { id: true },
              })
              .catch(() => null);
            const conv = contact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: phoneLine.id,
                      programId: null,
                      contactId: contact.id,
                      status: 'NEW',
                      conversationStage: 'NUEVO',
                      channel: 'system',
                      isAdmin: false,
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;
            if (!conv?.id) {
              assertions.push({ ok: false, message: 'ssclinicalNotify: no se pudo crear conversación' });
            } else {
              await prisma.conversation.update({ where: { id: conv.id }, data: { conversationStage: 'INTERESADO' } as any }).catch(() => {});
              await runAutomations({
                app,
                workspaceId: wsId,
                eventType: 'STAGE_CHANGED',
                conversationId: conv.id,
                transportMode: 'NULL',
              });

              const assigned = await prisma.conversation.findUnique({ where: { id: conv.id }, select: { assignedToId: true } }).catch(() => null);
              const assignedOk = String(assigned?.assignedToId || '') === String(leaderUser.id || '');
              assertions.push({
                ok: assignedOk,
                message: assignedOk ? 'ssclinicalNotify: assignedToId OK' : `ssclinicalNotify: expected assignedToId=${leaderUser.id}, got ${String(assigned?.assignedToId || '—')}`,
              });

              const notif = await prisma.inAppNotification
                .findFirst({
                  where: { workspaceId: wsId, userId: leaderUser.id, conversationId: conv.id, archivedAt: null },
                  orderBy: { createdAt: 'desc' },
                  select: { id: true, title: true },
                })
                .catch(() => null);
              const notifOk = Boolean(notif?.id);
              assertions.push({
                ok: notifOk,
                message: notifOk ? 'ssclinicalNotify: NOTIFICATION_CREATED OK' : 'ssclinicalNotify: missing in-app notification',
              });

              // Cleanup: archive-only.
              await prisma.inAppNotification.updateMany({ where: { id: notif?.id || '' }, data: { archivedAt: now } as any }).catch(() => {});
              await prisma.conversation.updateMany({ where: { id: conv.id }, data: { archivedAt: now } as any }).catch(() => {});
              await prisma.contact.updateMany({ where: { id: contact?.id || '' }, data: { archivedAt: now } as any }).catch(() => {});
            }

            if (tempPhoneLineId) {
              await prisma.phoneLine.updateMany({ where: { id: tempPhoneLineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
            }
          }
        }
      }

      const ssclinicalStaffWhatsApp = (step.expect as any)?.ssclinicalStaffWhatsAppNotification;
      if (ssclinicalStaffWhatsApp && typeof ssclinicalStaffWhatsApp === 'object') {
        const wsId = String((ssclinicalStaffWhatsApp as any)?.workspaceId || 'ssclinical').trim() || 'ssclinical';
        const now = new Date();

        const ws = await prisma.workspace
          .findUnique({
            where: { id: wsId },
            select: { id: true, archivedAt: true, ssclinicalNurseLeaderEmail: true as any },
          } as any)
          .catch(() => null);
        assertions.push({
          ok: Boolean(ws?.id) && !ws?.archivedAt,
          message: ws?.id ? (ws.archivedAt ? `ssclinicalStaffWA: workspace ${wsId} archived` : `ssclinicalStaffWA: workspace ${wsId} OK`) : `ssclinicalStaffWA: workspace ${wsId} missing`,
        });

        const leaderEmail = String((ws as any)?.ssclinicalNurseLeaderEmail || '').trim().toLowerCase();
        if (!leaderEmail) {
          assertions.push({ ok: false, message: 'ssclinicalStaffWA: nurseLeaderEmail missing' });
        } else {
          const leaderUser = await prisma.user.findUnique({ where: { email: leaderEmail }, select: { id: true } }).catch(() => null);
          const leaderMembership = leaderUser?.id
            ? await prisma.membership
                .findFirst({
                  where: { workspaceId: wsId, userId: leaderUser.id, archivedAt: null },
                  select: { id: true, staffWhatsAppE164: true as any },
                })
                .catch(() => null)
            : null;
          assertions.push({
            ok: Boolean(leaderMembership?.id),
            message: leaderMembership?.id ? 'ssclinicalStaffWA: leader membership OK' : 'ssclinicalStaffWA: leader membership missing',
          });

          let phoneLine = await prisma.phoneLine.findFirst({
            where: { workspaceId: wsId, archivedAt: null, isActive: true },
            select: { id: true },
          });
          let tempPhoneLineId: string | null = null;
          if (!phoneLine?.id) {
            tempPhoneLineId = `scenario-ssclinical-staffwa-line-${Date.now()}`;
            const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
            const created = await prisma.phoneLine
              .create({
                data: {
                  id: tempPhoneLineId,
                  workspaceId: wsId,
                  alias: 'Scenario SSClinical StaffWA (temp)',
                  phoneE164: null,
                  waPhoneNumberId,
                  isActive: true,
                  archivedAt: null,
                  needsAttention: false,
                } as any,
                select: { id: true },
              })
              .catch(() => null);
            phoneLine = created?.id ? { id: created.id } : null;
          }

          if (!phoneLine?.id || !leaderUser?.id || !leaderMembership?.id) {
            assertions.push({ ok: false, message: 'ssclinicalStaffWA: phoneLine o leaderUser/membership missing' });
          } else {
            // Best-effort: set staff WhatsApp to the TEST number (allowlist) for deterministic validation.
            const staffE164 = '+56994830202';
            const previousStaff = String((leaderMembership as any).staffWhatsAppE164 || '').trim();
            if (previousStaff !== staffE164) {
              await prisma.membership.update({ where: { id: leaderMembership.id }, data: { staffWhatsAppE164: staffE164 } as any }).catch(() => {});
            }

            // Pre-create staff conversation and an inbound message to open the 24h window.
            const staffWaId = '56994830202';
            let staffContact = await prisma.contact
              .findFirst({ where: { workspaceId: wsId, waId: staffWaId } })
              .catch(() => null);
            let staffContactCreated = false;
            if (!staffContact) {
              staffContactCreated = true;
              staffContact = await prisma.contact
                .create({
                  data: { workspaceId: wsId, waId: staffWaId, phone: `+${staffWaId}`, displayName: 'Scenario Staff', archivedAt: null } as any,
                })
                .catch(() => null);
            }
            let staffConv = staffContact?.id
              ? await prisma.conversation
                  .findFirst({
                    where: {
                      workspaceId: wsId,
                      phoneLineId: phoneLine.id,
                      contactId: staffContact.id,
                      conversationKind: 'STAFF',
                      isAdmin: false,
                      archivedAt: null,
                    } as any,
                    orderBy: { updatedAt: 'desc' },
                  })
                  .catch(() => null)
              : null;
            let staffConvCreated = false;
            if (!staffConv && staffContact?.id) {
              staffConvCreated = true;
              staffConv = await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: phoneLine.id,
                    programId: null,
                    contactId: staffContact.id,
                    status: 'OPEN',
                    channel: 'whatsapp',
                    isAdmin: false,
                    aiMode: 'OFF',
                    conversationKind: 'STAFF',
                    conversationStage: 'NUEVO',
                    stageChangedAt: now,
                    archivedAt: null,
                  } as any,
                })
                .catch(() => null);
            }
            if (staffConv?.id) {
              await prisma.message
                .create({
                  data: {
                    conversationId: staffConv.id,
                    direction: 'INBOUND',
                    text: 'activar',
                    timestamp: now,
                    read: true,
                  } as any,
                })
                .catch(() => {});
            }

            // Create candidate conversation and set stage INTERESADO (triggers assignment + staff WA notify).
            const contact = await prisma.contact
              .create({
                data: { workspaceId: wsId, displayName: 'Scenario SSClinical StaffWA', comuna: 'Providencia', availabilityText: 'martes 10:00-12:00', archivedAt: null } as any,
                select: { id: true },
              })
              .catch(() => null);
            const conv = contact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: phoneLine.id,
                      programId: null,
                      contactId: contact.id,
                      status: 'NEW',
                      conversationStage: 'NUEVO',
                      channel: 'system',
                      isAdmin: false,
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

            if (!conv?.id) {
              assertions.push({ ok: false, message: 'ssclinicalStaffWA: no se pudo crear conversación cliente' });
            } else {
              await prisma.conversation.update({ where: { id: conv.id }, data: { conversationStage: 'INTERESADO' } as any }).catch(() => {});
              await runAutomations({
                app,
                workspaceId: wsId,
                eventType: 'STAGE_CHANGED',
                conversationId: conv.id,
                transportMode: 'NULL',
              });

              const assigned = await prisma.conversation.findUnique({ where: { id: conv.id }, select: { assignedToId: true } }).catch(() => null);
              const assignedOk = String(assigned?.assignedToId || '') === String(leaderUser.id || '');
              assertions.push({
                ok: assignedOk,
                message: assignedOk ? 'ssclinicalStaffWA: assignedToId OK' : `ssclinicalStaffWA: expected assignedToId=${leaderUser.id}, got ${String(assigned?.assignedToId || '—')}`,
              });

              const notif = await prisma.inAppNotification
                .findFirst({
                  where: { workspaceId: wsId, userId: leaderUser.id, conversationId: conv.id, archivedAt: null },
                  orderBy: { createdAt: 'desc' },
                  select: { id: true },
                })
                .catch(() => null);
              assertions.push({
                ok: Boolean(notif?.id),
                message: notif?.id ? 'ssclinicalStaffWA: in-app notification OK' : 'ssclinicalStaffWA: missing in-app notification',
              });

              const today = now.toISOString().slice(0, 10);
              const expectedDedupeKey = `staff_whatsapp:${conv.id}:INTERESADO:${today}`;
              const outbound = staffConv?.id
                ? await prisma.outboundMessageLog
                    .findFirst({
                      where: { conversationId: staffConv.id, dedupeKey: expectedDedupeKey },
                      orderBy: { createdAt: 'desc' },
                      select: { id: true, blockedReason: true },
                    })
                    .catch(() => null)
                : null;
              const outboundOk = Boolean(outbound?.id);
              assertions.push({
                ok: outboundOk,
                message: outboundOk
                  ? `ssclinicalStaffWA: outbound log OK${outbound?.blockedReason ? ` (blocked: ${outbound.blockedReason})` : ''}`
                  : `ssclinicalStaffWA: missing outbound log (dedupeKey=${expectedDedupeKey})`,
              });

              // Cleanup: archive-only.
              await prisma.inAppNotification.updateMany({ where: { id: notif?.id || '' }, data: { archivedAt: now } as any }).catch(() => {});
              await prisma.conversation.updateMany({ where: { id: conv.id }, data: { archivedAt: now } as any }).catch(() => {});
              await prisma.contact.updateMany({ where: { id: contact?.id || '' }, data: { archivedAt: now } as any }).catch(() => {});

              if (staffConvCreated && staffConv?.id) {
                await prisma.conversation.updateMany({ where: { id: staffConv.id }, data: { archivedAt: now } as any }).catch(() => {});
              }
              if (staffContactCreated && staffContact?.id) {
                await prisma.contact.updateMany({ where: { id: staffContact.id }, data: { archivedAt: now } as any }).catch(() => {});
              }
            }

            // Restore membership staff WhatsApp if we changed it.
            if (previousStaff !== staffE164) {
              await prisma.membership.update({ where: { id: leaderMembership.id }, data: { staffWhatsAppE164: previousStaff || null } as any }).catch(() => {});
            }

            if (tempPhoneLineId) {
              await prisma.phoneLine.updateMany({ where: { id: tempPhoneLineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
            }
          }
        }
      }

      const staffInboxListCases = (step.expect as any)?.staffInboxListCases;
      if (staffInboxListCases && typeof staffInboxListCases === 'object') {
        const wsId = String((staffInboxListCases as any)?.workspaceId || 'scenario-staff-tools').trim() || 'scenario-staff-tools';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'staffInboxListCases: userId missing' });
        } else {
          const lineId = `scenario-staff-tools-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          const staffE164 = '+56982345846';
          const staffWaId = '56982345846';

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Staff Tools', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Staff Tools', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});

          const phoneLine = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Staff Tools (temp)',
                phoneE164: null,
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          if (!phoneLine?.id) {
            assertions.push({ ok: false, message: 'staffInboxListCases: no se pudo crear phoneLine' });
          } else {
            const staffContact = await prisma.contact
              .upsert({
                where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
                create: { workspaceId: wsId, waId: staffWaId, phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
                update: { phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
                select: { id: true },
              })
              .catch(() => null);
            const staffConv = staffContact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: phoneLine.id,
                      programId: null,
                      contactId: staffContact.id,
                      status: 'OPEN',
                      channel: 'whatsapp',
                      isAdmin: false,
                      aiMode: 'OFF',
                      conversationKind: 'STAFF',
                      conversationStage: 'NUEVO',
                      stageChangedAt: now,
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

            const caseAContact = await prisma.contact
              .create({
                data: { workspaceId: wsId, displayName: 'Caso A', comuna: 'Providencia', archivedAt: null } as any,
                select: { id: true },
              })
              .catch(() => null);
            const caseA = caseAContact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: phoneLine.id,
                      programId: null,
                      contactId: caseAContact.id,
                      status: 'OPEN',
                      conversationStage: 'INTERESADO',
                      stageChangedAt: now,
                      assignedToId: userId,
                      channel: 'system',
                      isAdmin: false,
                      conversationKind: 'CLIENT',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;
            const caseBContact = await prisma.contact
              .create({
                data: { workspaceId: wsId, displayName: 'Caso B', comuna: 'Ñuñoa', archivedAt: null } as any,
                select: { id: true },
              })
              .catch(() => null);
            const caseB = caseBContact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: phoneLine.id,
                      programId: null,
                      contactId: caseBContact.id,
                      status: 'OPEN',
                      conversationStage: 'NUEVO',
                      stageChangedAt: now,
                      assignedToId: userId,
                      channel: 'system',
                      isAdmin: false,
                      conversationKind: 'CLIENT',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

            if (!staffConv?.id || !caseA?.id || !caseB?.id) {
              assertions.push({ ok: false, message: 'staffInboxListCases: no se pudo crear staff/cases' });
            } else {
              const run = await prisma.agentRunLog.create({
                data: {
                  workspaceId: wsId,
                  conversationId: staffConv.id,
                  programId: null,
                  phoneLineId: phoneLine.id,
                  eventType: 'STAFF_TOOL_TEST',
                  status: 'RUNNING',
                  inputContextJson: JSON.stringify({ event: { type: 'STAFF_TOOL_TEST' } }),
                },
                select: { id: true },
              });

              const exec = await executeAgentResponse({
                app,
                workspaceId: wsId,
                agentRunId: run.id,
                response: {
                  agent: 'scenario',
                  version: 1,
                  commands: [
                    { command: 'RUN_TOOL', toolName: 'LIST_CASES', args: { stageSlug: 'INTERESADO', assignedToMe: true, limit: 10 } } as any,
                  ],
                } as any,
                transportMode: 'NULL',
              });

              const toolResult: any = exec.results?.find((r: any) => r?.details?.toolName === 'LIST_CASES')?.details?.result;
              const cases = Array.isArray(toolResult?.cases) ? toolResult.cases : [];
              const ok = cases.some((c: any) => String(c.id) === String(caseA.id)) && !cases.some((c: any) => String(c.id) === String(caseB.id));
              assertions.push({
                ok,
                message: ok ? 'staffInboxListCases: LIST_CASES filtra por stage y assignedToMe OK' : `staffInboxListCases: resultado inesperado (${cases.length} cases)`,
              });
            }

            // Cleanup: archive-only.
            await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          }
        }
      }

      const staffClientsNewUsesListCases = (step.expect as any)?.staffClientsNewUsesListCases;
      if (staffClientsNewUsesListCases && typeof staffClientsNewUsesListCases === 'object') {
        const wsId = String((staffClientsNewUsesListCases as any)?.workspaceId || 'scenario-staff-clients-new').trim() || 'scenario-staff-clients-new';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'staffClientsNewUsesListCases: userId missing' });
        } else {
          const lineId = `scenario-staff-clients-new-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          const staffE164 = '+56982345846';
          const staffWaId = '56982345846';

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Staff Clientes Nuevos', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Staff Clientes Nuevos', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});

          const staffProgram = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'staff-operaciones' } } as any,
              create: {
                workspaceId: wsId,
                name: 'Staff — Operaciones',
                slug: 'staff-operaciones',
                description: 'Scenario Staff Ops',
                isActive: true,
                archivedAt: null,
                agentSystemPrompt:
                  'Eres Staff Operaciones. Si el usuario dice "clientes nuevos" o "casos nuevos", SIEMPRE llama la tool LIST_CASES con stageSlug="NUEVO", assignedToMe=true, limit=10 y luego responde con una lista corta.',
              } as any,
              update: {
                isActive: true,
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          if (!staffProgram?.id) {
            assertions.push({ ok: false, message: 'staffClientsNewUsesListCases: no se pudo crear Program' });
          } else {
            await prisma.workspace
              .update({ where: { id: wsId }, data: { staffDefaultProgramId: staffProgram.id } as any })
              .catch(() => {});

            const phoneLine = await prisma.phoneLine
              .create({
                data: {
                  id: lineId,
                  workspaceId: wsId,
                  alias: 'Scenario Staff Clientes Nuevos (temp)',
                  phoneE164: null,
                  waPhoneNumberId,
                  isActive: true,
                  archivedAt: null,
                  needsAttention: false,
                } as any,
                select: { id: true },
              })
              .catch(() => null);

            const staffContact = await prisma.contact
              .upsert({
                where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
                create: { workspaceId: wsId, waId: staffWaId, phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
                update: { phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
                select: { id: true },
              })
              .catch(() => null);

            const staffConv =
              phoneLine?.id && staffContact?.id
                ? await prisma.conversation
                    .create({
                      data: {
                        workspaceId: wsId,
                        phoneLineId: phoneLine.id,
                        programId: null,
                        contactId: staffContact.id,
                        status: 'OPEN',
                        channel: 'whatsapp',
                        isAdmin: false,
                        aiMode: 'OFF',
                        conversationKind: 'STAFF',
                        conversationStage: 'NUEVO',
                        stageChangedAt: now,
                        archivedAt: null,
                      } as any,
                      select: { id: true },
                    })
                    .catch(() => null)
                : null;

            const caseAContact = await prisma.contact
              .create({
                data: { workspaceId: wsId, displayName: 'Caso A', comuna: 'Providencia', archivedAt: null } as any,
                select: { id: true },
              })
              .catch(() => null);
            const caseA =
              phoneLine?.id && caseAContact?.id
                ? await prisma.conversation
                    .create({
                      data: {
                        workspaceId: wsId,
                        phoneLineId: phoneLine.id,
                        programId: null,
                        contactId: caseAContact.id,
                        status: 'OPEN',
                        conversationStage: 'NEW_INTAKE',
                        stageChangedAt: now,
                        assignedToId: userId,
                        channel: 'system',
                        isAdmin: false,
                        conversationKind: 'CLIENT',
                        archivedAt: null,
                      } as any,
                      select: { id: true },
                    })
                    .catch(() => null)
                : null;
            const caseBContact = await prisma.contact
              .create({
                data: { workspaceId: wsId, displayName: 'Caso B', comuna: 'Ñuñoa', archivedAt: null } as any,
                select: { id: true },
              })
              .catch(() => null);
            const caseB =
              phoneLine?.id && caseBContact?.id
                ? await prisma.conversation
                    .create({
                      data: {
                        workspaceId: wsId,
                        phoneLineId: phoneLine.id,
                        programId: null,
                        contactId: caseBContact.id,
                        status: 'OPEN',
                        conversationStage: 'EN_COORDINACION',
                        stageChangedAt: now,
                        assignedToId: userId,
                        channel: 'system',
                        isAdmin: false,
                        conversationKind: 'CLIENT',
                        archivedAt: null,
                      } as any,
                      select: { id: true },
                    })
                    .catch(() => null)
                : null;

            const inbound =
              staffConv?.id
                ? await prisma.message
                    .create({
                      data: {
                        conversationId: staffConv.id,
                        direction: 'INBOUND',
                        text: 'clientes nuevos',
                        rawPayload: JSON.stringify({ simulated: true, scenario: 'staff_clients_new_uses_list_cases' }),
                        timestamp: now,
                        read: true,
                      },
                      select: { id: true },
                    })
                    .catch(() => null)
                : null;

            if (!phoneLine?.id || !staffConv?.id || !caseA?.id || !inbound?.id) {
              assertions.push({ ok: false, message: 'staffClientsNewUsesListCases: setup incompleto' });
            } else {
              const stageSlug = 'NEW_INTAKE';
              const agentRun = await prisma.agentRunLog
                .create({
                  data: {
                    workspaceId: wsId,
                    conversationId: staffConv.id,
                    programId: staffProgram.id,
                    phoneLineId: phoneLine.id,
                    eventType: 'INBOUND_MESSAGE',
                    status: 'RUNNING',
                    inputContextJson: JSON.stringify({ inboundText: 'clientes nuevos', stageSlug }),
                  } as any,
                })
                .catch(() => null);
              if (!agentRun?.id) {
                assertions.push({ ok: false, message: 'staffClientsNewUsesListCases: no se pudo crear AgentRunLog' });
              } else {
                const response = {
                  agent: 'scenario_staff_clients_new',
                  version: 1,
                  commands: [
                    { command: 'RUN_TOOL', toolName: 'LIST_CASES', args: { stageSlug, assignedToMe: true, limit: 10 } } as any,
                  ],
                } as any;
                const exec = await executeAgentResponse({
                  app,
                  workspaceId: wsId,
                  agentRunId: agentRun.id,
                  response,
                  transportMode: 'NULL',
                }).catch(() => null);

                const toolResult: any = exec?.results?.find((r: any) => r?.details?.toolName === 'LIST_CASES')?.details?.result;
                const cases = Array.isArray(toolResult?.cases) ? toolResult.cases : [];
                const ok =
                  cases.some((c: any) => String(c.id) === String(caseA.id)) &&
                  (!caseB?.id || !cases.some((c: any) => String(c.id) === String(caseB.id)));
                assertions.push({
                  ok,
                  message: ok
                    ? 'staffClientsNewUsesListCases: LIST_CASES devuelve casos NUEVOS (stage=NEW_INTAKE) asignados'
                    : `staffClientsNewUsesListCases: resultado inesperado (${cases.length} cases)`,
                });
              }
            }

            // Cleanup: archive-only.
            await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          }
        }
      }

      const staffTemplateVars = (step.expect as any)?.staffNotificationTemplateVariables;
      const staffCasesNewOk = (step.expect as any)?.staffCasesNewOk;
      const staffCaseSummaryWorks = (step.expect as any)?.staffCaseSummaryWorks;
      const staffErrorTransparent = (step.expect as any)?.staffErrorTransparent;
      const latencyTimeoutBehavior = (step.expect as any)?.latencyTimeoutBehavior;
      const interviewScheduleConflict = (step.expect as any)?.interviewScheduleConflict;
      const staffInterviewSlots20minConfirmTemplate = (step.expect as any)?.staffInterviewSlots20minConfirmTemplate;
      const staffDraftsSendEditCancel = (step.expect as any)?.staffDraftsSendEditCancel;
      const staffConfirmTemplateHasNoPorDefinir = (step.expect as any)?.staffConfirmTemplateHasNoPorDefinir;
      const suggestIncludesDraftText = (step.expect as any)?.suggestIncludesDraftText;
      const suggestUsesHistoryWithoutSystemEvents = (step.expect as any)?.suggestUsesHistoryWithoutSystemEvents;
      const inboundPlannedDrainsToExecuted = (step.expect as any)?.inboundPlannedDrainsToExecuted;
      const inboundDebounceSingleDraftForMultipleMsgs =
        (step.expect as any)?.inboundDebounceSingleDraftForMultipleMsgs || inboundPlannedDrainsToExecuted;
      const candidateOkDoesNotRestartFlow = (step.expect as any)?.candidateOkDoesNotRestartFlow;
      const uploadPublicAssetOk = (step.expect as any)?.uploadPublicAssetOk;
      const sendPdfPublicAssetOk = (step.expect as any)?.sendPdfPublicAssetOk;
      const sendPdfOutside24hReturnsBlocked = (step.expect as any)?.sendPdfOutside24hReturnsBlocked;
      const modelResolvedGpt4oMini = (step.expect as any)?.modelResolvedGpt4oMini;
      const candidateAutoReplyUntilOpReview = (step.expect as any)?.candidateAutoReplyUntilOpReview;
      const docsMissingReactivatesAiAndRequestsExactMissingDocs =
        (step.expect as any)?.docsMissingReactivatesAiAndRequestsExactMissingDocs;
      const acceptedMovesToInterviewPending = (step.expect as any)?.acceptedMovesToInterviewPending;
      const rejectedMovesToRejectedAndAiPauses = (step.expect as any)?.rejectedMovesToRejectedAndAiPauses;
      const suggestRespectsApplicationState = (step.expect as any)?.suggestRespectsApplicationState;
      const conversationPreviewHidesInternalEvents = (step.expect as any)?.conversationPreviewHidesInternalEvents;
      const toneNoSlangInAutoAndSuggest = (step.expect as any)?.toneNoSlangInAutoAndSuggest;
      const suggestRewritesSlangToProfessional = (step.expect as any)?.suggestRewritesSlangToProfessional;
      const menuTemplateCanBeSent = (step.expect as any)?.menuTemplateCanBeSent;
      const inboundUnroutedDoesNotReply = (step.expect as any)?.inboundUnroutedDoesNotReply;
      const deployDoesNotTouchDb = (step.expect as any)?.deployDoesNotTouchDb;
      const deployCreatesBackupBeforeRestart = (step.expect as any)?.deployCreatesBackupBeforeRestart;
      if (interviewScheduleConflict && typeof interviewScheduleConflict === 'object') {
        const wsId = String((interviewScheduleConflict as any)?.workspaceId || 'scenario-interview-conflict').trim() || 'scenario-interview-conflict';
        const now = new Date();
        await prisma.workspace
          .upsert({
            where: { id: wsId },
            create: { id: wsId, name: 'Scenario Interview Conflict', isSandbox: true, archivedAt: null } as any,
            update: { name: 'Scenario Interview Conflict', isSandbox: true, archivedAt: null } as any,
          })
          .catch(() => {});
        const lineId = `scenario-interview-conflict-line-${Date.now()}`;
        const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const line = await prisma.phoneLine
          .create({
            data: {
              id: lineId,
              workspaceId: wsId,
              alias: 'Scenario Interview Conflict (temp)',
              waPhoneNumberId,
              isActive: true,
              archivedAt: null,
              needsAttention: false,
            } as any,
            select: { id: true },
          })
          .catch(() => null);

        const contactA = await prisma.contact
          .create({ data: { workspaceId: wsId, displayName: 'Conflicto A', archivedAt: null } as any, select: { id: true } })
          .catch(() => null);
        const contactB = await prisma.contact
          .create({ data: { workspaceId: wsId, displayName: 'Conflicto B', archivedAt: null } as any, select: { id: true } })
          .catch(() => null);

        const convA =
          line?.id && contactA?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: line.id,
                    contactId: contactA.id,
                    status: 'OPEN',
                    channel: 'sandbox',
                    conversationKind: 'CLIENT',
                    conversationStage: 'INTERVIEW_PENDING',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;
        const convB =
          line?.id && contactB?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: line.id,
                    contactId: contactB.id,
                    status: 'OPEN',
                    channel: 'sandbox',
                    conversationKind: 'CLIENT',
                    conversationStage: 'INTERVIEW_PENDING',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

        if (!convA?.id || !convB?.id || !contactA?.id || !contactB?.id) {
          assertions.push({ ok: false, message: 'interviewScheduleConflict: setup incompleto' });
        } else {
          const cfg = await getSystemConfig();
          const scenarioLocation = `Scenario Conflict ${Date.now()}`;
          const probe = await attemptScheduleInterview({
            conversationId: convA.id,
            contactId: contactA.id,
            day: null,
            time: null,
            location: scenarioLocation,
            config: cfg,
          }).catch(() => ({ ok: false, alternatives: [] } as any));
          const firstAlt =
            !(probe as any)?.ok && Array.isArray((probe as any)?.alternatives) ? (probe as any).alternatives[0] : null;
          const day = typeof firstAlt?.day === 'string' ? String(firstAlt.day) : 'martes';
          const time = typeof firstAlt?.time === 'string' ? String(firstAlt.time) : '10:00';
          const first = await attemptScheduleInterview({
            conversationId: convA.id,
            contactId: contactA.id,
            day,
            time,
            location: scenarioLocation,
            config: cfg,
          }).catch(() => ({ ok: false } as any));
          const second = await attemptScheduleInterview({
            conversationId: convB.id,
            contactId: contactB.id,
            day,
            time,
            location: scenarioLocation,
            config: cfg,
          }).catch(() => ({ ok: false } as any));
          assertions.push({
            ok: Boolean((first as any)?.ok),
            message: (first as any)?.ok ? 'interviewScheduleConflict: primera reserva OK' : 'interviewScheduleConflict: primera reserva falló',
          });
          const conflict = !(second as any)?.ok && Array.isArray((second as any)?.alternatives) && (second as any).alternatives.length > 0;
          assertions.push({
            ok: conflict,
            message: conflict
              ? 'interviewScheduleConflict: segundo intento detecta conflicto y propone alternativas'
              : 'interviewScheduleConflict: faltó conflicto/alternativas',
          });
        }

        await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.phoneLine.updateMany({ where: { workspaceId: wsId, id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
      }

      if (staffInterviewSlots20minConfirmTemplate && typeof staffInterviewSlots20minConfirmTemplate === 'object') {
        const wsId =
          String((staffInterviewSlots20minConfirmTemplate as any)?.workspaceId || 'scenario-staff-interview-20min').trim() ||
          'scenario-staff-interview-20min';
        const now = new Date();
        await prisma.workspace
          .upsert({
            where: { id: wsId },
            create: { id: wsId, name: 'Scenario Staff Interview 20min', isSandbox: true, archivedAt: null } as any,
            update: { name: 'Scenario Staff Interview 20min', isSandbox: true, archivedAt: null } as any,
          })
          .catch(() => {});
        const lineId = `scenario-staff-interview-line-${Date.now()}`;
        const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const line = await prisma.phoneLine
          .create({
            data: {
              id: lineId,
              workspaceId: wsId,
              alias: 'Scenario Staff Interview (temp)',
              waPhoneNumberId,
              isActive: true,
              archivedAt: null,
              needsAttention: false,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const contactA = await prisma.contact
          .create({
            data: {
              workspaceId: wsId,
              displayName: 'Staff Agenda A',
              archivedAt: null,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const contactB = await prisma.contact
          .create({
            data: {
              workspaceId: wsId,
              displayName: 'Staff Agenda B',
              archivedAt: null,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const convA =
          line?.id && contactA?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: line.id,
                    contactId: contactA.id,
                    status: 'OPEN',
                    channel: 'sandbox',
                    conversationKind: 'CLIENT',
                    conversationStage: 'INTERVIEW_PENDING',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;
        const convB =
          line?.id && contactB?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: line.id,
                    contactId: contactB.id,
                    status: 'OPEN',
                    channel: 'sandbox',
                    conversationKind: 'CLIENT',
                    conversationStage: 'INTERVIEW_PENDING',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

        if (!convA?.id || !convB?.id || !contactA?.id || !contactB?.id) {
          assertions.push({ ok: false, message: 'staffInterviewSlots20minConfirmTemplate: setup incompleto' });
        } else {
          const cfg = await getSystemConfig();
          const scheduleCfg: any = {
            ...cfg,
            interviewTimezone: String((cfg as any)?.interviewTimezone || 'America/Santiago'),
            interviewSlotMinutes: 20,
            defaultInterviewLocation: 'Providencia',
            interviewWeeklyAvailability: JSON.stringify({
              lunes: [{ start: '10:00', end: '13:00' }],
              martes: [{ start: '10:00', end: '13:00' }],
              miércoles: [{ start: '10:00', end: '13:00' }],
              jueves: [{ start: '10:00', end: '13:00' }],
              viernes: [{ start: '10:00', end: '13:00' }],
              sábado: [{ start: '10:00', end: '13:00' }],
              domingo: [{ start: '10:00', end: '13:00' }],
            }),
          };
          const probe = await attemptScheduleInterview({
            conversationId: convA.id,
            contactId: contactA.id,
            day: null,
            time: null,
            location: 'Providencia',
            config: scheduleCfg,
          }).catch(() => ({ ok: false, alternatives: [] } as any));
          const firstAlt =
            !(probe as any)?.ok && Array.isArray((probe as any)?.alternatives) ? (probe as any).alternatives[0] : null;
          const day = typeof firstAlt?.day === 'string' ? String(firstAlt.day) : 'martes';
          const time = typeof firstAlt?.time === 'string' ? String(firstAlt.time) : '10:00';
          const minuteAligned = Number(time.split(':')[1] || '0') % 20 === 0;
          assertions.push({
            ok: minuteAligned,
            message: minuteAligned
              ? `staffInterviewSlots20minConfirmTemplate: slot ${time} alineado a 20 min`
              : `staffInterviewSlots20minConfirmTemplate: slot ${time} NO alineado a 20 min`,
          });
          const first = await attemptScheduleInterview({
            conversationId: convA.id,
            contactId: contactA.id,
            day,
            time,
            location: 'Providencia',
            config: scheduleCfg,
          }).catch(() => ({ ok: false } as any));
          const second = await attemptScheduleInterview({
            conversationId: convB.id,
            contactId: contactB.id,
            day,
            time,
            location: 'Providencia',
            config: scheduleCfg,
          }).catch(() => ({ ok: false } as any));
          assertions.push({
            ok: Boolean((first as any)?.ok),
            message: (first as any)?.ok
              ? 'staffInterviewSlots20minConfirmTemplate: primera reserva OK'
              : 'staffInterviewSlots20minConfirmTemplate: primera reserva falló',
          });
          const conflict = !(second as any)?.ok && Array.isArray((second as any)?.alternatives) && (second as any).alternatives.length > 0;
          assertions.push({
            ok: conflict,
            message: conflict
              ? 'staffInterviewSlots20minConfirmTemplate: evita doble booking y propone alternativas'
              : 'staffInterviewSlots20minConfirmTemplate: faltó detectar conflicto/alternativas',
          });
        }

        await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.phoneLine.updateMany({ where: { workspaceId: wsId, id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
      }

      if (staffDraftsSendEditCancel && typeof staffDraftsSendEditCancel === 'object') {
        const wsId = String((staffDraftsSendEditCancel as any)?.workspaceId || 'scenario-staff-drafts').trim() || 'scenario-staff-drafts';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'staffDraftsSendEditCancel: userId missing' });
        } else {
          const lineId = `scenario-staff-drafts-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          const staffWaId = '56982345846';
          const staffE164 = '+56982345846';
          const candidateWaId = `5699${String(Math.floor(Math.random() * 9000000) + 1000000)}`;
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Staff Drafts', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Staff Drafts', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});
          const line = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Staff Drafts (temp)',
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const staffContact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
              create: { workspaceId: wsId, waId: staffWaId, phone: staffE164, displayName: 'Staff Drafts', archivedAt: null } as any,
              update: { phone: staffE164, displayName: 'Staff Drafts', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const candidateContact = await prisma.contact
            .create({
              data: { workspaceId: wsId, waId: candidateWaId, phone: `+${candidateWaId}`, displayName: 'Candidato Draft', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const staffConv =
            line?.id && staffContact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      contactId: staffContact.id,
                      status: 'OPEN',
                      channel: 'whatsapp',
                      isAdmin: false,
                      conversationKind: 'STAFF',
                      conversationStage: 'NUEVO',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;
          const candidateConv =
            line?.id && candidateContact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      contactId: candidateContact.id,
                      status: 'OPEN',
                      channel: 'whatsapp',
                      isAdmin: false,
                      conversationKind: 'CLIENT',
                      conversationStage: 'NEW_INTAKE',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;
          if (!staffConv?.id || !candidateConv?.id) {
            assertions.push({ ok: false, message: 'staffDraftsSendEditCancel: setup incompleto' });
          } else {
            const draftA = await prisma.hybridReplyDraft
              .create({
                data: {
                  workspaceId: wsId,
                  conversationId: candidateConv.id,
                  targetWaId: candidateWaId,
                  proposedText: 'Hola, ¿sigues disponible para entrevista esta semana?',
                  status: 'PENDING',
                } as any,
              })
              .catch(() => null);
            if (!draftA?.id) {
              assertions.push({ ok: false, message: 'staffDraftsSendEditCancel: no se pudo crear borrador A' });
            } else {
              const inboundEdit = await prisma.message
                .create({
                  data: {
                    conversationId: staffConv.id,
                    direction: 'INBOUND',
                    text: 'EDITAR: Hola, ¿sigues disponible para entrevista mañana?',
                    timestamp: new Date(),
                    read: true,
                  },
                  select: { id: true },
                })
                .catch(() => null);
              if (inboundEdit?.id) {
                await runAutomations({
                  app,
                  workspaceId: wsId,
                  eventType: 'INBOUND_MESSAGE',
                  conversationId: staffConv.id,
                  inboundMessageId: inboundEdit.id,
                  inboundText: 'EDITAR: Hola, ¿sigues disponible para entrevista mañana?',
                  transportMode: 'NULL',
                }).catch(() => {});
              }
              const afterEdit = await prisma.hybridReplyDraft.findUnique({ where: { id: draftA.id } }).catch(() => null as any);
              assertions.push({
                ok: String(afterEdit?.finalText || '').toLowerCase().includes('mañana'),
                message:
                  String(afterEdit?.finalText || '').toLowerCase().includes('mañana')
                    ? 'staffDraftsSendEditCancel: EDITAR sin id aplica al último borrador'
                    : 'staffDraftsSendEditCancel: EDITAR sin id no actualizó borrador',
              });

              const inboundSend = await prisma.message
                .create({
                  data: {
                    conversationId: staffConv.id,
                    direction: 'INBOUND',
                    text: 'ENVIAR',
                    timestamp: new Date(Date.now() + 500),
                    read: true,
                  },
                  select: { id: true },
                })
                .catch(() => null);
              if (inboundSend?.id) {
                await runAutomations({
                  app,
                  workspaceId: wsId,
                  eventType: 'INBOUND_MESSAGE',
                  conversationId: staffConv.id,
                  inboundMessageId: inboundSend.id,
                  inboundText: 'ENVIAR',
                  transportMode: 'NULL',
                }).catch(() => {});
              }
              const afterSend = await prisma.hybridReplyDraft.findUnique({ where: { id: draftA.id } }).catch(() => null as any);
              assertions.push({
                ok: String(afterSend?.status || '').toUpperCase() === 'SENT',
                message:
                  String(afterSend?.status || '').toUpperCase() === 'SENT'
                    ? 'staffDraftsSendEditCancel: ENVIAR sin id envía borrador pendiente'
                    : `staffDraftsSendEditCancel: ENVIAR sin id falló (status=${String(afterSend?.status || '—')})`,
              });
              const outbound = await prisma.outboundMessageLog
                .findFirst({
                  where: {
                    workspaceId: wsId,
                    conversationId: candidateConv.id,
                    type: 'SESSION_TEXT',
                    dedupeKey: `hybrid_draft_send:${draftA.id}`,
                  } as any,
                  orderBy: { createdAt: 'desc' },
                  select: { id: true, waMessageId: true, blockedReason: true },
                })
                .catch(() => null);
              assertions.push({
                ok: Boolean(outbound?.id) && !outbound?.blockedReason,
                message:
                  Boolean(outbound?.id) && !outbound?.blockedReason
                    ? 'staffDraftsSendEditCancel: outbound log de borrador enviado OK'
                    : 'staffDraftsSendEditCancel: falta outbound log o quedó bloqueado',
              });

              const draftB = await prisma.hybridReplyDraft
                .create({
                  data: {
                    workspaceId: wsId,
                    conversationId: candidateConv.id,
                    targetWaId: candidateWaId,
                    proposedText: 'Segundo borrador para cancelar',
                    status: 'PENDING',
                  } as any,
                })
                .catch(() => null);
              if (!draftB?.id) {
                assertions.push({ ok: false, message: 'staffDraftsSendEditCancel: no se pudo crear borrador B' });
              } else {
                const inboundCancel = await prisma.message
                  .create({
                    data: {
                      conversationId: staffConv.id,
                      direction: 'INBOUND',
                      text: `CANCELAR ${String(draftB.id).slice(0, 8)}`,
                      timestamp: new Date(Date.now() + 1000),
                      read: true,
                    },
                    select: { id: true },
                  })
                  .catch(() => null);
                if (inboundCancel?.id) {
                  await runAutomations({
                    app,
                    workspaceId: wsId,
                    eventType: 'INBOUND_MESSAGE',
                    conversationId: staffConv.id,
                    inboundMessageId: inboundCancel.id,
                    inboundText: `CANCELAR ${String(draftB.id).slice(0, 8)}`,
                    transportMode: 'NULL',
                  }).catch(() => {});
                }
                const afterCancel = await prisma.hybridReplyDraft.findUnique({ where: { id: draftB.id } }).catch(() => null as any);
                assertions.push({
                  ok: String(afterCancel?.status || '').toUpperCase() === 'CANCELLED',
                  message:
                    String(afterCancel?.status || '').toUpperCase() === 'CANCELLED'
                      ? 'staffDraftsSendEditCancel: CANCELAR funciona'
                      : `staffDraftsSendEditCancel: CANCELAR falló (status=${String(afterCancel?.status || '—')})`,
                });
              }
            }
          }
          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.hybridReplyDraft.updateMany({ where: { workspaceId: wsId }, data: { status: 'CANCELLED', updatedAt: now } as any }).catch(() => {});
        }
      }

      if (staffConfirmTemplateHasNoPorDefinir && typeof staffConfirmTemplateHasNoPorDefinir === 'object') {
        const wsId =
          String((staffConfirmTemplateHasNoPorDefinir as any)?.workspaceId || 'scenario-staff-confirm-template').trim() ||
          'scenario-staff-confirm-template';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'staffConfirmTemplateHasNoPorDefinir: userId missing' });
        } else {
          const lineId = `scenario-staff-confirm-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          const staffWaId = '56982345846';
          const staffE164 = '+56982345846';
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: {
                id: wsId,
                name: 'Scenario Staff Confirm Template',
                isSandbox: true,
                archivedAt: null,
                templateRecruitmentStartName: 'enviorapido_postulacion_inicio_v1',
                templateInterviewConfirmationName: 'enviorapido_confirma_entrevista_v1',
              } as any,
              update: {
                name: 'Scenario Staff Confirm Template',
                isSandbox: true,
                archivedAt: null,
                templateRecruitmentStartName: 'enviorapido_postulacion_inicio_v1',
                templateInterviewConfirmationName: 'enviorapido_confirma_entrevista_v1',
              } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});
          const program = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'staff-confirm-template-program' } } as any,
              create: {
                workspaceId: wsId,
                name: 'Staff Confirm Template',
                slug: 'staff-confirm-template-program',
                isActive: true,
                archivedAt: null,
                agentSystemPrompt: 'Programa temporal de escenario.',
              } as any,
              update: { isActive: true, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const line = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Staff Confirm (temp)',
                waPhoneNumberId,
                isActive: true,
                defaultProgramId: program?.id || null,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const staffContact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
              create: { workspaceId: wsId, waId: staffWaId, phone: staffE164, displayName: 'Staff Confirm', archivedAt: null } as any,
              update: { phone: staffE164, displayName: 'Staff Confirm', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const candidateWa = `5699${String(Math.floor(Math.random() * 9000000) + 1000000)}`;
          const candidateContact = await prisma.contact
            .create({
              data: { workspaceId: wsId, waId: candidateWa, phone: `+${candidateWa}`, candidateNameManual: 'Juan Pérez', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const staffConv =
            line?.id && staffContact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      programId: program?.id || null,
                      contactId: staffContact.id,
                      status: 'OPEN',
                      channel: 'whatsapp',
                      conversationKind: 'STAFF',
                      conversationStage: 'NUEVO',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;
          const clientConv =
            line?.id && candidateContact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      programId: null,
                      contactId: candidateContact.id,
                      status: 'OPEN',
                      channel: 'whatsapp',
                      conversationKind: 'CLIENT',
                      conversationStage: 'INTERVIEW_PENDING',
                      interviewDay: 'martes',
                      interviewTime: '10:20',
                      interviewLocation: 'Providencia',
                      interviewStatus: 'PENDING',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;
          if (!staffConv?.id || !clientConv?.id) {
            assertions.push({ ok: false, message: 'staffConfirmTemplateHasNoPorDefinir: setup incompleto' });
          } else {
            const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);
            await prisma.interviewReservation
              .create({
                data: {
                  conversationId: clientConv.id,
                  contactId: candidateContact!.id,
                  startAt,
                  endAt,
                  timezone: 'America/Santiago',
                  location: 'Providencia',
                  status: 'PENDING',
                  activeKey: 'ACTIVE',
                } as any,
              })
              .catch(() => null);
            const inbound = await prisma.message
              .create({
                data: {
                  conversationId: staffConv.id,
                  direction: 'INBOUND',
                  text: `confirmar entrevista ${String(clientConv.id).slice(0, 8)}`,
                  timestamp: now,
                  read: true,
                },
                select: { id: true },
              })
              .catch(() => null);
            if (!inbound?.id) {
              assertions.push({ ok: false, message: 'staffConfirmTemplateHasNoPorDefinir: no se pudo crear inbound' });
            } else {
              await runAutomations({
                app,
                workspaceId: wsId,
                eventType: 'INBOUND_MESSAGE',
                conversationId: staffConv.id,
                inboundMessageId: inbound.id,
                inboundText: `confirmar entrevista ${String(clientConv.id).slice(0, 8)}`,
                transportMode: 'NULL',
              }).catch(() => {});
              const outbound = await prisma.outboundMessageLog
                .findFirst({
                  where: {
                    workspaceId: wsId,
                    conversationId: clientConv.id,
                    type: 'TEMPLATE',
                    templateName: 'enviorapido_confirma_entrevista_v1',
                  } as any,
                  orderBy: { createdAt: 'desc' },
                })
                .catch(() => null);
              const templateMsg = await prisma.message
                .findFirst({
                  where: { conversationId: clientConv.id, direction: 'OUTBOUND', text: { contains: '[TEMPLATE]' } as any },
                  orderBy: { timestamp: 'desc' },
                })
                .catch(() => null);
              const rawPayload = String(templateMsg?.rawPayload || '');
              const noPlaceholder = !/por definir/i.test(rawPayload);
              assertions.push({
                ok: Boolean(outbound?.id) && noPlaceholder,
                message:
                  Boolean(outbound?.id) && noPlaceholder
                    ? 'staffConfirmTemplateHasNoPorDefinir: template enviado sin placeholders'
                    : 'staffConfirmTemplateHasNoPorDefinir: faltó outbound template o contiene "Por definir"',
              });
            }
          }
          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          const wsConversationIds = await prisma.conversation
            .findMany({ where: { workspaceId: wsId }, select: { id: true } })
            .then((rows) => rows.map((r) => r.id))
            .catch(() => [] as string[]);
          if (wsConversationIds.length > 0) {
            await prisma.interviewReservation
              .updateMany({
                where: { conversationId: { in: wsConversationIds } },
                data: { activeKey: null, status: 'CANCELLED' } as any,
              })
              .catch(() => {});
          }
        }
      }

      if ((staffCasesNewOk && typeof staffCasesNewOk === 'object') || (staffCaseSummaryWorks && typeof staffCaseSummaryWorks === 'object')) {
        const wsId =
          String(
            ((staffCasesNewOk as any)?.workspaceId || (staffCaseSummaryWorks as any)?.workspaceId || 'scenario-staff-cases-new-ok'),
          ).trim() || 'scenario-staff-cases-new-ok';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'staffCasesNewOk: userId missing' });
        } else {
          const lineId = `scenario-staff-cases-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          const staffE164 = '+56982345846';
          const staffWaId = '56982345846';

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Staff Cases New OK', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Staff Cases New OK', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});

          const staffProgram = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'staff-operaciones-router' } } as any,
              create: {
                workspaceId: wsId,
                name: 'Staff — Operaciones Router',
                slug: 'staff-operaciones-router',
                description: 'Scenario Staff Router',
                isActive: true,
                archivedAt: null,
                agentSystemPrompt: 'Programa staff para escenarios.',
              } as any,
              update: { isActive: true, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);

          const line = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Staff Router (temp)',
                waPhoneNumberId,
                isActive: true,
                defaultProgramId: staffProgram?.id || null,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          const staffContact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
              create: { workspaceId: wsId, waId: staffWaId, phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              update: { phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);

          const staffConv =
            line?.id && staffContact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      programId: staffProgram?.id || null,
                      contactId: staffContact.id,
                      status: 'OPEN',
                      channel: 'whatsapp',
                      isAdmin: false,
                      aiMode: 'OFF',
                      conversationKind: 'STAFF',
                      conversationStage: 'NUEVO',
                      stageChangedAt: now,
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

          const mkCase = async (name: string) => {
            const c = await prisma.contact
              .create({ data: { workspaceId: wsId, displayName: name, comuna: 'Providencia', archivedAt: null } as any, select: { id: true } })
              .catch(() => null);
            if (!line?.id || !c?.id) return null;
            return prisma.conversation
              .create({
                data: {
                  workspaceId: wsId,
                  phoneLineId: line.id,
                  contactId: c.id,
                  status: 'OPEN',
                  conversationStage: 'NEW_INTAKE',
                  stageChangedAt: now,
                  assignedToId: userId,
                  channel: 'system',
                  isAdmin: false,
                  conversationKind: 'CLIENT',
                  archivedAt: null,
                } as any,
                select: { id: true },
              })
              .catch(() => null);
          };
          const caseA = await mkCase('Caso Router A');
          await mkCase('Caso Router B');

          if (!staffConv?.id || !caseA?.id) {
            assertions.push({ ok: false, message: 'staffCasesNewOk: setup incompleto' });
          } else {
            const firstCommandText = staffCaseSummaryWorks ? 'lista postulantes' : 'Cuáles son los casos nuevos?';
            const inbound = await prisma.message
              .create({
                data: {
                  conversationId: staffConv.id,
                  direction: 'INBOUND',
                  text: firstCommandText,
                  rawPayload: JSON.stringify({
                    simulated: true,
                    scenario: staffCaseSummaryWorks ? 'staff_case_summary_works' : 'staff_cases_new_ok',
                  }),
                  timestamp: now,
                  read: true,
                },
                select: { id: true },
              })
              .catch(() => null);
            if (!inbound?.id) {
              assertions.push({ ok: false, message: 'staffCasesNewOk: no se pudo crear inbound' });
            } else {
              await runAutomations({
                app,
                workspaceId: wsId,
                eventType: 'INBOUND_MESSAGE',
                conversationId: staffConv.id,
                inboundMessageId: inbound.id,
                inboundText: firstCommandText,
                transportMode: 'NULL',
              }).catch(() => {});

              const lastOutbound = await prisma.message
                .findFirst({
                  where: { conversationId: staffConv.id, direction: 'OUTBOUND' },
                  orderBy: { timestamp: 'desc' },
                  select: { text: true },
                })
                .catch(() => null);
              const outboundText = String(lastOutbound?.text || '');
              const outboundOk = /casos encontrados|caso/i.test(outboundText);
              assertions.push({
                ok: outboundOk,
                message: outboundOk ? 'staffCasesNewOk: respuesta staff generada' : `staffCasesNewOk: respuesta inesperada (${outboundText || '—'})`,
              });

              if (staffCaseSummaryWorks) {
                const inboundSummary = await prisma.message
                  .create({
                    data: {
                      conversationId: staffConv.id,
                      direction: 'INBOUND',
                      text: 'dame resumen de cada caso',
                      rawPayload: JSON.stringify({ simulated: true, scenario: 'staff_case_summary_works' }),
                      timestamp: new Date(Date.now() + 1000),
                      read: true,
                    },
                    select: { id: true },
                  })
                  .catch(() => null);
                if (!inboundSummary?.id) {
                  assertions.push({ ok: false, message: 'staffCaseSummaryWorks: no se pudo crear inbound resumen' });
                } else {
                  await runAutomations({
                    app,
                    workspaceId: wsId,
                    eventType: 'INBOUND_MESSAGE',
                    conversationId: staffConv.id,
                    inboundMessageId: inboundSummary.id,
                    inboundText: 'dame resumen de cada caso',
                    transportMode: 'NULL',
                  }).catch(() => {});

                  const summaryOutbound = await prisma.message
                    .findFirst({
                      where: { conversationId: staffConv.id, direction: 'OUTBOUND' },
                      orderBy: { timestamp: 'desc' },
                      select: { text: true },
                    })
                    .catch(() => null);
                  const summaryText = String(summaryOutbound?.text || '');
                  const summaryOk = /resumen|caso|id/i.test(summaryText) && /Caso Router/i.test(summaryText);
                  assertions.push({
                    ok: summaryOk,
                    message: summaryOk
                      ? 'staffCaseSummaryWorks: entrega resumen real de casos'
                      : `staffCaseSummaryWorks: resumen inesperado (${summaryText || '—'})`,
                  });
                }
              }

              const latestRuns = await prisma.agentRunLog
                .findMany({
                  where: { workspaceId: wsId, conversationId: staffConv.id },
                  orderBy: { createdAt: 'desc' },
                  take: 5,
                  select: { eventType: true, status: true, error: true },
                })
                .catch(() => []);
              const hasRouter = latestRuns.some((r) => String(r.eventType).startsWith('STAFF_COMMAND_ROUTER'));
              assertions.push({
                ok: hasRouter,
                message: hasRouter ? 'staffCasesNewOk: ejecutó STAFF_COMMAND_ROUTER' : 'staffCasesNewOk: no ejecutó STAFF_COMMAND_ROUTER',
              });

              const toolCalls = await prisma.toolCallLog
                .findMany({
                  where: {
                    agentRun: {
                      workspaceId: wsId,
                      conversationId: staffConv.id,
                    } as any,
                  } as any,
                  select: { toolName: true },
                  take: 20,
                })
                .catch(() => []);
              const badTools = toolCalls
                .map((t) => String(t.toolName || '').toLowerCase())
                .filter((name) => name === 'validate_rut' || name === 'get_available_programs');
              assertions.push({
                ok: badTools.length === 0,
                message:
                  badTools.length === 0
                    ? 'staffCasesNewOk: no se usaron validate_rut/get_available_programs'
                    : `staffCasesNewOk: tools inesperadas detectadas (${badTools.join(', ')})`,
              });

              if (staffCaseSummaryWorks) {
                const routerRuns = await prisma.agentRunLog
                  .findMany({
                    where: {
                      workspaceId: wsId,
                      conversationId: staffConv.id,
                      eventType: 'STAFF_COMMAND_ROUTER',
                    } as any,
                    select: { commandsJson: true },
                    take: 10,
                    orderBy: { createdAt: 'desc' },
                  })
                  .catch(() => []);
                const usedListCases = routerRuns.some((r) => /LIST_CASES/i.test(String(r.commandsJson || '')));
                assertions.push({
                  ok: usedListCases,
                  message: usedListCases
                    ? 'staffCaseSummaryWorks: ejecutó LIST_CASES'
                    : 'staffCaseSummaryWorks: faltó LIST_CASES',
                });
              }
            }
          }

          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
        }
      }

      if (staffErrorTransparent && typeof staffErrorTransparent === 'object') {
        const wsId = String((staffErrorTransparent as any)?.workspaceId || 'scenario-staff-error-transparent').trim() || 'scenario-staff-error-transparent';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'staffErrorTransparent: userId missing' });
        } else {
          const lineId = `scenario-staff-error-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          const staffE164 = '+56982345846';
          const staffWaId = '56982345846';

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Staff Error Transparent', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Staff Error Transparent', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});

          const staffProgram = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'staff-error-transparent-program' } } as any,
              create: {
                workspaceId: wsId,
                name: 'Staff Error Transparent',
                slug: 'staff-error-transparent-program',
                isActive: true,
                archivedAt: null,
                agentSystemPrompt: 'Programa de prueba para staff.',
              } as any,
              update: { isActive: true, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);

          const line = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Staff Error (temp)',
                waPhoneNumberId,
                isActive: true,
                defaultProgramId: staffProgram?.id || null,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          const staffContact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
              create: { workspaceId: wsId, waId: staffWaId, phone: staffE164, displayName: 'Scenario Staff Error', archivedAt: null } as any,
              update: { phone: staffE164, displayName: 'Scenario Staff Error', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);

          const staffConv =
            line?.id && staffContact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      programId: staffProgram?.id || null,
                      contactId: staffContact.id,
                      status: 'OPEN',
                      channel: 'whatsapp',
                      isAdmin: false,
                      aiMode: 'OFF',
                      conversationKind: 'STAFF',
                      conversationStage: 'NUEVO',
                      stageChangedAt: now,
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

          if (!staffConv?.id) {
            assertions.push({ ok: false, message: 'staffErrorTransparent: setup incompleto' });
          } else {
            const inbound = await prisma.message
              .create({
                data: {
                  conversationId: staffConv.id,
                  direction: 'INBOUND',
                  text: 'resumen caso-inexistente',
                  rawPayload: JSON.stringify({ simulated: true, scenario: 'staff_error_transparent' }),
                  timestamp: now,
                  read: true,
                },
                select: { id: true },
              })
              .catch(() => null);

            if (!inbound?.id) {
              assertions.push({ ok: false, message: 'staffErrorTransparent: no se pudo crear inbound' });
            } else {
              await runAutomations({
                app,
                workspaceId: wsId,
                eventType: 'INBOUND_MESSAGE',
                conversationId: staffConv.id,
                inboundMessageId: inbound.id,
                inboundText: 'resumen caso-inexistente',
                transportMode: 'NULL',
              }).catch(() => {});

              const out = await prisma.message
                .findFirst({
                  where: { conversationId: staffConv.id, direction: 'OUTBOUND' },
                  orderBy: { timestamp: 'desc' },
                  select: { text: true },
                })
                .catch(() => null);
              const text = String(out?.text || '');
              const okTransparent = /no pude consultar|problema tecnic/i.test(text);
              const noFakeProgress = !/estoy obteniendo|un momento/i.test(text);
              assertions.push({
                ok: okTransparent && noFakeProgress,
                message:
                  okTransparent && noFakeProgress
                    ? 'staffErrorTransparent: mensaje honesto y accionable'
                    : `staffErrorTransparent: respuesta no transparente (${text || '—'})`,
              });
            }
          }

          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { workspaceId: wsId, id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      if (latencyTimeoutBehavior && typeof latencyTimeoutBehavior === 'object') {
        const wsId =
          String((latencyTimeoutBehavior as any)?.workspaceId || 'scenario-latency-timeout-behavior').trim() ||
          'scenario-latency-timeout-behavior';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'latencyTimeoutBehavior: userId missing' });
        } else {
          const lineId = `scenario-timeout-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Latency Timeout Behavior', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Latency Timeout Behavior', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const line = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Timeout (temp)',
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const contact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: '56994830202' } } as any,
              create: {
                workspaceId: wsId,
                displayName: 'Scenario Timeout Client',
                waId: '56994830202',
                archivedAt: null,
              } as any,
              update: {
                displayName: 'Scenario Timeout Client',
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const convo =
            line?.id && contact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      contactId: contact.id,
                      status: 'OPEN',
                      channel: 'sandbox',
                      isAdmin: false,
                      conversationKind: 'CLIENT',
                      conversationStage: 'NEW_INTAKE',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

          if (!convo?.id) {
            assertions.push({ ok: false, message: 'latencyTimeoutBehavior: setup incompleto' });
          } else {
            const repeatedText = 'Mensaje repetido para forzar anti-loop';
            const repeatedHash = stableHash(`TEXT:${repeatedText}`);
            await prisma.message
              .create({
                data: {
                  conversationId: convo.id,
                  direction: 'OUTBOUND',
                  text: repeatedText,
                  rawPayload: JSON.stringify({ simulated: true, scenario: 'latency_timeout_behavior' }),
                  timestamp: new Date(Date.now() - 10_000),
                  read: true,
                },
              })
              .catch(() => null);
            await prisma.outboundMessageLog
              .create({
                data: {
                  workspaceId: wsId,
                  conversationId: convo.id,
                  channel: 'WHATSAPP',
                  type: 'SESSION_TEXT',
                  dedupeKey: `scenario-timeout-base:${Date.now()}`,
                  textHash: repeatedHash,
                  blockedReason: null,
                } as any,
              })
              .catch(() => null);

            const run = await prisma.agentRunLog
              .create({
                data: {
                  workspaceId: wsId,
                  conversationId: convo.id,
                  phoneLineId: line?.id || null,
                  eventType: 'INBOUND_MESSAGE',
                  status: 'RUNNING',
                  inputContextJson: JSON.stringify({ event: { inboundText: 'hola' } }),
                } as any,
                select: { id: true },
              })
              .catch(() => null);
            if (!run?.id) {
              assertions.push({ ok: false, message: 'latencyTimeoutBehavior: no se pudo crear run' });
            } else {
              await executeAgentResponse({
                app,
                workspaceId: wsId,
                agentRunId: run.id,
                response: {
                  agent: 'scenario_timeout',
                  version: 1,
                  commands: [
                    {
                      command: 'SEND_MESSAGE',
                      conversationId: convo.id,
                      channel: 'WHATSAPP',
                      type: 'SESSION_TEXT',
                      text: repeatedText,
                      dedupeKey: `scenario-timeout-send:${Date.now()}`,
                    } as any,
                  ],
                } as any,
                transportMode: 'NULL',
              }).catch(() => null);

              const blocked = await prisma.outboundMessageLog
                .findFirst({
                  where: { conversationId: convo.id, blockedReason: { not: null } as any },
                  orderBy: { createdAt: 'desc' },
                  select: { blockedReason: true },
                })
                .catch(() => null);
              const technicalMsg = await prisma.message
                .findFirst({
                  where: { conversationId: convo.id, direction: 'OUTBOUND', text: { contains: 'problema técnico' } as any },
                  orderBy: { timestamp: 'desc' },
                  select: { text: true },
                })
                .catch(() => null);
              assertions.push({
                ok: String(blocked?.blockedReason || '').includes('ANTI_LOOP_SAME_TEXT'),
                message: String(blocked?.blockedReason || '').includes('ANTI_LOOP_SAME_TEXT')
                  ? 'latencyTimeoutBehavior: bloqueo técnico detectado'
                  : `latencyTimeoutBehavior: bloqueo esperado no detectado (${String(blocked?.blockedReason || '—')})`,
              });
              assertions.push({
                ok: Boolean(technicalMsg?.text),
                message: technicalMsg?.text
                  ? 'latencyTimeoutBehavior: mensaje técnico transparente emitido'
                  : 'latencyTimeoutBehavior: faltó mensaje técnico transparente',
              });
            }
          }

          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { workspaceId: wsId, id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      if (suggestIncludesDraftText && typeof suggestIncludesDraftText === 'object') {
        const wsId =
          String((suggestIncludesDraftText as any)?.workspaceId || 'scenario-er-p1-suggest-draft').trim() ||
          'scenario-er-p1-suggest-draft';
        const now = new Date();
        const lineId = `scenario-er-p1-suggest-line-${Date.now()}`;
        const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        // Use an allowlisted QA number so SAFE_MODE ALLOWLIST_ONLY does not block this scenario.
        const candidateWaId = '56994830202';
        const draftText = 'Hola, me interesa postular como conductor. ¿Cómo seguimos?';

        await prisma.workspace
          .upsert({
            where: { id: wsId },
            create: { id: wsId, name: 'Scenario ER-P1 Suggest Draft', isSandbox: true, archivedAt: null } as any,
            update: { name: 'Scenario ER-P1 Suggest Draft', isSandbox: true, archivedAt: null } as any,
          })
          .catch(() => {});
        const line = await prisma.phoneLine
          .create({
            data: {
              id: lineId,
              workspaceId: wsId,
              alias: 'Scenario Suggest Draft Line',
              waPhoneNumberId,
              isActive: true,
              archivedAt: null,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const program = await prisma.program
          .create({
            data: {
              workspaceId: wsId,
              name: 'Scenario Suggest Program',
              slug: `scenario-suggest-program-${Date.now()}`,
              isActive: true,
              agentSystemPrompt: 'Responde como reclutador humano, breve y claro.',
            } as any,
            select: { id: true, slug: true },
          })
          .catch(() => null);
        const contact = await prisma.contact
          .create({
            data: {
              workspaceId: wsId,
              displayName: 'Scenario Suggest Contact',
              waId: candidateWaId,
              archivedAt: null,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const conv =
          line?.id && contact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: line.id,
                    programId: program?.id || null,
                    contactId: contact.id,
                    status: 'OPEN',
                    channel: 'sandbox',
                    conversationKind: 'CLIENT',
                    conversationStage: 'NEW_INTAKE',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

        if (!conv?.id) {
          assertions.push({ ok: false, message: 'suggestIncludesDraftText: setup incompleto' });
        } else {
          await prisma.message
            .create({
              data: {
                conversationId: conv.id,
                direction: 'INBOUND',
                text: 'Hola, soy de Pudahuel y tengo licencia B.',
                timestamp: new Date(Date.now() - 30_000),
                read: false,
                rawPayload: JSON.stringify({ simulated: true }),
              },
            })
            .catch(() => {});

          const run = await runAgent({
            workspaceId: wsId,
            conversationId: conv.id,
            eventType: 'AI_SUGGEST',
            inboundMessageId: null,
            draftText,
          }).catch(() => null);

          if (!run?.runId) {
            assertions.push({ ok: false, message: 'suggestIncludesDraftText: runAgent falló' });
          } else {
            const runLog = await prisma.agentRunLog
              .findUnique({
                where: { id: run.runId },
                select: { inputContextJson: true, commandsJson: true, status: true },
              })
              .catch(() => null);
            const usage = await prisma.aiUsageLog
              .findFirst({
                where: { agentRunId: run.runId },
                orderBy: { createdAt: 'desc' },
                select: { modelResolved: true },
              })
              .catch(() => null);

            const inputCtx = safeJsonParse(runLog?.inputContextJson || null);
            const commands = safeJsonParse(runLog?.commandsJson || null);
            const send = Array.isArray(commands?.commands)
              ? commands.commands.find((c: any) => String(c?.command || '') === 'SEND_MESSAGE')
              : null;
            const suggestedText = String(send?.text || '').trim();
            const usesDraft = String((inputCtx as any)?.event?.draftText || '').trim() === draftText;
            assertions.push({
              ok: usesDraft,
              message: usesDraft
                ? 'suggestIncludesDraftText: buildLLMContext recibió draftText'
                : 'suggestIncludesDraftText: faltó draftText en contexto',
            });
            assertions.push({
              ok: suggestedText.length > 0 && normalizeForContains(suggestedText) !== normalizeForContains(draftText),
              message:
                suggestedText.length > 0 && normalizeForContains(suggestedText) !== normalizeForContains(draftText)
                  ? 'suggestIncludesDraftText: suggestedText generado y mejorado'
                  : 'suggestIncludesDraftText: suggestedText vacío o igual al borrador',
            });
            const modelOk = String(usage?.modelResolved || '').toLowerCase().includes('gpt-4o-mini');
            assertions.push({
              ok: modelOk,
              message: modelOk
                ? `suggestIncludesDraftText: modelResolved OK (${String(usage?.modelResolved)})`
                : `suggestIncludesDraftText: modelResolved inesperado (${String(usage?.modelResolved || '—')})`,
            });
          }
        }

        await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.phoneLine.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
        await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
      }

      if (suggestUsesHistoryWithoutSystemEvents && typeof suggestUsesHistoryWithoutSystemEvents === 'object') {
        const wsId =
          String((suggestUsesHistoryWithoutSystemEvents as any)?.workspaceId || 'scenario-er-p1-context-filter').trim() ||
          'scenario-er-p1-context-filter';
        const now = new Date();
        const lineId = `scenario-er-p1-context-line-${Date.now()}`;
        const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const candidateWaId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

        await prisma.workspace
          .upsert({
            where: { id: wsId },
            create: { id: wsId, name: 'Scenario ER-P1 Context Filter', isSandbox: true, archivedAt: null } as any,
            update: { name: 'Scenario ER-P1 Context Filter', isSandbox: true, archivedAt: null } as any,
          })
          .catch(() => {});
        const line = await prisma.phoneLine
          .create({
            data: {
              id: lineId,
              workspaceId: wsId,
              alias: 'Scenario Context Filter Line',
              waPhoneNumberId,
              isActive: true,
              archivedAt: null,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const program = await prisma.program
          .create({
            data: {
              workspaceId: wsId,
              name: 'Scenario Context Program',
              slug: `scenario-context-program-${Date.now()}`,
              isActive: true,
              agentSystemPrompt: 'Responde breve y contextual.',
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const contact = await prisma.contact
          .create({
            data: {
              workspaceId: wsId,
              displayName: 'Scenario Context Contact',
              waId: candidateWaId,
              archivedAt: null,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const conv =
          line?.id && contact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: line.id,
                    programId: program?.id || null,
                    contactId: contact.id,
                    status: 'OPEN',
                    channel: 'sandbox',
                    conversationKind: 'CLIENT',
                    conversationStage: 'SCREENING',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;
        if (!conv?.id) {
          assertions.push({ ok: false, message: 'suggestUsesHistoryWithoutSystemEvents: setup incompleto' });
        } else {
          await prisma.message
            .createMany({
              data: [
                {
                  conversationId: conv.id,
                  direction: 'INBOUND',
                  text: 'Hola, soy Nicolás y tengo licencia.',
                  timestamp: new Date(Date.now() - 20_000),
                  read: false,
                  rawPayload: JSON.stringify({ simulated: true }),
                },
                {
                  conversationId: conv.id,
                  direction: 'OUTBOUND',
                  text: 'Perfecto Nicolás, ¿desde qué comuna nos escribes?',
                  timestamp: new Date(Date.now() - 15_000),
                  read: true,
                  rawPayload: JSON.stringify({ simulated: true, sendResult: { success: true } }),
                },
                {
                  conversationId: conv.id,
                  direction: 'OUTBOUND',
                  text: '📝 Respuesta propuesta enviada a revisión',
                  timestamp: new Date(Date.now() - 10_000),
                  read: true,
                  rawPayload: JSON.stringify({ internalEvent: true }),
                  isInternalEvent: true as any,
                } as any,
              ],
            })
            .catch(() => {});

          const run = await runAgent({
            workspaceId: wsId,
            conversationId: conv.id,
            eventType: 'AI_SUGGEST',
            inboundMessageId: null,
            draftText: '',
          }).catch(() => null);
          if (!run?.runId) {
            assertions.push({ ok: false, message: 'suggestUsesHistoryWithoutSystemEvents: runAgent falló' });
          } else {
            const runLog = await prisma.agentRunLog
              .findUnique({
                where: { id: run.runId },
                select: { inputContextJson: true },
              })
              .catch(() => null);
            const inputCtx = safeJsonParse(runLog?.inputContextJson || null);
            const lastMessages = Array.isArray((inputCtx as any)?.lastMessages) ? (inputCtx as any).lastMessages : [];
            const texts = lastMessages.map((m: any) => normalizeForContains(String(m?.text || '')));
            const hasInternalMarker = texts.some((t: string) => t.includes('respuesta propuesta enviada a revision') || t.includes('stage actualizado'));
            const hasRealInbound = texts.some((t: string) => t.includes('soy nicolas') || t.includes('tengo licencia'));
            assertions.push({
              ok: !hasInternalMarker,
              message: !hasInternalMarker
                ? 'suggestUsesHistoryWithoutSystemEvents: eventos internos filtrados'
                : 'suggestUsesHistoryWithoutSystemEvents: contexto contaminado con eventos internos',
            });
            assertions.push({
              ok: hasRealInbound,
              message: hasRealInbound
                ? 'suggestUsesHistoryWithoutSystemEvents: historial conversacional real presente'
                : 'suggestUsesHistoryWithoutSystemEvents: historial conversacional incompleto',
            });
          }
        }

        await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.phoneLine.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
        await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
      }

      if (
        (inboundDebounceSingleDraftForMultipleMsgs && typeof inboundDebounceSingleDraftForMultipleMsgs === 'object') ||
        (candidateOkDoesNotRestartFlow && typeof candidateOkDoesNotRestartFlow === 'object')
      ) {
        const wsId = String(
          (inboundDebounceSingleDraftForMultipleMsgs as any)?.workspaceId ||
            (candidateOkDoesNotRestartFlow as any)?.workspaceId ||
            'scenario-er-p1-inbound',
        ).trim() || 'scenario-er-p1-inbound';
        const now = new Date();
        const lineId = `scenario-er-p1-inbound-line-${Date.now()}`;
        const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const candidateWaId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

        await prisma.workspace
          .upsert({
            where: { id: wsId },
            create: { id: wsId, name: 'Scenario ER-P1 Inbound', isSandbox: true, archivedAt: null } as any,
            update: { name: 'Scenario ER-P1 Inbound', isSandbox: true, archivedAt: null } as any,
          })
          .catch(() => {});
        const line = await prisma.phoneLine
          .create({
            data: {
              id: lineId,
              workspaceId: wsId,
              alias: 'Scenario Inbound Debounce Line',
              waPhoneNumberId,
              isActive: true,
              archivedAt: null,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const program = await prisma.program
          .create({
            data: {
              workspaceId: wsId,
              name: 'Scenario Inbound Program',
              slug: `scenario-inbound-program-${Date.now()}`,
              isActive: true,
              agentSystemPrompt:
                'Responde corto y humano. Si el usuario dice ok/gracias, no reinicies flujo ni menú.',
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        await prisma.automationRule
          .create({
            data: {
              workspaceId: wsId,
              name: 'Scenario inbound debounce',
              trigger: 'INBOUND_MESSAGE',
              enabled: true,
              priority: 100,
              conditionsJson: JSON.stringify([]),
              actionsJson: JSON.stringify([{ type: 'RUN_AGENT', agent: 'program_default' }]),
            } as any,
          })
          .catch(() => {});

        const contact = await prisma.contact
          .create({
            data: {
              workspaceId: wsId,
              displayName: 'Scenario Inbound Contact',
              waId: candidateWaId,
              candidateName: 'Nicolás Pérez',
              archivedAt: null,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const conv =
          line?.id && contact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: line.id,
                    programId: program?.id || null,
                    contactId: contact.id,
                    status: 'OPEN',
                    channel: 'sandbox',
                    conversationKind: 'CLIENT',
                    conversationStage: 'SCREENING',
                    applicationRole: 'CONDUCTOR' as any,
                    applicationState: 'STATE_2_WAITING_CV' as any,
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

        if (!conv?.id) {
          assertions.push({ ok: false, message: 'inboundDebounce/candidateOk: setup incompleto' });
        } else {
          if (inboundDebounceSingleDraftForMultipleMsgs && typeof inboundDebounceSingleDraftForMultipleMsgs === 'object') {
            const startedAt = new Date();
            const burstTexts = ['Hola', 'Quiero postular', 'Tengo estacionamiento'];
            for (const text of burstTexts) {
              const inbound = await prisma.message
                .create({
                  data: {
                    conversationId: conv.id,
                    direction: 'INBOUND',
                    text,
                    timestamp: new Date(),
                    read: false,
                    rawPayload: JSON.stringify({ simulated: true, burst: true }),
                  },
                  select: { id: true, text: true },
                })
                .catch(() => null);
              if (!inbound?.id) continue;
              await runAutomations({
                app,
                workspaceId: wsId,
                eventType: 'INBOUND_MESSAGE',
                conversationId: conv.id,
                inboundMessageId: inbound.id,
                inboundText: inbound.text || text,
                transportMode: 'REAL',
              }).catch(() => {});
            }

            await new Promise((resolve) => setTimeout(resolve, 12_500));
            const runCount = await prisma.agentRunLog
              .count({
                where: {
                  workspaceId: wsId,
                  conversationId: conv.id,
                  eventType: 'INBOUND_MESSAGE',
                  createdAt: { gte: startedAt },
                },
              })
              .catch(() => 0);
            assertions.push({
              ok: runCount === 1,
              message:
                runCount === 1
                  ? 'inboundDebounceSingleDraftForMultipleMsgs: 1 run por ráfaga OK'
                  : `inboundDebounceSingleDraftForMultipleMsgs: esperado 1 run, got ${runCount}`,
            });
          }

          if (candidateOkDoesNotRestartFlow && typeof candidateOkDoesNotRestartFlow === 'object') {
            const inbound = await prisma.message
              .create({
                data: {
                  conversationId: conv.id,
                  direction: 'INBOUND',
                  text: 'ok gracias',
                  timestamp: new Date(),
                  read: false,
                  rawPayload: JSON.stringify({ simulated: true }),
                },
                select: { id: true },
              })
              .catch(() => null);
            if (!inbound?.id) {
              assertions.push({ ok: false, message: 'candidateOkDoesNotRestartFlow: no se pudo crear inbound' });
            } else {
              const run = await runAgent({
                workspaceId: wsId,
                conversationId: conv.id,
                eventType: 'INBOUND_MESSAGE',
                inboundMessageId: inbound.id,
              }).catch(() => null);
              if (!run?.runId) {
                assertions.push({ ok: false, message: 'candidateOkDoesNotRestartFlow: runAgent falló' });
              } else {
                await executeAgentResponse({
                  app,
                  workspaceId: wsId,
                  agentRunId: run.runId,
                  response: run.response as any,
                  transportMode: 'NULL',
                }).catch(() => {});
                const after = await prisma.conversation
                  .findUnique({
                    where: { id: conv.id },
                    select: { applicationState: true as any },
                  })
                  .catch(() => null);
                const out = await prisma.message
                  .findFirst({
                    where: { conversationId: conv.id, direction: 'OUTBOUND' },
                    orderBy: { timestamp: 'desc' },
                    select: { text: true },
                  })
                  .catch(() => null);
                const textNorm = normalizeForContains(String(out?.text || ''));
                const state = String((after as any)?.applicationState || '');
                const noRestart = !textNorm.includes('1) peoneta') && !textNorm.includes('elige el cargo');
                const stateOk = state !== 'STATE_0_ROLE_AND_LOCATION';
                assertions.push({
                  ok: noRestart,
                  message: noRestart
                    ? 'candidateOkDoesNotRestartFlow: no reinicia menú/cargo'
                    : `candidateOkDoesNotRestartFlow: reinició flujo (${String(out?.text || '—')})`,
                });
                assertions.push({
                  ok: stateOk,
                  message: stateOk
                    ? `candidateOkDoesNotRestartFlow: mantiene estado (${state || '—'})`
                    : 'candidateOkDoesNotRestartFlow: volvió a STATE_0_ROLE_AND_LOCATION',
                });
              }
            }
          }
        }

        await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.phoneLine.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
        await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
      }

      if (
        (uploadPublicAssetOk && typeof uploadPublicAssetOk === 'object') ||
        (sendPdfPublicAssetOk && typeof sendPdfPublicAssetOk === 'object') ||
        (sendPdfOutside24hReturnsBlocked && typeof sendPdfOutside24hReturnsBlocked === 'object')
      ) {
        const wsId = String(
          (uploadPublicAssetOk as any)?.workspaceId ||
            (sendPdfPublicAssetOk as any)?.workspaceId ||
            (sendPdfOutside24hReturnsBlocked as any)?.workspaceId ||
            'scenario-er-p1-send-pdf',
        ).trim() || 'scenario-er-p1-send-pdf';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();
        const lineId = `scenario-er-p1-send-pdf-line-${Date.now()}`;
        const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const staffE164 = '+56982345846';
        const staffWaId = '56982345846';
        const customerE164 = '+56994830202';
        const customerWaId = '56994830202';
        const assetSlug = `guia_pdf_scenario_${Date.now()}`;
        const previousAssetsDir = process.env.HUNTER_WORKSPACE_ASSETS_DIR;
        if (!previousAssetsDir) {
          process.env.HUNTER_WORKSPACE_ASSETS_DIR = `${process.cwd()}/tmp/workspace-assets`;
        }

        if (!userId) {
          assertions.push({ ok: false, message: 'sendPdf: userId missing' });
        } else {
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario ER-P1 SEND_PDF', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario ER-P1 SEND_PDF', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});
          const line = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario SEND_PDF Line',
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const staffContact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
              create: { workspaceId: wsId, displayName: 'Staff Scenario', waId: staffWaId, phone: staffE164, archivedAt: null } as any,
              update: { displayName: 'Staff Scenario', phone: staffE164, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const customerContact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: customerWaId } } as any,
              create: { workspaceId: wsId, displayName: 'Cliente Scenario', waId: customerWaId, phone: customerE164, archivedAt: null } as any,
              update: { displayName: 'Cliente Scenario', phone: customerE164, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const staffConv =
            line?.id && staffContact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      contactId: staffContact.id,
                      channel: 'sandbox',
                      status: 'OPEN',
                      conversationKind: 'STAFF',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;
          const customerConv =
            line?.id && customerContact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      contactId: customerContact.id,
                      channel: 'sandbox',
                      status: 'OPEN',
                      conversationKind: 'CLIENT',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

          if (!staffConv?.id || !customerConv?.id) {
            assertions.push({ ok: false, message: 'sendPdf: setup incompleto' });
          } else {
            const asset = await createWorkspaceAsset({
              workspaceId: wsId,
              title: 'Guía PDF Scenario',
              slug: assetSlug,
              description: 'Asset de prueba smoke',
              audience: 'PUBLIC',
              fileName: 'guia.pdf',
              mimeType: 'application/pdf',
              dataBase64: Buffer.from('%PDF-1.4\n% Smoke scenario\n').toString('base64'),
            }).catch(() => null);

            if (!asset?.id) {
              assertions.push({ ok: false, message: 'sendPdf: no se pudo crear asset PUBLIC' });
            } else {
              if (uploadPublicAssetOk && typeof uploadPublicAssetOk === 'object') {
                const absolute = resolveWorkspaceAssetAbsolutePath(asset as any);
                const exists = absolute
                  ? await fs
                      .access(absolute)
                      .then(() => true)
                      .catch(() => false)
                  : false;
                assertions.push({
                  ok: Boolean(asset.publicUrl) && exists,
                  message:
                    Boolean(asset.publicUrl) && exists
                      ? 'uploadPublicAssetOk: asset PUBLIC subido y persistido en disco'
                      : 'uploadPublicAssetOk: asset sin publicUrl o archivo no persistido',
                });
              }

              if (sendPdfPublicAssetOk && typeof sendPdfPublicAssetOk === 'object') {
                await prisma.message
                  .create({
                    data: {
                      conversationId: customerConv.id,
                      direction: 'INBOUND',
                      text: 'hola',
                      timestamp: new Date(),
                      read: false,
                      rawPayload: JSON.stringify({ simulated: true }),
                    },
                  })
                  .catch(() => {});

                const run = await prisma.agentRunLog
                  .create({
                    data: {
                      workspaceId: wsId,
                      conversationId: staffConv.id,
                      eventType: 'INBOUND_MESSAGE',
                      status: 'RUNNING',
                      inputContextJson: JSON.stringify({ event: { relatedConversationId: customerConv.id } }),
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null);
                if (!run?.id) {
                  assertions.push({ ok: false, message: 'sendPdfPublicAssetOk: no se pudo crear agent run' });
                } else {
                  const exec = await executeAgentResponse({
                    app,
                    workspaceId: wsId,
                    agentRunId: run.id,
                    response: {
                      agent: 'scenario_send_pdf',
                      version: 1,
                      commands: [
                        {
                          command: 'RUN_TOOL',
                          toolName: 'SEND_PDF',
                          args: { conversationId: customerConv.id, assetSlug, caption: 'Te comparto la guía' },
                        } as any,
                      ],
                    } as any,
                    transportMode: 'NULL',
                  }).catch(() => null);
                  const tool = exec?.results?.find((r: any) => r?.details?.toolName === 'SEND_PDF');
                  const out = await prisma.outboundMessageLog
                    .findFirst({
                      where: { workspaceId: wsId, conversationId: customerConv.id, type: 'DOCUMENT', assetSlug } as any,
                      orderBy: { createdAt: 'desc' },
                      select: { blockedReason: true, assetSlug: true },
                    })
                    .catch(() => null);
                  const ok = Boolean(tool?.ok) && !tool?.blocked && String(out?.blockedReason || '') === '';
                  assertions.push({
                    ok,
                    message: ok
                      ? 'sendPdfPublicAssetOk: documento enviado/logueado OK'
                      : `sendPdfPublicAssetOk: resultado inesperado (blocked=${String(tool?.blocked || false)}, reason=${String(out?.blockedReason || '—')})`,
                  });
                }
              }

              if (sendPdfOutside24hReturnsBlocked && typeof sendPdfOutside24hReturnsBlocked === 'object') {
                await prisma.message
                  .deleteMany({
                    where: { conversationId: customerConv.id, direction: 'INBOUND' },
                  })
                  .catch(() => {});
                await prisma.message
                  .create({
                    data: {
                      conversationId: customerConv.id,
                      direction: 'INBOUND',
                      text: 'hola',
                      timestamp: new Date(Date.now() - 26 * 60 * 60 * 1000),
                      read: false,
                      rawPayload: JSON.stringify({ simulated: true, outside24h: true }),
                    },
                  })
                  .catch(() => {});

                const run = await prisma.agentRunLog
                  .create({
                    data: {
                      workspaceId: wsId,
                      conversationId: staffConv.id,
                      eventType: 'INBOUND_MESSAGE',
                      status: 'RUNNING',
                      inputContextJson: JSON.stringify({ event: { relatedConversationId: customerConv.id } }),
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null);
                if (!run?.id) {
                  assertions.push({ ok: false, message: 'sendPdfOutside24hReturnsBlocked: no se pudo crear run' });
                } else {
                  const exec = await executeAgentResponse({
                    app,
                    workspaceId: wsId,
                    agentRunId: run.id,
                    response: {
                      agent: 'scenario_send_pdf_24h',
                      version: 1,
                      commands: [
                        {
                          command: 'RUN_TOOL',
                          toolName: 'SEND_PDF',
                          args: { conversationId: customerConv.id, assetSlug },
                        } as any,
                      ],
                    } as any,
                    transportMode: 'NULL',
                  }).catch(() => null);
                  const tool = exec?.results?.find((r: any) => r?.details?.toolName === 'SEND_PDF');
                  const out = await prisma.outboundMessageLog
                    .findFirst({
                      where: { workspaceId: wsId, conversationId: customerConv.id, type: 'DOCUMENT' },
                      orderBy: { createdAt: 'desc' },
                      select: { blockedReason: true },
                    })
                    .catch(() => null);
                  const blocked =
                    Boolean(tool?.blocked) &&
                    String(tool?.blockedReason || '').toUpperCase().includes('OUTSIDE_24H') &&
                    String(tool?.details?.suggestedTemplate || '').includes('enviorapido_postulacion_menu_v1') &&
                    String(out?.blockedReason || '').toUpperCase().includes('OUTSIDE_24H');
                  assertions.push({
                    ok: blocked,
                    message: blocked
                      ? 'sendPdfOutside24hReturnsBlocked: bloqueo OUTSIDE_24H + suggestedTemplate OK'
                      : `sendPdfOutside24hReturnsBlocked: resultado inesperado (tool=${String(tool?.blockedReason || '—')}, log=${String(out?.blockedReason || '—')})`,
                  });
                }
              }
            }
          }

          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          if (!previousAssetsDir) {
            delete process.env.HUNTER_WORKSPACE_ASSETS_DIR;
          } else {
            process.env.HUNTER_WORKSPACE_ASSETS_DIR = previousAssetsDir;
          }
        }
      }

      if (modelResolvedGpt4oMini && typeof modelResolvedGpt4oMini === 'object') {
        const wsId =
          String((modelResolvedGpt4oMini as any)?.workspaceId || 'scenario-er-p1-model').trim() ||
          'scenario-er-p1-model';
        const now = new Date();
        const lineId = `scenario-er-p1-model-line-${Date.now()}`;
        const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const candidateWaId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

        await prisma.workspace
          .upsert({
            where: { id: wsId },
            create: { id: wsId, name: 'Scenario ER-P1 Model', isSandbox: true, archivedAt: null } as any,
            update: { name: 'Scenario ER-P1 Model', isSandbox: true, archivedAt: null } as any,
          })
          .catch(() => {});
        const line = await prisma.phoneLine
          .create({
            data: {
              id: lineId,
              workspaceId: wsId,
              alias: 'Scenario Model Line',
              waPhoneNumberId,
              isActive: true,
              archivedAt: null,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const program = await prisma.program
          .create({
            data: {
              workspaceId: wsId,
              name: 'Scenario Model Program',
              slug: `scenario-model-program-${Date.now()}`,
              isActive: true,
              agentSystemPrompt: 'Responde breve.',
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const contact = await prisma.contact
          .create({
            data: { workspaceId: wsId, displayName: 'Scenario Model Contact', waId: candidateWaId, archivedAt: null } as any,
            select: { id: true },
          })
          .catch(() => null);
        const conv =
          line?.id && contact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: line.id,
                    programId: program?.id || null,
                    contactId: contact.id,
                    status: 'OPEN',
                    channel: 'sandbox',
                    conversationKind: 'CLIENT',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;
        if (!conv?.id) {
          assertions.push({ ok: false, message: 'modelResolvedGpt4oMini: setup incompleto' });
        } else {
          const inbound = await prisma.message
            .create({
              data: {
                conversationId: conv.id,
                direction: 'INBOUND',
                text: 'Hola',
                timestamp: new Date(),
                read: false,
                rawPayload: JSON.stringify({ simulated: true }),
              },
              select: { id: true },
            })
            .catch(() => null);
          const suggestRun = await runAgent({
            workspaceId: wsId,
            conversationId: conv.id,
            eventType: 'AI_SUGGEST',
            draftText: 'Hola, gracias por escribir',
          }).catch(() => null);
          const inboundRun = inbound?.id
            ? await runAgent({
                workspaceId: wsId,
                conversationId: conv.id,
                eventType: 'INBOUND_MESSAGE',
                inboundMessageId: inbound.id,
              }).catch(() => null)
            : null;

          const usageRows = await prisma.aiUsageLog
            .findMany({
              where: {
                agentRunId: {
                  in: [String(suggestRun?.runId || ''), String(inboundRun?.runId || '')].filter(Boolean),
                },
              },
              select: { modelResolved: true },
            })
            .catch(() => []);
          const allOk =
            usageRows.length >= 1 &&
            usageRows.every((row: any) => String(row?.modelResolved || '').toLowerCase().includes('gpt-4o-mini'));
          assertions.push({
            ok: allOk,
            message: allOk
              ? `modelResolvedGpt4oMini: OK (${usageRows.map((r: any) => String(r.modelResolved || '—')).join(', ')})`
              : `modelResolvedGpt4oMini: modelos inesperados (${usageRows.map((r: any) => String(r.modelResolved || '—')).join(', ')})`,
          });
        }

        await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.phoneLine.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
        await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
      }

      if (suggestRewritesSlangToProfessional && typeof suggestRewritesSlangToProfessional === 'object') {
        const wsId =
          String((suggestRewritesSlangToProfessional as any)?.workspaceId || 'scenario-er-p2-tone').trim() ||
          'scenario-er-p2-tone';
        const now = new Date();
        const lineId = `scenario-er-p2-tone-line-${Date.now()}`;
        const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const candidateWaId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

        await prisma.workspace
          .upsert({
            where: { id: wsId },
            create: { id: wsId, name: 'Scenario ER-P2 Tone', isSandbox: true, archivedAt: null } as any,
            update: { name: 'Scenario ER-P2 Tone', isSandbox: true, archivedAt: null } as any,
          })
          .catch(() => {});
        const line = await prisma.phoneLine
          .create({
            data: {
              id: lineId,
              workspaceId: wsId,
              alias: 'Scenario ER-P2 Tone Line',
              waPhoneNumberId,
              isActive: true,
              archivedAt: null,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const program = await prisma.program
          .create({
            data: {
              workspaceId: wsId,
              name: 'Scenario Tone Program',
              slug: `scenario-tone-program-${Date.now()}`,
              isActive: true,
              agentSystemPrompt: 'Responde en español profesional y amable, sin modismos.',
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const contact = await prisma.contact
          .create({
            data: { workspaceId: wsId, displayName: 'Scenario Tone Contact', waId: candidateWaId, archivedAt: null } as any,
            select: { id: true },
          })
          .catch(() => null);
        const conv =
          line?.id && contact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: line.id,
                    programId: program?.id || null,
                    contactId: contact.id,
                    status: 'OPEN',
                    channel: 'sandbox',
                    conversationKind: 'CLIENT',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;
        if (!conv?.id) {
          assertions.push({ ok: false, message: 'suggestRewritesSlangToProfessional: setup incompleto' });
        } else {
          await prisma.message
            .create({
              data: {
                conversationId: conv.id,
                direction: 'INBOUND',
                text: 'Hola, me interesa postular como conductor.',
                timestamp: new Date(),
                read: false,
                rawPayload: JSON.stringify({ simulated: true }),
              },
            })
            .catch(() => {});
          const run = await runAgent({
            workspaceId: wsId,
            conversationId: conv.id,
            eventType: 'AI_SUGGEST',
            inboundMessageId: null,
            draftText: 'wena, me tinca postular de conductor',
          }).catch(() => null);
          const sendText = String(
            (run as any)?.response?.commands?.find((c: any) => String(c?.command || '') === 'SEND_MESSAGE')?.text || ''
          ).trim();
          const normalized = normalizeForContains(sendText);
          const hasSlang =
            normalized.includes('wena') ||
            normalized.includes('tinca') ||
            normalized.includes('bacan') ||
            normalized.includes('compa') ||
            normalized.includes('bro') ||
            normalized.includes('cachai');
          assertions.push({
            ok: Boolean(sendText) && !hasSlang,
            message:
              Boolean(sendText) && !hasSlang
                ? 'suggestRewritesSlangToProfessional: salida profesional sin modismos'
                : `suggestRewritesSlangToProfessional: salida inválida (${sendText || '—'})`,
          });
        }
        await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.phoneLine.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
        await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
      }

      if (menuTemplateCanBeSent && typeof menuTemplateCanBeSent === 'object') {
        const wsId =
          String((menuTemplateCanBeSent as any)?.workspaceId || 'scenario-er-p2-menu-template').trim() ||
          'scenario-er-p2-menu-template';
        const now = new Date();
        const lineId = `scenario-er-p2-menu-line-${Date.now()}`;
        const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
        const candidateWaId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

        await prisma.workspace
          .upsert({
            where: { id: wsId },
            create: {
              id: wsId,
              name: 'Scenario ER-P2 Menu Template',
              isSandbox: true,
              archivedAt: null,
              templateRecruitmentStartName: 'enviorapido_postulacion_menu_v1',
              templateAdditionalNamesJson: JSON.stringify(['enviorapido_postulacion_menu_v1']),
            } as any,
            update: {
              archivedAt: null,
              templateRecruitmentStartName: 'enviorapido_postulacion_menu_v1',
              templateAdditionalNamesJson: JSON.stringify(['enviorapido_postulacion_menu_v1']),
            } as any,
          })
          .catch(() => {});
        const catalog = await listWorkspaceTemplateCatalog(wsId).catch(() => null);
        const hasMenuTemplate = Boolean(
          catalog?.templates?.some((t: any) => String(t?.name || '').trim() === 'enviorapido_postulacion_menu_v1')
        );
        assertions.push({
          ok: hasMenuTemplate,
          message: hasMenuTemplate
            ? 'menuTemplateCanBeSent: plantilla enviorapido_postulacion_menu_v1 visible en catálogo'
            : 'menuTemplateCanBeSent: plantilla menú no aparece en catálogo',
        });
        const line = await prisma.phoneLine
          .create({
            data: {
              id: lineId,
              workspaceId: wsId,
              alias: 'Scenario ER-P2 Menu Template',
              waPhoneNumberId,
              isActive: true,
              archivedAt: null,
            } as any,
            select: { id: true },
          })
          .catch(() => null);
        const contact = await prisma.contact
          .create({
            data: { workspaceId: wsId, displayName: 'Scenario Menu Contact', waId: candidateWaId, archivedAt: null } as any,
            select: { id: true },
          })
          .catch(() => null);
        const conv =
          line?.id && contact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: line.id,
                    contactId: contact.id,
                    status: 'OPEN',
                    channel: 'whatsapp',
                    conversationKind: 'CLIENT',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;
        if (!conv?.id) {
          assertions.push({ ok: false, message: 'menuTemplateCanBeSent: setup incompleto para envío' });
        } else {
          const run = await prisma.agentRunLog
            .create({
              data: {
                workspaceId: wsId,
                conversationId: conv.id,
                eventType: 'INBOUND_MESSAGE',
                status: 'RUNNING',
                inputContextJson: JSON.stringify({ scenario: 'menu_template_can_be_sent' }),
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          if (!run?.id) {
            assertions.push({ ok: false, message: 'menuTemplateCanBeSent: no se pudo crear run' });
          } else {
            const exec = await executeAgentResponse({
              app,
              workspaceId: wsId,
              agentRunId: run.id,
              response: {
                agent: 'scenario_menu_template',
                version: 1,
                commands: [
                  {
                    command: 'SEND_MESSAGE',
                    conversationId: conv.id,
                    channel: 'WHATSAPP',
                    type: 'TEMPLATE',
                    templateName: 'enviorapido_postulacion_menu_v1',
                    templateVars: { '1': 'Estimado' },
                    dedupeKey: `scenario_menu_tpl_${Date.now()}`,
                  },
                ],
              } as any,
              transportMode: 'NULL',
            }).catch(() => null);
            const log = await prisma.outboundMessageLog
              .findFirst({
                where: {
                  workspaceId: wsId,
                  conversationId: conv.id,
                  type: 'TEMPLATE',
                  templateName: 'enviorapido_postulacion_menu_v1',
                } as any,
                orderBy: { createdAt: 'desc' },
                select: { blockedReason: true },
              })
              .catch(() => null);
            const blockedReason = String(log?.blockedReason || '');
            const ok =
              Boolean(exec?.results?.length) &&
              (blockedReason === '' ||
                blockedReason === 'SAFE_OUTBOUND_BLOCKED:ALLOWLIST_ONLY:NOT_IN_ALLOWLIST');
            assertions.push({
              ok,
              message: ok
                ? blockedReason
                  ? `menuTemplateCanBeSent: comando plantilla ejecutado (bloqueo esperado por SAFE MODE: ${blockedReason})`
                  : 'menuTemplateCanBeSent: comando plantilla envía menú OK'
                : `menuTemplateCanBeSent: envío menú falló (${blockedReason || 'sin_log'})`,
            });
          }
        }
        await prisma.conversation.updateMany({ where: { workspaceId: wsId, id: conv?.id }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.contact.updateMany({ where: { workspaceId: wsId, id: contact?.id }, data: { archivedAt: now } as any }).catch(() => {});
        await prisma.phoneLine.updateMany({ where: { workspaceId: wsId, id: line?.id }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
        await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
      }

      if (inboundUnroutedDoesNotReply) {
        const beforeOutbound = await prisma.outboundMessageLog.count().catch(() => 0);
        const beforeUnrouted = await prisma.automationRunLog
          .count({
            where: { eventType: 'UNROUTED_INBOUND' } as any,
          })
          .catch(() => 0);
        const unknownWaPhoneNumberId = `999${Date.now()}`.slice(0, 18);
        await handleInboundWhatsAppMessage(app, {
          waMessageId: `scenario-unrouted-${Date.now()}`,
          waPhoneNumberId: unknownWaPhoneNumberId,
          from: '56999999999',
          text: 'Hola',
          rawPayload: { simulated: true, scenario: 'inbound_unrouted_does_not_reply' },
          timestamp: Math.floor(Date.now() / 1000),
        }).catch(() => {});
        const afterOutbound = await prisma.outboundMessageLog.count().catch(() => 0);
        const afterUnrouted = await prisma.automationRunLog
          .count({
            where: { eventType: 'UNROUTED_INBOUND' } as any,
          })
          .catch(() => 0);
        assertions.push({
          ok: afterOutbound === beforeOutbound,
          message:
            afterOutbound === beforeOutbound
              ? 'inboundUnroutedDoesNotReply: no se envió outbound cuando no hubo routing'
              : `inboundUnroutedDoesNotReply: outbound inesperado (${beforeOutbound} -> ${afterOutbound})`,
        });
        assertions.push({
          ok: afterUnrouted > beforeUnrouted,
          message:
            afterUnrouted > beforeUnrouted
              ? 'inboundUnroutedDoesNotReply: evento UNROUTED_INBOUND logueado'
              : 'inboundUnroutedDoesNotReply: faltó log UNROUTED_INBOUND',
        });
      }

      if (deployDoesNotTouchDb) {
        const scriptCandidates = [
          '/opt/hunter/ops/deploy_hunter_prod.sh',
          '/opt/hunter/current/ops/deploy_hunter_prod.sh',
          `${process.cwd()}/../ops/deploy_hunter_prod.sh`,
          `${process.cwd()}/ops/deploy_hunter_prod.sh`,
        ];
        let script = '';
        for (const candidate of scriptCandidates) {
          if (script) break;
          script = await fs.readFile(candidate, 'utf8').catch(() => '');
        }
        const hasExcludeDb = script.includes("--exclude='dev.db'") || script.includes('--exclude=dev.db');
        const hasExcludeUploads = script.includes("--exclude='backend/uploads'") || script.includes('--exclude=backend/uploads');
        const hasBackup =
          script.includes('hunter_backup.sh') ||
          script.includes('backup pre-deploy') ||
          script.includes('sqlite3 \"$SHARED_DIR/dev.db\" \".backup') ||
          script.includes('sqlite3 \"$STATE_DIR/dev.db\" \".backup');
        const hasRollback = script.includes('rollback_to_previous_release');
        const hasGuardIp = script.includes('EXPECTED_NEW_IP') && script.includes('16.59.92.121');
        assertions.push({
          ok: hasExcludeDb && hasExcludeUploads,
          message:
            hasExcludeDb && hasExcludeUploads
              ? 'deployDoesNotTouchDb: excludes de DB/uploads presentes'
              : 'deployDoesNotTouchDb: faltan excludes de DB/uploads',
        });
        assertions.push({
          ok: hasBackup,
          message: hasBackup
            ? 'deployDoesNotTouchDb: backup SQLite presente'
            : 'deployDoesNotTouchDb: falta backup SQLite',
        });
        assertions.push({
          ok: hasRollback,
          message: hasRollback
            ? 'deployDoesNotTouchDb: rollback automático presente'
            : 'deployDoesNotTouchDb: falta rollback automático',
        });
        assertions.push({
          ok: hasGuardIp,
          message: hasGuardIp
            ? 'deployDoesNotTouchDb: guardrail de host/IP presente'
            : 'deployDoesNotTouchDb: falta guardrail host/IP',
        });
      }

      if (deployCreatesBackupBeforeRestart) {
        const scriptCandidates = [
          '/opt/hunter/ops/deploy_hunter_prod.sh',
          '/opt/hunter/current/ops/deploy_hunter_prod.sh',
          `${process.cwd()}/../ops/deploy_hunter_prod.sh`,
          `${process.cwd()}/ops/deploy_hunter_prod.sh`,
        ];
        const backupCandidates = [
          '/opt/hunter/ops/hunter_backup.sh',
          '/opt/hunter/current/ops/hunter_backup.sh',
          `${process.cwd()}/../ops/hunter_backup.sh`,
          `${process.cwd()}/ops/hunter_backup.sh`,
        ];
        let deployScript = '';
        for (const candidate of scriptCandidates) {
          if (deployScript) break;
          deployScript = await fs.readFile(candidate, 'utf8').catch(() => '');
        }
        let backupScript = '';
        for (const candidate of backupCandidates) {
          if (backupScript) break;
          backupScript = await fs.readFile(candidate, 'utf8').catch(() => '');
        }

        const callsBackupScript =
          deployScript.includes('BACKUP_SCRIPT') &&
          deployScript.includes('hunter_backup.sh') &&
          deployScript.includes('backup pre-deploy');
        const backupHasManifest = backupScript.includes('manifest.txt');
        const backupHasChecksums = backupScript.includes('SHA256SUMS.txt') && backupScript.includes('sha256sum');
        const backupUsesSqliteBackup = backupScript.includes('.backup') && backupScript.includes('sqlite3');
        const backupRetention = backupScript.includes('RETENTION_DAYS') && backupScript.includes('-mtime +');

        assertions.push({
          ok: callsBackupScript,
          message: callsBackupScript
            ? 'deployCreatesBackupBeforeRestart: deploy invoca hunter_backup.sh antes de restart'
            : 'deployCreatesBackupBeforeRestart: falta invocación obligatoria de hunter_backup.sh',
        });
        assertions.push({
          ok: backupHasManifest && backupHasChecksums,
          message:
            backupHasManifest && backupHasChecksums
              ? 'deployCreatesBackupBeforeRestart: backup genera manifest + SHA256SUMS'
              : 'deployCreatesBackupBeforeRestart: backup sin manifest o checksums',
        });
        assertions.push({
          ok: backupUsesSqliteBackup,
          message: backupUsesSqliteBackup
            ? 'deployCreatesBackupBeforeRestart: backup usa sqlite3 .backup'
            : 'deployCreatesBackupBeforeRestart: backup no usa sqlite3 .backup',
        });
        assertions.push({
          ok: backupRetention,
          message: backupRetention
            ? 'deployCreatesBackupBeforeRestart: retención de backups configurable presente'
            : 'deployCreatesBackupBeforeRestart: falta retención de backups',
        });
      }

      if (staffTemplateVars && typeof staffTemplateVars === 'object') {
        const wsId = String((staffTemplateVars as any)?.workspaceId || 'scenario-staff-template-vars').trim() || 'scenario-staff-template-vars';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'staffTemplateVars: userId missing' });
        } else {
          const staffE164 = '+56982345846';
          const staffWaId = '56982345846';
          const lineId = `scenario-staff-template-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Staff Template Vars', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Staff Template Vars', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});

          const phoneLine = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Staff Template Vars (temp)',
                phoneE164: null,
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          const staffContact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
              create: { workspaceId: wsId, waId: staffWaId, phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              update: { phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const staffConv = staffContact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: phoneLine?.id,
                    programId: null,
                    contactId: staffContact.id,
                    status: 'OPEN',
                    channel: 'whatsapp',
                    isAdmin: false,
                    aiMode: 'OFF',
                    conversationKind: 'STAFF',
                    conversationStage: 'NUEVO',
                    stageChangedAt: now,
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;
          if (staffConv?.id) {
            await prisma.message
              .create({
                data: { conversationId: staffConv.id, direction: 'INBOUND', text: 'activar', timestamp: now, read: true } as any,
              })
              .catch(() => {});
          }

          const client = await prisma.contact
            .create({
              data: { workspaceId: wsId, displayName: 'María López', comuna: 'Providencia', availabilityText: 'martes 10:00-12:00', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const conv = client?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: phoneLine?.id,
                    programId: null,
                    contactId: client.id,
                    status: 'NEW',
                    conversationStage: 'INTERESADO',
                    stageChangedAt: now,
                    assignedToId: userId,
                    channel: 'system',
                    isAdmin: false,
                    conversationKind: 'CLIENT',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          const rule = await prisma.automationRule
            .create({
              data: {
                workspaceId: wsId,
                name: 'Scenario staff template vars',
                enabled: true,
                priority: 50,
                trigger: 'STAGE_CHANGED',
                conditionsJson: JSON.stringify([]),
                actionsJson: JSON.stringify([
                  {
                    type: 'NOTIFY_STAFF_WHATSAPP',
                    recipients: 'ASSIGNED_TO',
                    templateText:
                      'Caso {{stage}}: {{clientName}} | {{service}} | {{location}} | {{availability}} | ID={{conversationIdShort}}',
                    dedupePolicy: 'PER_STAGE_CHANGE',
                  },
                ]),
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          if (!phoneLine?.id || !staffConv?.id || !conv?.id || !rule?.id) {
            assertions.push({ ok: false, message: 'staffTemplateVars: setup incompleto (phoneLine/staffConv/conv/rule)' });
          } else {
            await runAutomations({
              app,
              workspaceId: wsId,
              eventType: 'STAGE_CHANGED',
              conversationId: conv.id,
              transportMode: 'NULL',
            });

            const last = await prisma.message
              .findFirst({
                where: { conversationId: staffConv.id, direction: 'OUTBOUND' },
                orderBy: { timestamp: 'desc' },
                select: { text: true },
              })
              .catch(() => null);
            const text = String(last?.text || '');
            const ok = text.includes('María') && text.includes('INTERESADO') && !text.includes('{{');
            assertions.push({
              ok,
              message: ok ? 'staffTemplateVars: template variables renderizadas OK' : `staffTemplateVars: texto inesperado: ${text || '—'}`,
            });
          }

          // Cleanup: archive-only.
          await prisma.automationRule.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
        }
      }

      const requireAvailability = (step.expect as any)?.ssclinicalNotificationRequiresAvailability;
      if (requireAvailability && typeof requireAvailability === 'object') {
        const wsId = String((requireAvailability as any)?.workspaceId || 'scenario-require-availability').trim() || 'scenario-require-availability';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'requireAvailability: userId missing' });
        } else {
          const staffE164 = '+56982345846';
          const lineId = `scenario-require-availability-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario require availability', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario require availability', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});

          const phoneLine = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario require availability (temp)',
                phoneE164: null,
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          const client = await prisma.contact
            .create({ data: { workspaceId: wsId, displayName: 'Cliente sin disponibilidad', archivedAt: null } as any, select: { id: true } })
            .catch(() => null);
          const conv = client?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: phoneLine?.id,
                    programId: null,
                    contactId: client.id,
                    status: 'NEW',
                    conversationStage: 'INTERESADO',
                    stageChangedAt: now,
                    assignedToId: userId,
                    channel: 'system',
                    isAdmin: false,
                    conversationKind: 'CLIENT',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          const rule = await prisma.automationRule
            .create({
              data: {
                workspaceId: wsId,
                name: 'Scenario requireAvailability=true',
                enabled: true,
                priority: 10,
                trigger: 'STAGE_CHANGED',
                conditionsJson: JSON.stringify([]),
                actionsJson: JSON.stringify([
                  { type: 'NOTIFY_STAFF_WHATSAPP', recipients: 'ASSIGNED_TO', requireAvailability: true, templateText: 'Ping {{clientName}}' },
                ]),
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          if (!phoneLine?.id || !conv?.id || !rule?.id) {
            assertions.push({ ok: false, message: 'requireAvailability: setup incompleto' });
          } else {
            await runAutomations({
              app,
              workspaceId: wsId,
              eventType: 'STAGE_CHANGED',
              conversationId: conv.id,
              transportMode: 'NULL',
            });

            const run = await prisma.automationRunLog
              .findFirst({
                where: { workspaceId: wsId, ruleId: rule.id, conversationId: conv.id },
                orderBy: { createdAt: 'desc' },
                select: { status: true, outputJson: true },
              })
              .catch(() => null);
            const output = run?.outputJson ? JSON.parse(String(run.outputJson)) : null;
            const outputs = Array.isArray(output?.outputs) ? output.outputs : [];
            const skipped = outputs.some((o: any) => o?.action === 'NOTIFY_STAFF_WHATSAPP' && o?.skipped === true && o?.reason === 'require_availability');
            assertions.push({
              ok: Boolean(run?.status === 'SUCCESS' && skipped),
              message: skipped ? 'requireAvailability: skipped OK' : 'requireAvailability: expected skipped reason=require_availability',
            });

            const outboundCount = await prisma.outboundMessageLog
              .count({ where: { workspaceId: wsId, relatedConversationId: conv.id } })
              .catch(() => 0);
            assertions.push({
              ok: outboundCount === 0,
              message: outboundCount === 0 ? 'requireAvailability: sin outbound OK' : `requireAvailability: esperaba 0 outbound, got ${outboundCount}`,
            });
          }

          // Cleanup: archive-only.
          await prisma.automationRule.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
        }
      }

      const staffReplyTo = (step.expect as any)?.staffReplyToNotificationUpdatesCase;
      if (staffReplyTo && typeof staffReplyTo === 'object') {
        const wsId = String((staffReplyTo as any)?.workspaceId || 'scenario-staff-replyto').trim() || 'scenario-staff-replyto';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'staffReplyTo: userId missing' });
        } else {
          const staffE164 = '+56982345846';
          const staffWaId = '56982345846';
          const lineId = `scenario-staff-replyto-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Staff ReplyTo', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Staff ReplyTo', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});

          const phoneLine = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Staff ReplyTo (temp)',
                phoneE164: null,
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          const staffContact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
              create: { workspaceId: wsId, waId: staffWaId, phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              update: { phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const staffConv = staffContact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: phoneLine?.id,
                    programId: null,
                    contactId: staffContact.id,
                    status: 'OPEN',
                    channel: 'whatsapp',
                    isAdmin: false,
                    aiMode: 'OFF',
                    conversationKind: 'STAFF',
                    conversationStage: 'NUEVO',
                    stageChangedAt: now,
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;
          if (staffConv?.id) {
            await prisma.message
              .create({ data: { conversationId: staffConv.id, direction: 'INBOUND', text: 'activar', timestamp: now, read: true } as any })
              .catch(() => {});
          }

          const client = await prisma.contact
            .create({
              data: { workspaceId: wsId, displayName: 'Caso ReplyTo', comuna: 'Providencia', availabilityText: 'martes 10:00-12:00', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const conv = client?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: phoneLine?.id,
                    programId: null,
                    contactId: client.id,
                    status: 'NEW',
                    conversationStage: 'NUEVO',
                    stageChangedAt: now,
                    assignedToId: userId,
                    channel: 'system',
                    isAdmin: false,
                    conversationKind: 'CLIENT',
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          const rule = await prisma.automationRule
            .create({
              data: {
                workspaceId: wsId,
                name: 'Scenario ReplyTo notify staff',
                enabled: true,
                priority: 10,
                trigger: 'STAGE_CHANGED',
                conditionsJson: JSON.stringify([]),
                actionsJson: JSON.stringify([
                  { type: 'NOTIFY_STAFF_WHATSAPP', recipients: 'ASSIGNED_TO', templateText: '🔔 Caso {{stage}}: {{clientName}}', dedupePolicy: 'PER_STAGE_CHANGE' },
                ]),
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          if (!phoneLine?.id || !staffConv?.id || !conv?.id || !rule?.id) {
            assertions.push({ ok: false, message: 'staffReplyTo: setup incompleto (line/staff/conv/rule)' });
          } else {
            await prisma.conversation.update({ where: { id: conv.id }, data: { conversationStage: 'INTERESADO', stageChangedAt: now } as any }).catch(() => {});
            await runAutomations({
              app,
              workspaceId: wsId,
              eventType: 'STAGE_CHANGED',
              conversationId: conv.id,
              transportMode: 'NULL',
            });

            const outbound = await prisma.outboundMessageLog
              .findFirst({
                where: { workspaceId: wsId, conversationId: staffConv.id, relatedConversationId: conv.id },
                orderBy: { createdAt: 'desc' },
                select: { waMessageId: true },
              })
              .catch(() => null);
            const waMessageId = String(outbound?.waMessageId || '').trim();
            const outboundOk = Boolean(waMessageId);
            assertions.push({ ok: outboundOk, message: outboundOk ? 'staffReplyTo: outbound notification OK' : 'staffReplyTo: missing outbound waMessageId' });

            const inboundReply = await prisma.message
              .create({
                data: {
                  conversationId: staffConv.id,
                  direction: 'INBOUND',
                  text: 'Ok, pasarlo a EN_COORDINACION',
                  rawPayload: JSON.stringify({ simulated: true, context: { id: waMessageId } }),
                  timestamp: new Date(now.getTime() + 1000),
                  read: true,
                } as any,
                select: { id: true },
              })
              .catch(() => null);

            const replyCtx = inboundReply?.id
              ? await resolveReplyContextForInboundMessage({ workspaceId: wsId, inboundMessageId: inboundReply.id }).catch(() => null)
              : null;
            const ctxOk = Boolean(replyCtx?.relatedConversationId) && String(replyCtx?.relatedConversationId) === String(conv.id);
            assertions.push({
              ok: ctxOk,
              message: ctxOk ? 'staffReplyTo: resolveReplyContext OK' : `staffReplyTo: expected relatedConversationId=${conv.id}, got ${String(replyCtx?.relatedConversationId || '—')}`,
            });

            const staffRun = await prisma.agentRunLog.create({
              data: {
                workspaceId: wsId,
                conversationId: staffConv.id,
                programId: null,
                phoneLineId: phoneLine.id,
                eventType: 'STAFF_REPLY_TOOL',
                status: 'RUNNING',
                inputContextJson: JSON.stringify({ event: { relatedConversationId: conv.id } }),
              },
              select: { id: true },
            });

            await executeAgentResponse({
              app,
              workspaceId: wsId,
              agentRunId: staffRun.id,
              response: { agent: 'scenario', version: 1, commands: [{ command: 'RUN_TOOL', toolName: 'SET_STAGE', args: { stageSlug: 'EN_COORDINACION' } } as any] } as any,
              transportMode: 'NULL',
            }).catch((err: any) => {
              assertions.push({ ok: false, message: `staffReplyTo: executeAgentResponse error: ${err?.message || err}` });
            });

            const updated = await prisma.conversation.findUnique({ where: { id: conv.id }, select: { conversationStage: true } }).catch(() => null);
            const stageOk = String((updated as any)?.conversationStage || '') === 'EN_COORDINACION';
            assertions.push({
              ok: stageOk,
              message: stageOk ? 'staffReplyTo: SET_STAGE (default relatedConversationId) OK' : `staffReplyTo: stage esperado EN_COORDINACION, got ${String((updated as any)?.conversationStage || '—')}`,
            });
          }

          // Cleanup: archive-only.
          await prisma.automationRule.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
        }
      }

      const staffModeRouting = (step.expect as any)?.staffModeRouting;
      if (staffModeRouting && typeof staffModeRouting === 'object') {
        const wsId = String((staffModeRouting as any)?.workspaceId || 'scenario-persona-routing').trim() || 'scenario-persona-routing';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'staffModeRouting: userId missing' });
        } else {
          const staffE164 = '+56982345846';
          const staffWaId = '56982345846';
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          const lineId = `${wsId}-line-${Date.now()}`;

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              // Important: inbound routing ignores workspaces marked as sandbox.
              create: { id: wsId, name: 'Scenario Persona Routing', isSandbox: false, archivedAt: null } as any,
              update: { name: 'Scenario Persona Routing', isSandbox: false, archivedAt: null } as any,
            })
            .catch(() => {});

          const program = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'scenario-staff-default' } } as any,
              create: {
                workspaceId: wsId,
                name: 'Scenario Staff Default',
                slug: 'scenario-staff-default',
                description: 'Scenario staff default program',
                isActive: true,
                archivedAt: null,
                agentSystemPrompt: 'Eres un agente de prueba. Responde breve.',
              } as any,
              update: { name: 'Scenario Staff Default', isActive: true, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);

          if (!program?.id) {
            assertions.push({ ok: false, message: 'staffModeRouting: no se pudo crear Program' });
          } else {
            await prisma.workspace
              .update({
                where: { id: wsId },
                data: { staffDefaultProgramId: program.id, allowPersonaSwitchByWhatsApp: true, personaSwitchTtlMinutes: 360 } as any,
              })
              .catch(() => {});

            await prisma.membership
              .upsert({
                where: { userId_workspaceId: { userId, workspaceId: wsId } },
                create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
                update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              })
              .catch(() => {});

            const phoneLine = await prisma.phoneLine
              .create({
                data: {
                  id: lineId,
                  workspaceId: wsId,
                  alias: 'Scenario Persona Routing (temp)',
                  phoneE164: null,
                  waPhoneNumberId,
                  isActive: true,
                  archivedAt: null,
                  needsAttention: false,
                } as any,
                select: { waPhoneNumberId: true },
              })
              .catch(() => null);

            if (!phoneLine?.waPhoneNumberId) {
              assertions.push({ ok: false, message: 'staffModeRouting: no se pudo crear PhoneLine' });
            } else {
              const config = await getSystemConfig();
              const configOverride = { ...config, botAutoReply: false };
              const res = await handleInboundWhatsAppMessage(app, {
                waPhoneNumberId,
                from: staffWaId,
                text: 'Hola',
                waMessageId: `scenario-staff-route-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                timestamp: Math.floor(Date.now() / 1000),
                profileName: 'Scenario Staff',
                media: null,
                rawPayload: { simulated: true, scenario: 'staff_mode_routing' },
                config: configOverride as any,
              } as any).catch(() => ({ conversationId: '' }));

              const convo = res?.conversationId
                ? await prisma.conversation
                    .findUnique({
                      where: { id: res.conversationId },
                      select: { id: true, conversationKind: true as any, programId: true, program: { select: { id: true } } },
                    })
                    .catch(() => null)
                : null;

              const kindOk = String((convo as any)?.conversationKind || '').toUpperCase() === 'STAFF';
              const programOk = Boolean(convo?.programId) && String(convo?.programId) === String(program.id);
              assertions.push({
                ok: Boolean(convo?.id && kindOk),
                message: kindOk ? 'staffModeRouting: kind=STAFF OK' : `staffModeRouting: expected STAFF, got ${String((convo as any)?.conversationKind || '—')}`,
              });
              assertions.push({
                ok: Boolean(convo?.id && programOk),
                message: programOk ? 'staffModeRouting: staffDefaultProgram aplicado OK' : 'staffModeRouting: staffDefaultProgram NO aplicado',
              });
            }

            // Cleanup: archive-only.
            await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
            await prisma.program.updateMany({ where: { workspaceId: wsId, id: program.id }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          }
        }
      }

      const staffMenuSwitchProgram = (step.expect as any)?.staffMenuSwitchProgram;
      if (staffMenuSwitchProgram && typeof staffMenuSwitchProgram === 'object') {
        const wsId = String((staffMenuSwitchProgram as any)?.workspaceId || 'scenario-staff-menu-switch').trim() || 'scenario-staff-menu-switch';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'staffMenuSwitchProgram: userId missing' });
        } else {
          const staffE164 = '+56982345846';
          const staffWaId = '56982345846';
          // Keep scenario fixtures idempotent across runs (archive-only DB).
          const lineId = `${wsId}-line`;
          const waPhoneNumberId = `${wsId}-wa`;

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Staff Menu', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Staff Menu', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});

          const createProgram = async (slug: string, name: string, isActive = true) => {
            return prisma.program
              .upsert({
                where: { workspaceId_slug: { workspaceId: wsId, slug } } as any,
                create: { workspaceId: wsId, name, slug, isActive, archivedAt: null, agentSystemPrompt: 'Agente de prueba.' } as any,
                update: { name, isActive, archivedAt: null } as any,
                select: { id: true, name: true },
              })
              .catch(() => null);
          };
          const progA = await createProgram('scenario-staff-menu-a', 'Scenario Staff Menu A', true);
          const progB = await createProgram('scenario-staff-menu-b', 'Scenario Staff Menu B', true);
          const progC = await createProgram('scenario-staff-menu-c', 'Scenario Staff Menu C (Inactivo)', false);

          const phoneLine = await prisma.phoneLine
            .upsert({
              where: { id: lineId },
              create: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Staff Menu (temp)',
                phoneE164: null,
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              update: {
                alias: 'Scenario Staff Menu (temp)',
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          const staffContact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
              create: { workspaceId: wsId, waId: staffWaId, phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              update: { phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const staffConv = staffContact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: phoneLine?.id,
                    programId: null,
                    contactId: staffContact.id,
                    status: 'OPEN',
                    channel: 'whatsapp',
                    isAdmin: false,
                    aiMode: 'OFF',
                    conversationKind: 'STAFF',
                    conversationStage: 'NUEVO',
                    stageChangedAt: now,
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          if (!progA?.id || !progB?.id || !progC?.id || !staffConv?.id || !phoneLine?.id) {
            assertions.push({ ok: false, message: 'staffMenuSwitchProgram: setup incompleto' });
          } else {
            await prisma.workspace
              .update({
                where: { id: wsId },
                data: { staffProgramMenuIdsJson: JSON.stringify([progA.id, progB.id, progC.id]) } as any,
              })
              .catch(() => {});

            const msgMenu = await prisma.message
              .create({
                data: { conversationId: staffConv.id, direction: 'INBOUND', text: 'menu', rawPayload: JSON.stringify({ simulated: true }), timestamp: now, read: false } as any,
              })
              .catch(() => null);
            await runAutomations({
              app,
              workspaceId: wsId,
              eventType: 'INBOUND_MESSAGE',
              conversationId: staffConv.id,
              inboundMessageId: msgMenu?.id || null,
              inboundText: 'menu',
              transportMode: 'NULL',
            });

            const out = await prisma.message
              .findFirst({
                where: { conversationId: staffConv.id, direction: 'OUTBOUND' },
                orderBy: { timestamp: 'desc' },
                select: { text: true },
              })
              .catch(() => null);
            const outText = String(out?.text || '');
            assertions.push({
              ok: outText.includes('1)') && outText.includes('Scenario Staff Menu A') && outText.includes('Scenario Staff Menu B'),
              message: 'staffMenuSwitchProgram: menú incluye A/B',
            });
            assertions.push({
              ok: !outText.includes('Scenario Staff Menu C'),
              message: !outText.includes('Scenario Staff Menu C') ? 'staffMenuSwitchProgram: menú NO incluye inactivo (C)' : 'staffMenuSwitchProgram: menú incluye Program inactivo',
            });

            const msgChoice = await prisma.message
              .create({
                data: { conversationId: staffConv.id, direction: 'INBOUND', text: '1', rawPayload: JSON.stringify({ simulated: true }), timestamp: new Date(now.getTime() + 1000), read: false } as any,
              })
              .catch(() => null);
            await runAutomations({
              app,
              workspaceId: wsId,
              eventType: 'INBOUND_MESSAGE',
              conversationId: staffConv.id,
              inboundMessageId: msgChoice?.id || null,
              inboundText: '1',
              transportMode: 'NULL',
            });

            const updated = await prisma.conversation
              .findUnique({ where: { id: staffConv.id }, select: { programId: true } })
              .catch(() => null);
            assertions.push({
              ok: String(updated?.programId || '') === String(progA.id),
              message: String(updated?.programId || '') === String(progA.id) ? 'staffMenuSwitchProgram: programId elegido OK' : 'staffMenuSwitchProgram: programId no se actualizó',
            });
          }

          // Cleanup: archive-only.
          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.program.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const personaSwitchScenario = (step.expect as any)?.roleSwitchModeClienteStaff;
      if (personaSwitchScenario && typeof personaSwitchScenario === 'object') {
        const wsId = String((personaSwitchScenario as any)?.workspaceId || 'scenario-persona-switch').trim() || 'scenario-persona-switch';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'roleSwitchModeClienteStaff: userId missing' });
        } else {
          const staffE164 = '+56982345846';
          const staffWaId = '56982345846';
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          const lineId = `${wsId}-line-${Date.now()}`;

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              // Important: inbound routing ignores workspaces marked as sandbox.
              create: { id: wsId, name: 'Scenario Persona Switch', isSandbox: false, archivedAt: null } as any,
              update: { name: 'Scenario Persona Switch', isSandbox: false, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.workspace.update({ where: { id: wsId }, data: { allowPersonaSwitchByWhatsApp: true, personaSwitchTtlMinutes: 360 } as any }).catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.phoneLine
            .create({
              data: { id: lineId, workspaceId: wsId, alias: 'Scenario Persona Switch (temp)', phoneE164: null, waPhoneNumberId, isActive: true, archivedAt: null, needsAttention: false } as any,
            })
            .catch(() => {});

          const config = await getSystemConfig();
          const configOverride = { ...config, botAutoReply: false };

          const resStaff = await handleInboundWhatsAppMessage(app, {
            waPhoneNumberId,
            from: staffWaId,
            text: 'Hola',
            waMessageId: `scenario-persona-${Date.now()}-1`,
            timestamp: Math.floor(Date.now() / 1000),
            profileName: 'Scenario Staff',
            media: null,
            rawPayload: { simulated: true, scenario: 'role_switch_mode' },
            config: configOverride as any,
          } as any).catch(() => ({ conversationId: '' }));

          const staffConvId = resStaff?.conversationId || '';
          const staffConv = staffConvId ? await prisma.conversation.findUnique({ where: { id: staffConvId }, select: { conversationKind: true as any } }).catch(() => null) : null;
          assertions.push({
            ok: String((staffConv as any)?.conversationKind || '').toUpperCase() === 'STAFF',
            message: String((staffConv as any)?.conversationKind || '').toUpperCase() === 'STAFF' ? 'personaSwitch: base STAFF OK' : 'personaSwitch: base kind no es STAFF',
          });

          const resSwitch = await handleInboundWhatsAppMessage(app, {
            waPhoneNumberId,
            from: staffWaId,
            text: 'modo cliente',
            waMessageId: `scenario-persona-${Date.now()}-2`,
            timestamp: Math.floor(Date.now() / 1000),
            profileName: 'Scenario Staff',
            media: null,
            rawPayload: { simulated: true, scenario: 'role_switch_mode' },
            config: configOverride as any,
          } as any).catch(() => ({ conversationId: '' }));

          const staffConvAfter = staffConvId
            ? await prisma.conversation
                .findUnique({ where: { id: staffConvId }, select: { activePersonaKind: true as any, activePersonaUntilAt: true as any } } as any)
                .catch(() => null)
            : null;
          const overrideKind = String((staffConvAfter as any)?.activePersonaKind || '').toUpperCase();
          assertions.push({
            ok: overrideKind === 'CLIENT',
            message: overrideKind === 'CLIENT' ? 'personaSwitch: activePersonaKind=CLIENT OK' : `personaSwitch: expected CLIENT, got ${overrideKind || '—'}`,
          });
          assertions.push({
            ok: Boolean((staffConvAfter as any)?.activePersonaUntilAt),
            message: (staffConvAfter as any)?.activePersonaUntilAt ? 'personaSwitch: TTL set OK' : 'personaSwitch: TTL missing',
          });

          const resClient = await handleInboundWhatsAppMessage(app, {
            waPhoneNumberId,
            from: staffWaId,
            text: 'Hola',
            waMessageId: `scenario-persona-${Date.now()}-3`,
            timestamp: Math.floor(Date.now() / 1000),
            profileName: 'Scenario Staff',
            media: null,
            rawPayload: { simulated: true, scenario: 'role_switch_mode' },
            config: configOverride as any,
          } as any).catch(() => ({ conversationId: '' }));

          const clientConvId = resClient?.conversationId || '';
          const clientConv = clientConvId ? await prisma.conversation.findUnique({ where: { id: clientConvId }, select: { conversationKind: true as any } } as any).catch(() => null) : null;
          assertions.push({
            ok: String((clientConv as any)?.conversationKind || '').toUpperCase() === 'CLIENT',
            message: String((clientConv as any)?.conversationKind || '').toUpperCase() === 'CLIENT' ? 'personaSwitch: inbound enruta a CLIENT OK' : 'personaSwitch: inbound NO enruta a CLIENT',
          });

          await handleInboundWhatsAppMessage(app, {
            waPhoneNumberId,
            from: staffWaId,
            text: 'modo auto',
            waMessageId: `scenario-persona-${Date.now()}-4`,
            timestamp: Math.floor(Date.now() / 1000),
            profileName: 'Scenario Staff',
            media: null,
            rawPayload: { simulated: true, scenario: 'role_switch_mode' },
            config: configOverride as any,
          } as any).catch(() => ({ conversationId: '' }));

          const overrideCleared = await prisma.conversation
            .findFirst({
              where: { workspaceId: wsId, phoneLineId: lineId, contact: { waId: staffWaId }, activePersonaKind: { not: null } } as any,
              select: { id: true },
            })
            .catch(() => null);
          assertions.push({
            ok: !overrideCleared?.id,
            message: !overrideCleared?.id ? 'personaSwitch: modo auto limpia override OK' : 'personaSwitch: override sigue activo',
          });

          // Cleanup: archive-only.
          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const notificationTemplateVarsRender = (step.expect as any)?.notificationTemplateVarsRender;
      if (notificationTemplateVarsRender && typeof notificationTemplateVarsRender === 'object') {
        const wsId = String((notificationTemplateVarsRender as any)?.workspaceId || 'scenario-notification-vars').trim() || 'scenario-notification-vars';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'notificationTemplateVarsRender: userId missing' });
        } else {
          const staffE164 = '+56982345846';
          const staffWaId = '56982345846';
          const partnerE164 = '+56994830202';
          const partnerWaId = '56994830202';
          const lineId = `${wsId}-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Notification Vars', isSandbox: true, archivedAt: null, partnerPhoneE164sJson: JSON.stringify([partnerE164]) } as any,
              update: { name: 'Scenario Notification Vars', isSandbox: true, archivedAt: null, partnerPhoneE164sJson: JSON.stringify([partnerE164]) } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});
          const phoneLine = await prisma.phoneLine
            .create({
              data: { id: lineId, workspaceId: wsId, alias: 'Scenario Notification Vars (temp)', phoneE164: null, waPhoneNumberId, isActive: true, archivedAt: null, needsAttention: false } as any,
              select: { id: true },
            })
            .catch(() => null);

          const staffContact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
              create: { workspaceId: wsId, waId: staffWaId, phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              update: { phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const staffConv = staffContact?.id
            ? await prisma.conversation
                .create({
                  data: { workspaceId: wsId, phoneLineId: phoneLine?.id, contactId: staffContact.id, status: 'OPEN', channel: 'whatsapp', isAdmin: false, aiMode: 'OFF', conversationKind: 'STAFF', conversationStage: 'NUEVO', stageChangedAt: now, archivedAt: null } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          const client = await prisma.contact
            .create({ data: { workspaceId: wsId, displayName: 'Paciente Demo', comuna: 'Providencia', ciudad: 'Santiago', region: 'RM', archivedAt: null } as any, select: { id: true } })
            .catch(() => null);
          const conv = client?.id
            ? await prisma.conversation
                .create({
                  data: { workspaceId: wsId, phoneLineId: phoneLine?.id, contactId: client.id, status: 'NEW', channel: 'system', isAdmin: false, conversationKind: 'CLIENT', conversationStage: 'INTERESADO', stageChangedAt: now, assignedToId: userId, availabilityRaw: 'martes 13:00-15:00', archivedAt: null } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          const rule = conv?.id
            ? await prisma.automationRule
                .create({
                  data: {
                    workspaceId: wsId,
                    name: 'Scenario Notify Staff/Partner',
                    enabled: true,
                    priority: 100,
                    trigger: 'STAGE_CHANGED',
                    conditionsJson: JSON.stringify([{ field: 'conversation.stage', op: 'equals', value: 'INTERESADO' }]),
                    actionsJson: JSON.stringify([
                      { type: 'NOTIFY_STAFF_WHATSAPP', templateText: 'STAFF: {{clientName}} · {{stage}} · {{availability}}', recipients: 'ASSIGNED_TO', dedupePolicy: 'PER_STAGE_CHANGE' },
                      { type: 'NOTIFY_PARTNER_WHATSAPP', templateText: 'PARTNER: {{clientName}} · {{stage}} · {{availability}}', recipients: 'ALL_PARTNERS', dedupePolicy: 'PER_STAGE_CHANGE' },
                    ]),
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          if (!phoneLine?.id || !staffConv?.id || !conv?.id || !rule?.id) {
            assertions.push({ ok: false, message: 'notificationTemplateVarsRender: setup incompleto' });
          } else {
            await runAutomations({ app, workspaceId: wsId, eventType: 'STAGE_CHANGED', conversationId: conv.id, transportMode: 'NULL' });

            const logs = await prisma.notificationLog
              .findMany({
                where: { workspaceId: wsId, sourceConversationId: conv.id, archivedAt: null },
                orderBy: { createdAt: 'asc' },
                select: { targetKind: true, renderedText: true, varsJson: true },
              })
              .catch(() => []);
            const staffLog = logs.find((l) => String(l.targetKind).toUpperCase() === 'STAFF') || null;
            const partnerLog = logs.find((l) => String(l.targetKind).toUpperCase() === 'PARTNER') || null;
            const staffText = String(staffLog?.renderedText || '');
            const partnerText = String(partnerLog?.renderedText || '');

            assertions.push({ ok: Boolean(staffLog && staffText && !staffText.includes('{{')), message: staffText && !staffText.includes('{{') ? 'notification vars: STAFF rendered OK' : 'notification vars: STAFF has placeholders' });
            assertions.push({ ok: Boolean(partnerLog && partnerText && !partnerText.includes('{{')), message: partnerText && !partnerText.includes('{{') ? 'notification vars: PARTNER rendered OK' : 'notification vars: PARTNER has placeholders' });
            assertions.push({ ok: staffText.includes('Paciente Demo') && staffText.includes('martes 13:00-15:00'), message: 'notification vars: STAFF contiene datos clave' });
            assertions.push({ ok: partnerText.includes('Paciente Demo') && partnerText.includes('martes 13:00-15:00'), message: 'notification vars: PARTNER contiene datos clave' });
          }

          // Cleanup: archive-only.
          await prisma.notificationLog.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.automationRule.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.program.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const availabilityConfirmScenario = (step.expect as any)?.availabilityConfirmedPreventsHallucination;
      if (availabilityConfirmScenario && typeof availabilityConfirmScenario === 'object') {
        const wsId = String((availabilityConfirmScenario as any)?.workspaceId || 'scenario-availability-confirm').trim() || 'scenario-availability-confirm';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'availabilityConfirmedPreventsHallucination: userId missing' });
        } else {
          const staffE164 = '+56982345846';
          const staffWaId = '56982345846';
          const lineId = `${wsId}-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Availability Confirm', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Availability Confirm', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
              update: { role: 'OWNER', staffWhatsAppE164: staffE164, archivedAt: null } as any,
            })
            .catch(() => {});
          const phoneLine = await prisma.phoneLine
            .create({
              data: { id: lineId, workspaceId: wsId, alias: 'Scenario Availability (temp)', phoneE164: null, waPhoneNumberId, isActive: true, archivedAt: null, needsAttention: false } as any,
              select: { id: true },
            })
            .catch(() => null);

          const staffContact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: staffWaId } } as any,
              create: { workspaceId: wsId, waId: staffWaId, phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              update: { phone: staffE164, displayName: 'Scenario Staff', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const staffConv = staffContact?.id
            ? await prisma.conversation
                .create({
                  data: { workspaceId: wsId, phoneLineId: phoneLine?.id, contactId: staffContact.id, status: 'OPEN', channel: 'whatsapp', isAdmin: false, aiMode: 'OFF', conversationKind: 'STAFF', conversationStage: 'NUEVO', stageChangedAt: now, archivedAt: null } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          const client = await prisma.contact
            .create({ data: { workspaceId: wsId, displayName: 'Paciente Demo', archivedAt: null } as any, select: { id: true } })
            .catch(() => null);
          const conv = client?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: phoneLine?.id,
                    contactId: client.id,
                    status: 'NEW',
                    channel: 'system',
                    isAdmin: false,
                    conversationKind: 'CLIENT',
                    conversationStage: 'INTERESADO',
                    stageChangedAt: now,
                    assignedToId: userId,
                    availabilityRaw: 'MARTES 13:00-15:00',
                    availabilityParsedJson: JSON.stringify({ day: 'JUEVES', timeRange: '09:00-10:00' }),
                    availabilityConfirmedAt: null,
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          const rule = conv?.id
            ? await prisma.automationRule
                .create({
                  data: {
                    workspaceId: wsId,
                    name: 'Scenario Availability Confirm',
                    enabled: true,
                    priority: 100,
                    trigger: 'STAGE_CHANGED',
                    conditionsJson: JSON.stringify([{ field: 'conversation.stage', op: 'equals', value: 'INTERESADO' }]),
                    actionsJson: JSON.stringify([{ type: 'NOTIFY_STAFF_WHATSAPP', templateText: 'Disponibilidad={{availability}}', recipients: 'ASSIGNED_TO' }]),
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          if (!staffConv?.id || !conv?.id || !rule?.id) {
            assertions.push({ ok: false, message: 'availabilityConfirmedPreventsHallucination: setup incompleto' });
          } else {
            await runAutomations({ app, workspaceId: wsId, eventType: 'STAGE_CHANGED', conversationId: conv.id, transportMode: 'NULL' });
            const log = await prisma.notificationLog
              .findFirst({
                where: { workspaceId: wsId, sourceConversationId: conv.id, targetKind: 'STAFF', archivedAt: null },
                orderBy: { createdAt: 'desc' },
                select: { renderedText: true },
              })
              .catch(() => null);
            const rendered = String(log?.renderedText || '');
            assertions.push({
              ok: rendered.includes('MARTES 13:00-15:00'),
              message: rendered.includes('MARTES 13:00-15:00') ? 'availability gating: usa availabilityRaw OK' : 'availability gating: no usa availabilityRaw',
            });
            assertions.push({
              ok: !rendered.includes('JUEVES 09:00-10:00') && !rendered.includes('JUEVES'),
              message: !rendered.includes('JUEVES') ? 'availability gating: NO usa availabilityParsed sin confirmación' : 'availability gating: usó availabilityParsed sin confirmación',
            });
          }

          // Cleanup: archive-only.
          await prisma.notificationLog.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.automationRule.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.program.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const stageAdminConfigurable = (step.expect as any)?.stageAdminConfigurable;
      if (stageAdminConfigurable && typeof stageAdminConfigurable === 'object') {
        const wsId = String((stageAdminConfigurable as any)?.workspaceId || 'scenario-stage-config').trim() || 'scenario-stage-config';
        const slugRaw = String((stageAdminConfigurable as any)?.slug || 'PREPARANDO_ENVIO').trim();
        const slug = slugRaw
          .replace(/\s+/g, '_')
          .replace(/-+/g, '_')
          .replace(/__+/g, '_')
          .toUpperCase()
          .slice(0, 64);
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'stageAdminConfigurable: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'stageAdminConfigurable: auth header missing' });
        } else if (!slug) {
          assertions.push({ ok: false, message: 'stageAdminConfigurable: slug missing' });
        } else {
          const lineId = `${wsId}-line`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Stage Config', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Stage Config', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.phoneLine
            .upsert({
              where: { id: lineId },
              create: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Stage',
                phoneE164: null,
                waPhoneNumberId,
                wabaId: null,
                defaultProgramId: null,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              update: {
                workspaceId: wsId,
                alias: 'Scenario Stage',
                phoneE164: null,
                waPhoneNumberId,
                wabaId: null,
                defaultProgramId: null,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
            })
            .catch(() => {});

          const createStageRes = await app.inject({
            method: 'POST',
            url: '/api/workspaces/current/stages',
            headers: { authorization: authHeader, 'x-workspace-id': wsId },
            payload: { slug, labelEs: 'Preparando envío', order: 55 },
          });
          const createOk = createStageRes.statusCode === 200 || createStageRes.statusCode === 409;
          assertions.push({
            ok: createOk,
            message: createOk
              ? `stageAdminConfigurable: create stage ${slug} OK (${createStageRes.statusCode})`
              : `stageAdminConfigurable: create stage failed (${createStageRes.statusCode})`,
          });

          const contactWaId = `sandbox-stage-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
          const contact = await prisma.contact
            .create({
              data: { workspaceId: wsId, waId: contactWaId, displayName: 'Scenario Stage Contact', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const conv = contact?.id
            ? await prisma.conversation
                .create({
                  data: {
                    workspaceId: wsId,
                    phoneLineId: lineId,
                    programId: null,
                    contactId: contact.id,
                    status: 'NEW',
                    conversationStage: 'NEW_INTAKE',
                    channel: 'system',
                    isAdmin: false,
                    archivedAt: null,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;

          if (!conv?.id) {
            assertions.push({ ok: false, message: 'stageAdminConfigurable: no se pudo crear conversación' });
          } else {
            const patchRes = await app.inject({
              method: 'PATCH',
              url: `/api/conversations/${conv.id}/stage`,
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
              payload: { stage: slug, reason: 'scenario' },
            });
            const patchOk = patchRes.statusCode === 200;
            assertions.push({
              ok: patchOk,
              message: patchOk ? 'stageAdminConfigurable: PATCH conversation stage OK' : `stageAdminConfigurable: PATCH failed (${patchRes.statusCode})`,
            });

            const updated = await prisma.conversation
              .findUnique({ where: { id: conv.id }, select: { conversationStage: true } })
              .catch(() => null);
            const stageOk = String(updated?.conversationStage || '') === slug;
            assertions.push({
              ok: stageOk,
              message: stageOk
                ? `stageAdminConfigurable: conversation stage set OK (${slug})`
                : `stageAdminConfigurable: expected stage=${slug}, got ${String(updated?.conversationStage || '—')}`,
            });

            // Cleanup: archive-only.
            await prisma.conversation.updateMany({ where: { id: conv.id }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.contact.updateMany({ where: { id: contact?.id || '' }, data: { archivedAt: now } as any }).catch(() => {});
          }

          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { isActive: false, archivedAt: now } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const stageCrud = (step.expect as any)?.stageDefinitionsCrudBasic;
      if (stageCrud && typeof stageCrud === 'object') {
        const wsId = String((stageCrud as any)?.workspaceId || 'scenario-stage-crud').trim() || 'scenario-stage-crud';
        const slugRaw = String((stageCrud as any)?.slug || 'PREPARANDO_ENVIO').trim();
        const slug = slugRaw
          .replace(/\s+/g, '_')
          .replace(/-+/g, '_')
          .replace(/__+/g, '_')
          .toUpperCase()
          .slice(0, 64);
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const now = new Date();

        if (!userId) {
          assertions.push({ ok: false, message: 'stageDefinitionsCrudBasic: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'stageDefinitionsCrudBasic: auth header missing' });
        } else if (!slug) {
          assertions.push({ ok: false, message: 'stageDefinitionsCrudBasic: slug missing' });
        } else {
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Stage CRUD', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Stage CRUD', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const createRes = await app.inject({
            method: 'POST',
            url: '/api/workspaces/current/stages',
            headers: { authorization: authHeader, 'x-workspace-id': wsId },
            payload: { slug, labelEs: 'Preparando envío', order: 55, isDefault: false },
          });
          const createOk = createRes.statusCode === 200 || createRes.statusCode === 409;
          assertions.push({
            ok: createOk,
            message: createOk ? `stageDefinitionsCrudBasic: create OK (${createRes.statusCode})` : `stageDefinitionsCrudBasic: create failed (${createRes.statusCode})`,
          });

          const listRes = await app.inject({
            method: 'GET',
            url: '/api/workspaces/current/stages?includeArchived=true',
            headers: { authorization: authHeader, 'x-workspace-id': wsId },
          });
          let listJson: any = null;
          try {
            listJson = JSON.parse(String(listRes.body || ''));
          } catch {
            listJson = null;
          }
          const stages = Array.isArray(listJson?.stages) ? listJson.stages : [];
          const target = stages.find((s: any) => String(s?.slug || '') === slug) || null;
          assertions.push({ ok: Boolean(target?.id), message: target?.id ? 'stageDefinitionsCrudBasic: stage exists' : 'stageDefinitionsCrudBasic: stage missing' });

          if (target?.id) {
            const setDefaultRes = await app.inject({
              method: 'PATCH',
              url: `/api/workspaces/current/stages/${encodeURIComponent(String(target.id))}`,
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
              payload: { isDefault: true, order: 5 },
            });
            assertions.push({
              ok: setDefaultRes.statusCode === 200,
              message: setDefaultRes.statusCode === 200 ? 'stageDefinitionsCrudBasic: set default OK' : `stageDefinitionsCrudBasic: set default failed (${setDefaultRes.statusCode})`,
            });

            const afterRes = await app.inject({
              method: 'GET',
              url: '/api/workspaces/current/stages?includeArchived=false',
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
            });
            let afterJson: any = null;
            try {
              afterJson = JSON.parse(String(afterRes.body || ''));
            } catch {
              afterJson = null;
            }
            const afterStages = Array.isArray(afterJson?.stages) ? afterJson.stages : [];
            const defaults = afterStages.filter((s: any) => Boolean(s?.isDefault));
            const singleDefault = defaults.length === 1;
            assertions.push({
              ok: singleDefault,
              message: singleDefault ? 'stageDefinitionsCrudBasic: 1 default OK' : `stageDefinitionsCrudBasic: expected 1 default, got ${defaults.length}`,
            });
            const defaultSlug = String(defaults[0]?.slug || '');
            assertions.push({
              ok: singleDefault && defaultSlug === slug,
              message: singleDefault && defaultSlug === slug ? `stageDefinitionsCrudBasic: default=${slug} OK` : `stageDefinitionsCrudBasic: default mismatch (${defaultSlug || '—'})`,
            });
          }

          // Cleanup: archive-only.
          await prisma.workspaceStage.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const importPeonetaBatchNoSend = (step.expect as any)?.importPeonetaBatchNoSend;
      if (importPeonetaBatchNoSend && typeof importPeonetaBatchNoSend === 'object') {
        const wsId = String((importPeonetaBatchNoSend as any)?.workspaceId || 'scenario-import-peoneta').trim() || 'scenario-import-peoneta';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'importPeonetaBatchNoSend: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'importPeonetaBatchNoSend: auth header missing' });
        } else {
          const lineId = `scenario-import-peoneta-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          const phoneSeedA = `5699${Math.floor(1000000 + Math.random() * 8999999)}`;
          const phoneSeedB = `5699${Math.floor(1000000 + Math.random() * 8999999)}`;

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Import Peoneta', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Import Peoneta', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const programConductor = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'reclutamiento-conductores-scenario' } } as any,
              create: {
                workspaceId: wsId,
                name: 'Reclutamiento — Conductores (Scenario)',
                slug: 'reclutamiento-conductores-scenario',
                description: 'Scenario program conductor',
                agentSystemPrompt: 'Programa de escenario para conductores.',
                isActive: true,
                archivedAt: null,
              } as any,
              update: { isActive: true, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const programPeoneta = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'reclutamiento-peonetas-scenario' } } as any,
              create: {
                workspaceId: wsId,
                name: 'Reclutamiento — Peonetas (Scenario)',
                slug: 'reclutamiento-peonetas-scenario',
                description: 'Scenario program peoneta',
                agentSystemPrompt: 'Programa de escenario para peonetas.',
                isActive: true,
                archivedAt: null,
              } as any,
              update: { isActive: true, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);

          await prisma.workspace
            .updateMany({
              where: { id: wsId },
              data: {
                clientDefaultProgramId: programConductor?.id || null,
                templateRecruitmentStartName: 'enviorapido_postulacion_inicio_v1',
                templatePeonetaStartName: 'enviorapido_postulacion_general_v1',
              } as any,
            })
            .catch(() => {});

          await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Import Peoneta (temp)',
                waPhoneNumberId,
                isActive: true,
                defaultProgramId: programConductor?.id || null,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          const csv = [
            'telefono,nombre,rol,canal,comuna,estado',
            `${phoneSeedA},Andrés Peña,Peoneta,Chiletrabajos,Pudahuel,NUEVO`,
            `+${phoneSeedA},Andrés Peña,Peoneta,Chiletrabajos,Pudahuel,NUEVO`,
            `${phoneSeedB},Nicolás Ramírez,peoneta,LinkedIn,Maipú,NUEVO`,
          ].join('\n');
          const importRes = await app.inject({
            method: 'POST',
            url: '/api/candidates/import',
            headers: { authorization: authHeader, 'x-workspace-id': wsId },
            payload: {
              fileName: 'scenario_peoneta.csv',
              mimeType: 'text/csv',
              fileBase64: Buffer.from(csv, 'utf8').toString('base64'),
              preserveExistingConversationStage: true,
            },
          });
          let importJson: any = null;
          try {
            importJson = JSON.parse(String(importRes.body || '{}'));
          } catch {
            importJson = null;
          }
          assertions.push({
            ok: importRes.statusCode === 200,
            message: importRes.statusCode === 200
              ? 'importPeonetaBatchNoSend: import OK'
              : `importPeonetaBatchNoSend: import failed (${importRes.statusCode})`,
          });

          const importBatchId = String(importJson?.importBatchId || '').trim();
          const dedupeOk = Number(importJson?.dedupedRows || 0) >= 1 && Number(importJson?.createdContacts || 0) >= 2;
          assertions.push({
            ok: dedupeOk,
            message: dedupeOk
              ? `importPeonetaBatchNoSend: dedupe E.164 OK (deduped=${Number(importJson?.dedupedRows || 0)})`
              : `importPeonetaBatchNoSend: dedupe inesperado (${String(importRes.body || '').slice(0, 240)})`,
          });

          if (importBatchId) {
            const importedContacts = await prisma.contact.findMany({
              where: { workspaceId: wsId, importBatchId, archivedAt: null },
              select: { id: true, phone: true, jobRole: true },
            });
            const contactIds = importedContacts.map((c) => c.id);
            const convs = contactIds.length
              ? await prisma.conversation.findMany({
                  where: { workspaceId: wsId, contactId: { in: contactIds }, archivedAt: null, isAdmin: false } as any,
                  select: { id: true, programId: true, conversationStage: true, status: true },
                })
              : [];
            const outboundCount = await prisma.outboundMessageLog
              .count({ where: { workspaceId: wsId, conversationId: { in: convs.map((c) => c.id) } } as any })
              .catch(() => 0);
            const allPeoneta = importedContacts.length > 0 && importedContacts.every((c) => String(c.jobRole || '').toUpperCase() === 'PEONETA');
            const allProgramPeoneta =
              convs.length > 0 &&
              Boolean(programPeoneta?.id) &&
              convs.every((c) => String(c.programId || '') === String(programPeoneta?.id || ''));
            const distinctProgramIds = Array.from(new Set(convs.map((c) => String(c.programId || '')))).filter(Boolean);
            assertions.push({
              ok: importedContacts.length === 2,
              message:
                importedContacts.length === 2
                  ? 'importPeonetaBatchNoSend: contactos importados (2) OK'
                  : `importPeonetaBatchNoSend: expected 2 contactos, got ${importedContacts.length}`,
            });
            assertions.push({
              ok: allPeoneta,
              message: allPeoneta ? 'importPeonetaBatchNoSend: jobRole=PEONETA OK' : 'importPeonetaBatchNoSend: jobRole inesperado',
            });
            assertions.push({
              ok: allProgramPeoneta,
              message: allProgramPeoneta
                ? 'importPeonetaBatchNoSend: Program Peonetas asignado OK'
                : `importPeonetaBatchNoSend: program mapping incorrecto (expected=${String(programPeoneta?.id || '—')}, got=${distinctProgramIds.join('|') || '—'})`,
            });
            assertions.push({
              ok: outboundCount === 0,
              message:
                outboundCount === 0
                  ? 'importPeonetaBatchNoSend: sin envíos WhatsApp en import OK'
                  : `importPeonetaBatchNoSend: outbound inesperado (${outboundCount})`,
            });

            await prisma.conversation.updateMany({ where: { id: { in: convs.map((c) => c.id) } }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.contact.updateMany({ where: { id: { in: importedContacts.map((c) => c.id) } }, data: { archivedAt: now } as any }).catch(() => {});
          } else {
            assertions.push({ ok: false, message: 'importPeonetaBatchNoSend: importBatchId missing' });
          }

          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { isActive: false, archivedAt: now } as any }).catch(() => {});
          await prisma.program.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const bulkTemplateBatchSend = (step.expect as any)?.bulkTemplateBatchSend;
      if (bulkTemplateBatchSend && typeof bulkTemplateBatchSend === 'object') {
        const wsId = String((bulkTemplateBatchSend as any)?.workspaceId || 'scenario-bulk-template-batch').trim() || 'scenario-bulk-template-batch';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'bulkTemplateBatchSend: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'bulkTemplateBatchSend: auth header missing' });
        } else {
          const lineId = `scenario-bulk-template-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          const phoneA = `5699${Math.floor(1000000 + Math.random() * 8999999)}`;
          const phoneB = `5699${Math.floor(1000000 + Math.random() * 8999999)}`;

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Bulk Template Batch', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Bulk Template Batch', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const programConductor = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'reclutamiento-conductores-scenario' } } as any,
              create: {
                workspaceId: wsId,
                name: 'Reclutamiento — Conductores (Scenario)',
                slug: 'reclutamiento-conductores-scenario',
                description: 'Scenario program conductor',
                agentSystemPrompt: 'Programa de escenario para conductores.',
                isActive: true,
                archivedAt: null,
              } as any,
              update: { isActive: true, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const programPeoneta = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'reclutamiento-peonetas-scenario' } } as any,
              create: {
                workspaceId: wsId,
                name: 'Reclutamiento — Peonetas (Scenario)',
                slug: 'reclutamiento-peonetas-scenario',
                description: 'Scenario program peoneta',
                agentSystemPrompt: 'Programa de escenario para peonetas.',
                isActive: true,
                archivedAt: null,
              } as any,
              update: { isActive: true, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);

          await prisma.workspace
            .updateMany({
              where: { id: wsId },
              data: {
                clientDefaultProgramId: programConductor?.id || null,
                templateRecruitmentStartName: 'enviorapido_postulacion_inicio_v1',
                templatePeonetaStartName: 'enviorapido_postulacion_general_v1',
              } as any,
            })
            .catch(() => {});

          await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Bulk Template (temp)',
                waPhoneNumberId,
                isActive: true,
                defaultProgramId: programConductor?.id || null,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);

          const csv = [
            'telefono,nombre,rol,canal,comuna,estado',
            `${phoneA},Juan Conductor,Conductor,Chiletrabajos,Puente Alto,NUEVO`,
            `${phoneB},María Peoneta,Peoneta,Chiletrabajos,La Florida,NUEVO`,
          ].join('\n');

          const importRes = await app.inject({
            method: 'POST',
            url: '/api/candidates/import',
            headers: { authorization: authHeader, 'x-workspace-id': wsId },
            payload: {
              fileName: 'scenario_bulk_template.csv',
              mimeType: 'text/csv',
              fileBase64: Buffer.from(csv, 'utf8').toString('base64'),
              preserveExistingConversationStage: true,
            },
          });
          let importJson: any = null;
          try {
            importJson = JSON.parse(String(importRes.body || '{}'));
          } catch {
            importJson = null;
          }
          const importBatchId = String(importJson?.importBatchId || '').trim();
          assertions.push({
            ok: importRes.statusCode === 200 && !!importBatchId,
            message:
              importRes.statusCode === 200 && !!importBatchId
                ? `bulkTemplateBatchSend: import OK (${importBatchId})`
                : `bulkTemplateBatchSend: import failed (${importRes.statusCode})`,
          });

          if (importBatchId) {
            const previewRes = await app.inject({
              method: 'POST',
              url: '/api/candidates/import/bulk-template/preview',
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
              payload: {
                importBatchId,
                templateByRole: {
                  CONDUCTOR: 'enviorapido_postulacion_inicio_v1',
                  PEONETA: 'enviorapido_postulacion_general_v1',
                },
              },
            });
            let previewJson: any = null;
            try {
              previewJson = JSON.parse(String(previewRes.body || '{}'));
            } catch {
              previewJson = null;
            }
            const previewOk = previewRes.statusCode === 200 && Number(previewJson?.totals?.eligible || 0) >= 2;
            assertions.push({
              ok: previewOk,
              message: previewOk
                ? `bulkTemplateBatchSend: dry-run OK (eligible=${Number(previewJson?.totals?.eligible || 0)})`
                : `bulkTemplateBatchSend: dry-run failed (${previewRes.statusCode})`,
            });

            const dryRunHash = String(previewJson?.dryRunHash || '').trim();
            const sendRes = await app.inject({
              method: 'POST',
              url: '/api/candidates/import/bulk-template/send',
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
              payload: {
                importBatchId,
                templateByRole: {
                  CONDUCTOR: 'enviorapido_postulacion_inicio_v1',
                  PEONETA: 'enviorapido_postulacion_general_v1',
                },
                confirmText: 'CONFIRMAR',
                dryRunHash,
                transportMode: 'NULL',
              },
            });
            let sendJson: any = null;
            try {
              sendJson = JSON.parse(String(sendRes.body || '{}'));
            } catch {
              sendJson = null;
            }
            const sendOk = sendRes.statusCode === 200 && Number(sendJson?.totals?.sent || 0) >= 2;
            assertions.push({
              ok: sendOk,
              message: sendOk
                ? `bulkTemplateBatchSend: send OK (sent=${Number(sendJson?.totals?.sent || 0)})`
                : `bulkTemplateBatchSend: send failed (${sendRes.statusCode})`,
            });

            const importedContacts = await prisma.contact.findMany({
              where: { workspaceId: wsId, importBatchId, archivedAt: null },
              select: { id: true },
            });
            const convs = importedContacts.length
              ? await prisma.conversation.findMany({
                  where: { workspaceId: wsId, contactId: { in: importedContacts.map((c) => c.id) }, archivedAt: null, isAdmin: false } as any,
                  select: { id: true, conversationStage: true, status: true },
                })
              : [];
            const outboundLogs = convs.length
              ? await prisma.outboundMessageLog.findMany({
                  where: {
                    workspaceId: wsId,
                    conversationId: { in: convs.map((c) => c.id) },
                    type: 'TEMPLATE',
                    dedupeKey: { contains: `bulk_import_template:${importBatchId}` },
                  } as any,
                  select: { id: true, blockedReason: true, templateName: true },
                })
              : [];
            const noBlocked = outboundLogs.every((l) => !l.blockedReason);
            const stageMoved = convs.length > 0 && convs.every((c) => String(c.conversationStage || '').toUpperCase() === 'SCREENING');
            assertions.push({
              ok: outboundLogs.length >= 2 && noBlocked,
              message:
                outboundLogs.length >= 2 && noBlocked
                  ? 'bulkTemplateBatchSend: outbound logs template OK'
                  : `bulkTemplateBatchSend: outbound logs inválidos (${outboundLogs.length})`,
            });
            assertions.push({
              ok: stageMoved,
              message: stageMoved
                ? 'bulkTemplateBatchSend: transición stage NEW_INTAKE->SCREENING OK'
                : 'bulkTemplateBatchSend: stage no actualizado a SCREENING',
            });

            await prisma.conversation.updateMany({ where: { id: { in: convs.map((c) => c.id) } }, data: { archivedAt: now } as any }).catch(() => {});
            await prisma.contact.updateMany({ where: { id: { in: importedContacts.map((c) => c.id) } }, data: { archivedAt: now } as any }).catch(() => {});
          }

          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { isActive: false, archivedAt: now } as any }).catch(() => {});
          await prisma.program.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const inboxTodosStageJobroleConsistency = (step.expect as any)?.inboxTodosStageJobroleConsistency;
      if (inboxTodosStageJobroleConsistency && typeof inboxTodosStageJobroleConsistency === 'object') {
        const wsId =
          String((inboxTodosStageJobroleConsistency as any)?.workspaceId || 'scenario-inbox-todos-jobrole').trim() ||
          'scenario-inbox-todos-jobrole';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'inboxTodosStageJobroleConsistency: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'inboxTodosStageJobroleConsistency: auth header missing' });
        } else {
          const lineId = `scenario-inbox-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Inbox Todos/JobRole', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Inbox Todos/JobRole', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const programConductor = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'reclutamiento-conductores-scenario' } } as any,
              create: {
                workspaceId: wsId,
                name: 'Reclutamiento — Conductores (Scenario)',
                slug: 'reclutamiento-conductores-scenario',
                description: 'Scenario program conductor',
                agentSystemPrompt: 'Programa de escenario para conductores.',
                isActive: true,
                archivedAt: null,
              } as any,
              update: { isActive: true, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const programPeoneta = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'reclutamiento-peonetas-scenario' } } as any,
              create: {
                workspaceId: wsId,
                name: 'Reclutamiento — Peonetas (Scenario)',
                slug: 'reclutamiento-peonetas-scenario',
                description: 'Scenario program peoneta',
                agentSystemPrompt: 'Programa de escenario para peonetas.',
                isActive: true,
                archivedAt: null,
              } as any,
              update: { isActive: true, archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);

          await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Inbox (temp)',
                waPhoneNumberId,
                isActive: true,
                defaultProgramId: programConductor?.id || null,
                archivedAt: null,
                needsAttention: false,
              } as any,
            })
            .catch(() => {});

          const contactConductor = await prisma.contact.create({
            data: {
              workspaceId: wsId,
              waId: `scenario-conductor-${Date.now()}`,
              phone: '+56970000001',
              candidateName: 'Carlos Conductor',
              jobRole: 'CONDUCTOR' as any,
              archivedAt: null,
            } as any,
          });
          const contactPeoneta = await prisma.contact.create({
            data: {
              workspaceId: wsId,
              waId: `scenario-peoneta-${Date.now()}`,
              phone: '+56970000002',
              candidateName: 'Pedro Peoneta',
              jobRole: 'PEONETA' as any,
              archivedAt: null,
            } as any,
          });
          const contactOther = await prisma.contact.create({
            data: {
              workspaceId: wsId,
              waId: `scenario-other-${Date.now()}`,
              phone: '+56970000003',
              candidateName: 'Andrea Operaciones',
              jobRole: 'CONDUCTOR' as any,
              archivedAt: null,
            } as any,
          });

          const convA = await prisma.conversation.create({
            data: {
              workspaceId: wsId,
              phoneLineId: lineId,
              contactId: contactConductor.id,
              status: 'NEW',
              channel: 'whatsapp',
              isAdmin: false,
              conversationStage: 'DOCS_PENDING',
              programId: programConductor?.id || null,
              archivedAt: null,
            } as any,
          });
          const convB = await prisma.conversation.create({
            data: {
              workspaceId: wsId,
              phoneLineId: lineId,
              contactId: contactPeoneta.id,
              status: 'OPEN',
              channel: 'whatsapp',
              isAdmin: false,
              conversationStage: 'BACKGROUND_CHECK',
              programId: programPeoneta?.id || null,
              archivedAt: null,
            } as any,
          });
          const convC = await prisma.conversation.create({
            data: {
              workspaceId: wsId,
              phoneLineId: lineId,
              contactId: contactOther.id,
              status: 'OPEN',
              channel: 'whatsapp',
              isAdmin: false,
              conversationStage: 'SCREENING',
              programId: programConductor?.id || null,
              archivedAt: null,
            } as any,
          });

          await prisma.message.createMany({
            data: [
              { conversationId: convA.id, direction: 'INBOUND', text: 'Tengo documentos listos', read: false, timestamp: new Date() } as any,
              { conversationId: convB.id, direction: 'INBOUND', text: 'Estoy en revisión', read: false, timestamp: new Date() } as any,
              { conversationId: convC.id, direction: 'INBOUND', text: 'Sigo en screening', read: false, timestamp: new Date() } as any,
            ],
          });

          const listAll = await app.inject({
            method: 'GET',
            url: '/api/conversations?viewKey=ALL',
            headers: { authorization: authHeader, 'x-workspace-id': wsId },
          });
          let listAllJson: any = null;
          try {
            listAllJson = JSON.parse(String(listAll.body || '[]'));
          } catch {
            listAllJson = [];
          }
          const rowsAll = Array.isArray(listAllJson) ? listAllJson : [];
          const allIds = new Set(rowsAll.map((r: any) => String(r?.id || '')));
          const allHasWeirdStages = allIds.has(convA.id) && allIds.has(convB.id);
          assertions.push({
            ok: listAll.statusCode === 200 && allHasWeirdStages,
            message:
              listAll.statusCode === 200 && allHasWeirdStages
                ? 'inboxTodosStageJobroleConsistency: view=ALL incluye stages no mapeados'
                : `inboxTodosStageJobroleConsistency: view=ALL no incluye casos esperados (status=${listAll.statusCode})`,
          });

          const listPeoneta = await app.inject({
            method: 'GET',
            url: '/api/conversations?viewKey=ALL&jobRole=PEONETA',
            headers: { authorization: authHeader, 'x-workspace-id': wsId },
          });
          let listPeonetaJson: any = null;
          try {
            listPeonetaJson = JSON.parse(String(listPeoneta.body || '[]'));
          } catch {
            listPeonetaJson = [];
          }
          const peonetaRows = Array.isArray(listPeonetaJson) ? listPeonetaJson : [];
          const onlyPeoneta = peonetaRows.length > 0 && peonetaRows.every((r: any) => String(r?.contact?.jobRole || '').toUpperCase() === 'PEONETA');
          assertions.push({
            ok: listPeoneta.statusCode === 200 && onlyPeoneta,
            message:
              listPeoneta.statusCode === 200 && onlyPeoneta
                ? 'inboxTodosStageJobroleConsistency: filtro jobRole=PEONETA OK'
                : `inboxTodosStageJobroleConsistency: filtro jobRole falló (status=${listPeoneta.statusCode}, rows=${peonetaRows.length})`,
          });

          const listByStage = await app.inject({
            method: 'GET',
            url: '/api/conversations?viewKey=ALL&stage=DOCS_PENDING',
            headers: { authorization: authHeader, 'x-workspace-id': wsId },
          });
          let listByStageJson: any = null;
          try {
            listByStageJson = JSON.parse(String(listByStage.body || '[]'));
          } catch {
            listByStageJson = [];
          }
          const stageRows = Array.isArray(listByStageJson) ? listByStageJson : [];
          const stageContainsA = stageRows.some((r: any) => String(r?.id || '') === convA.id);
          assertions.push({
            ok: listByStage.statusCode === 200 && stageContainsA,
            message:
              listByStage.statusCode === 200 && stageContainsA
                ? 'inboxTodosStageJobroleConsistency: filtro stage en view=ALL OK'
                : `inboxTodosStageJobroleConsistency: filtro stage falló (status=${listByStage.statusCode})`,
          });

          const listSearch = await app.inject({
            method: 'GET',
            url: `/api/conversations?q=${encodeURIComponent(contactPeoneta.phone || '')}`,
            headers: { authorization: authHeader, 'x-workspace-id': wsId },
          });
          let listSearchJson: any = null;
          try {
            listSearchJson = JSON.parse(String(listSearch.body || '[]'));
          } catch {
            listSearchJson = [];
          }
          const searchRows = Array.isArray(listSearchJson) ? listSearchJson : [];
          const searchFound = searchRows.some((r: any) => String(r?.id || '') === convB.id);
          assertions.push({
            ok: listSearch.statusCode === 200 && searchFound,
            message:
              listSearch.statusCode === 200 && searchFound
                ? 'inboxTodosStageJobroleConsistency: búsqueda global por teléfono OK'
                : `inboxTodosStageJobroleConsistency: búsqueda global falló (status=${listSearch.statusCode})`,
          });

          await prisma.conversation.updateMany({ where: { id: { in: [convA.id, convB.id, convC.id] } }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { id: { in: [contactConductor.id, contactPeoneta.id, contactOther.id] } }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { isActive: false, archivedAt: now } as any }).catch(() => {});
          await prisma.program.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const clientLocationFreeText =
        (step.expect as any)?.clientLocationFreeText || (step.expect as any)?.clientFreeTextFields;
      const candidateIntakeChooseRole = (step.expect as any)?.candidateIntakeChooseRole;
      const conductorEmpresaCleanFlow = (step.expect as any)?.conductorEmpresaCleanFlow;
      const conductorVehiculoCleanFlow = (step.expect as any)?.conductorVehiculoCleanFlow;
      const peonetaCleanFlow = (step.expect as any)?.peonetaCleanFlow;
      const candidateConductorCollectCvAndDocs =
        (step.expect as any)?.candidateConductorCollectCvAndDocs || conductorVehiculoCleanFlow;
      const candidatePeonetaBasicFlow = (step.expect as any)?.candidatePeonetaBasicFlow || peonetaCleanFlow;
      const postulacionDriverToReadyForOpReview =
        (step.expect as any)?.postulacionDriverToReadyForOpReview || candidateAutoReplyUntilOpReview || conductorEmpresaCleanFlow;
      const postulacionDriverToReadyForOpReviewEmail = (step.expect as any)?.postulacionDriverToReadyForOpReviewEmail;
      const opReviewDownloadPackageOk = (step.expect as any)?.opReviewDownloadPackageOk;
      const opReviewPauseAiAfterReady = (step.expect as any)?.opReviewPauseAiAfterReady;
      const noLegacyCopyLeaks = (step.expect as any)?.noLegacyCopyLeaks;
      const promptLockPreventsSeedOverwrite = (step.expect as any)?.promptLockPreventsSeedOverwrite;
      const programPromptIsEffective = (step.expect as any)?.programPromptIsEffective;
      const assetsPublicDownloadOk = (step.expect as any)?.assetsPublicDownloadOk;
      const runtimeDebugPanelVisible = (step.expect as any)?.runtimeDebugPanelVisible;
      const intakeGreetingStartsFlow = (step.expect as any)?.intakeGreetingStartsFlow;
      if (
        (candidateIntakeChooseRole && typeof candidateIntakeChooseRole === 'object') ||
        (candidateConductorCollectCvAndDocs && typeof candidateConductorCollectCvAndDocs === 'object') ||
        (candidatePeonetaBasicFlow && typeof candidatePeonetaBasicFlow === 'object')
      ) {
        const wsId =
          String(
            (candidateIntakeChooseRole as any)?.workspaceId ||
              (candidateConductorCollectCvAndDocs as any)?.workspaceId ||
              (candidatePeonetaBasicFlow as any)?.workspaceId ||
              'scenario-candidate-flow',
          ).trim() || 'scenario-candidate-flow';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'candidateFlow: userId missing' });
        } else {
          const lineId = `scenario-candidate-flow-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Candidate Flow', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Candidate Flow', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const phoneLine = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Candidate Flow (temp)',
                phoneE164: null,
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const contact = await prisma.contact
            .create({
              data: {
                workspaceId: wsId,
                displayName: 'Scenario Candidato',
                waId: `scenario-candidate-flow-${Date.now()}`,
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const convo =
            phoneLine?.id && contact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: phoneLine.id,
                      contactId: contact.id,
                      status: 'OPEN',
                      channel: 'sandbox',
                      isAdmin: false,
                      conversationKind: 'CLIENT',
                      conversationStage: 'NEW_INTAKE',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

          if (!contact?.id || !convo?.id) {
            assertions.push({ ok: false, message: 'candidateFlow: setup incompleto' });
          } else {
            const run = await prisma.agentRunLog
              .create({
                data: {
                  workspaceId: wsId,
                  conversationId: convo.id,
                  phoneLineId: phoneLine?.id || null,
                  eventType: 'INBOUND_MESSAGE',
                  status: 'RUNNING',
                  inputContextJson: JSON.stringify({ event: { inboundText: 'simulated flow' } }),
                } as any,
                select: { id: true },
              })
              .catch(() => null);
            if (!run?.id) {
              assertions.push({ ok: false, message: 'candidateFlow: no se pudo crear agentRun' });
            } else {
              const flowCfg =
                (candidatePeonetaBasicFlow && typeof candidatePeonetaBasicFlow === 'object'
                  ? candidatePeonetaBasicFlow
                  : candidateConductorCollectCvAndDocs && typeof candidateConductorCollectCvAndDocs === 'object'
                    ? candidateConductorCollectCvAndDocs
                    : {}) as any;
              const roleToSet =
                normalizeApplicationRole(
                  flowCfg.applicationRole || flowCfg.role || (candidatePeonetaBasicFlow ? 'PEONETA' : 'DRIVER_COMPANY'),
                ) || (candidatePeonetaBasicFlow ? 'PEONETA' : 'DRIVER_COMPANY');
              const targetState =
                normalizeApplicationState(
                  flowCfg.applicationState ||
                    flowCfg.state ||
                    (candidateConductorCollectCvAndDocs ? 'READY_FOR_OP_REVIEW' : 'COLLECT_MIN_INFO'),
                ) || (candidateConductorCollectCvAndDocs ? 'READY_FOR_OP_REVIEW' : 'COLLECT_MIN_INFO');
              const commands: any[] = [
                {
                  command: 'SET_APPLICATION_FLOW',
                  conversationId: convo.id,
                  applicationRole: roleToSet,
                  applicationState: targetState,
                },
                {
                  command: 'UPSERT_PROFILE_FIELDS',
                  contactId: contact.id,
                  patch: {
                    comuna: candidatePeonetaBasicFlow ? 'Maipú' : 'Providencia',
                    availabilityText: 'Mañana 10:00-12:00',
                    jobRole: roleToSet,
                  },
                },
              ];

              await executeAgentResponse({
                app,
                workspaceId: wsId,
                agentRunId: run.id,
                response: { agent: 'scenario_candidate_flow', version: 1, commands } as any,
                transportMode: 'NULL',
              }).catch(() => null);

              const convoUpdated = await prisma.conversation
                .findUnique({
                  where: { id: convo.id },
                  select: { applicationRole: true as any, applicationState: true as any, conversationStage: true },
                })
                .catch(() => null);
              const contactUpdated = await prisma.contact
                .findUnique({
                  where: { id: contact.id },
                  select: { comuna: true, jobRole: true },
                })
                .catch(() => null);

              const roleOk = String((convoUpdated as any)?.applicationRole || '').toUpperCase() === roleToSet;
              assertions.push({
                ok: roleOk,
                message: roleOk
                  ? `candidateFlow: applicationRole=${String((convoUpdated as any)?.applicationRole || '')}`
                  : `candidateFlow: role mismatch (${String((convoUpdated as any)?.applicationRole || '—')})`,
              });
              const actualState = String((convoUpdated as any)?.applicationState || '').toUpperCase();
              let stateOk = actualState === targetState;
              if (!stateOk && candidateConductorCollectCvAndDocs && targetState === 'READY_FOR_OP_REVIEW') {
                // En algunos flujos READY_FOR_OP_REVIEW activa inmediatamente WAITING_OP_RESULT.
                stateOk = actualState === 'WAITING_OP_RESULT';
              }
              assertions.push({
                ok: stateOk,
                message: stateOk
                  ? `candidateFlow: applicationState=${String((convoUpdated as any)?.applicationState || '')}`
                  : `candidateFlow: state mismatch (${String((convoUpdated as any)?.applicationState || '—')})`,
              });
              const comunaOk = String((contactUpdated as any)?.comuna || '').trim().length > 0;
              assertions.push({
                ok: comunaOk,
                message: comunaOk
                  ? `candidateFlow: comuna capturada (${String((contactUpdated as any)?.comuna || '')})`
                  : 'candidateFlow: comuna no capturada',
              });
              if (candidateConductorCollectCvAndDocs) {
                const expectedStage =
                  String(
                    flowCfg.expectedStage ||
                      mapApplicationStateToStage({
                        state: normalizeApplicationState(targetState),
                        role: normalizeApplicationRole(roleToSet),
                      }) ||
                      'OP_REVIEW',
                  )
                    .trim()
                    .toUpperCase() || 'OP_REVIEW';
                const stageOk = String((convoUpdated as any)?.conversationStage || '').toUpperCase() === expectedStage;
                assertions.push({
                  ok: stageOk,
                  message: stageOk
                    ? `candidateConductorCollectCvAndDocs: stage ${expectedStage} OK`
                    : `candidateConductorCollectCvAndDocs: stage inválido (${String((convoUpdated as any)?.conversationStage || '—')})`,
                });
              }
              if (candidatePeonetaBasicFlow) {
                const stageNotDriverReview =
                  String((convoUpdated as any)?.conversationStage || '').toUpperCase() !== 'EN_REVISION_OPERACION';
                assertions.push({
                  ok: stageNotDriverReview,
                  message: stageNotDriverReview
                    ? 'candidatePeonetaBasicFlow: no forzó etapa de revisión de conductores'
                    : 'candidatePeonetaBasicFlow: etapa incorrecta para peoneta',
                });
              }
            }
          }

          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      if (
        (postulacionDriverToReadyForOpReviewEmail && typeof postulacionDriverToReadyForOpReviewEmail === 'object') ||
        (postulacionDriverToReadyForOpReview && typeof postulacionDriverToReadyForOpReview === 'object') ||
        (opReviewDownloadPackageOk && typeof opReviewDownloadPackageOk === 'object') ||
        (opReviewPauseAiAfterReady && typeof opReviewPauseAiAfterReady === 'object')
      ) {
        const wsId =
          String(
            (postulacionDriverToReadyForOpReviewEmail as any)?.workspaceId ||
              (postulacionDriverToReadyForOpReview as any)?.workspaceId ||
              (opReviewDownloadPackageOk as any)?.workspaceId ||
              (opReviewPauseAiAfterReady as any)?.workspaceId ||
              'scenario-er-p4-postulacion-review',
          ).trim() ||
          'scenario-er-p4-postulacion-review';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'postulacionDriverToReadyForOpReviewEmail: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'postulacionDriverToReadyForOpReviewEmail: auth header missing' });
        } else {
          const lineId = `scenario-er-p4-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: {
                id: wsId,
                name: 'Scenario ER-P4 Postulación Review',
                isSandbox: true,
                reviewEmailTo: null as any,
                reviewEmailFrom: null as any,
                archivedAt: null,
              } as any,
              update: {
                name: 'Scenario ER-P4 Postulación Review',
                isSandbox: true,
                archivedAt: null,
              } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const phoneLine = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario ER-P4 (temp)',
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const contact = await prisma.contact
            .create({
              data: {
                workspaceId: wsId,
                displayName: 'Juan Pérez',
                waId: `scenario-er-p4-${Date.now()}`,
                candidateName: 'Juan Pérez',
                comuna: 'Providencia',
                availabilityText: 'Mañana entre 10:00 y 12:00',
                experienceYears: 3,
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const convo =
            phoneLine?.id && contact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: phoneLine.id,
                      contactId: contact.id,
                      status: 'OPEN',
                      channel: 'sandbox',
                      isAdmin: false,
                      conversationKind: 'CLIENT',
                      conversationStage: 'DOCS_PENDING',
                      applicationRole: 'DRIVER_COMPANY' as any,
                      applicationState: 'REQUEST_OP_DOCS' as any,
                      applicationDataJson: JSON.stringify({
                        roleIntent: 'DRIVER_COMPANY',
                        comuna: 'Providencia',
                        availability: 'Mañana entre 10:00 y 12:00',
                        experience: '3 años reparto urbano',
                        yearsExperience: 3,
                        hasLicenseB: true,
                        hasParking: true,
                      }),
                      availabilityRaw: 'Mañana entre 10:00 y 12:00',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

          if (!contact?.id || !convo?.id) {
            assertions.push({ ok: false, message: 'postulacionDriverToReadyForOpReviewEmail: setup incompleto' });
          } else {
            const addInboundDoc = async (label: string, fileName: string) => {
              await prisma.message
                .create({
                  data: {
                    conversationId: convo.id,
                    direction: 'INBOUND',
                    text: label,
                    mediaType: 'document',
                    mediaMime: 'application/pdf',
                    mediaPath: `/tmp/${fileName}`,
                    rawPayload: JSON.stringify({
                      simulated: true,
                      scenario: 'postulacion_driver_to_ready_for_op_review_email',
                      attachment: { fileName },
                    }),
                    timestamp: new Date(),
                    read: true,
                  },
                })
                .catch(() => null);
            };
            await addInboundDoc('Adjunto CV actualizado', 'cv_juan_perez.pdf');
            await addInboundDoc('Adjunto carnet frente y reverso', 'carnet_juan_perez.pdf');
            await addInboundDoc('Adjunto licencia clase B', 'licencia_juan_perez.pdf');

            const result = await triggerReadyForOpReview({
              app,
              workspaceId: wsId,
              conversationId: convo.id,
              reason: 'scenario_er_p4',
            }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : 'unknown_error' }));

            const convoUpdated = await prisma.conversation
              .findUnique({
                where: { id: convo.id },
                select: {
                  conversationStage: true,
                  applicationState: true as any,
                  aiPaused: true,
                  opReviewSummarySentAt: true as any,
                  opReviewEmailSentAt: true as any,
                },
              })
              .catch(() => null);
            const summaryMessage = await prisma.message
              .findFirst({
                where: { conversationId: convo.id, isInternalEvent: true as any, text: { contains: 'RESUMEN INTERNO' } as any },
                orderBy: { createdAt: 'desc' },
                select: { id: true, text: true },
              })
              .catch(() => null);
            const emailLog = await prisma.emailOutboundLog
              .findFirst({
                where: { workspaceId: wsId, conversationId: convo.id, channel: 'EMAIL' } as any,
                orderBy: { createdAt: 'desc' },
                select: { id: true, status: true, error: true },
              })
              .catch(() => null);

            const stageOk = String((convoUpdated as any)?.conversationStage || '').toUpperCase() === 'OP_REVIEW';
            const stateOk = String((convoUpdated as any)?.applicationState || '').toUpperCase() === 'WAITING_OP_RESULT';
            const pausedOk = Boolean((convoUpdated as any)?.aiPaused);
            const summaryOk = Boolean(summaryMessage?.id) && /POSTULANTE[\s\S]*DOCUMENTOS[\s\S]*OPERACIÓN\/PAGO/i.test(String(summaryMessage?.text || ''));
            const emailOk = Boolean(emailLog?.id) && ['SENT', 'SKIPPED', 'ERROR'].includes(String(emailLog?.status || '').toUpperCase());
            const cvLinkIncluded = /\/api\/messages\/.+\/download/.test(String(summaryMessage?.text || ''));

            assertions.push({
              ok: (result as any)?.ok !== false,
              message:
                (result as any)?.ok !== false
                  ? 'postulacionDriverToReadyForOpReviewEmail: trigger READY_FOR_OP_REVIEW OK'
                  : `postulacionDriverToReadyForOpReviewEmail: trigger falló (${String((result as any)?.error || 'error')})`,
            });
            assertions.push({
              ok: stageOk && stateOk && pausedOk,
              message:
                stageOk && stateOk && pausedOk
                  ? 'postulacionDriverToReadyForOpReviewEmail: stage=OP_REVIEW + WAITING_OP_RESULT + aiPaused OK'
                  : `postulacionDriverToReadyForOpReviewEmail: transición inválida stage=${String((convoUpdated as any)?.conversationStage || '—')} state=${String((convoUpdated as any)?.applicationState || '—')} paused=${String((convoUpdated as any)?.aiPaused)}`,
            });
            assertions.push({
              ok: summaryOk && cvLinkIncluded,
              message:
                summaryOk && cvLinkIncluded
                  ? 'postulacionDriverToReadyForOpReviewEmail: resumen interno con secciones y links OK'
                  : 'postulacionDriverToReadyForOpReviewEmail: resumen interno incompleto',
            });
            assertions.push({
              ok: emailOk,
              message: emailOk
                ? `postulacionDriverToReadyForOpReviewEmail: email log ${String(emailLog?.status || '—')}`
                : 'postulacionDriverToReadyForOpReviewEmail: faltó EmailOutboundLog',
            });

            if (postulacionDriverToReadyForOpReview && typeof postulacionDriverToReadyForOpReview === 'object') {
              const ok = stageOk && stateOk && summaryOk;
              assertions.push({
                ok,
                message: ok
                  ? 'postulacionDriverToReadyForOpReview: transición a OP_REVIEW + resumen interno OK'
                  : 'postulacionDriverToReadyForOpReview: transición/resumen incompletos',
              });
            }

            if (opReviewPauseAiAfterReady && typeof opReviewPauseAiAfterReady === 'object') {
              assertions.push({
                ok: pausedOk,
                message: pausedOk
                  ? 'opReviewPauseAiAfterReady: aiPaused=true al entrar en OP_REVIEW'
                  : 'opReviewPauseAiAfterReady: faltó pausar IA en OP_REVIEW',
              });
            }

            if (opReviewDownloadPackageOk && typeof opReviewDownloadPackageOk === 'object') {
              const pkgRes = await app.inject({
                method: 'GET',
                url: `/api/op-review/${encodeURIComponent(convo.id)}/package`,
                headers: { authorization: authHeader, 'x-workspace-id': wsId },
              });
              const header = String(pkgRes.headers['content-type'] || '');
              const zipSig = String(pkgRes.rawPayload?.slice(0, 2) || '') === 'PK';
              const ok = pkgRes.statusCode === 200 && header.includes('application/zip') && zipSig;
              assertions.push({
                ok,
                message: ok
                  ? 'opReviewDownloadPackageOk: paquete ZIP descargable OK'
                  : `opReviewDownloadPackageOk: descarga falló (status=${pkgRes.statusCode}, ct=${header})`,
              });
            }
          }

          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      if (
        (docsMissingReactivatesAiAndRequestsExactMissingDocs &&
          typeof docsMissingReactivatesAiAndRequestsExactMissingDocs === 'object') ||
        (acceptedMovesToInterviewPending && typeof acceptedMovesToInterviewPending === 'object') ||
        (rejectedMovesToRejectedAndAiPauses && typeof rejectedMovesToRejectedAndAiPauses === 'object') ||
        (suggestRespectsApplicationState && typeof suggestRespectsApplicationState === 'object') ||
        (conversationPreviewHidesInternalEvents && typeof conversationPreviewHidesInternalEvents === 'object') ||
        (toneNoSlangInAutoAndSuggest && typeof toneNoSlangInAutoAndSuggest === 'object')
      ) {
        const wsId =
          String(
            (docsMissingReactivatesAiAndRequestsExactMissingDocs as any)?.workspaceId ||
              (acceptedMovesToInterviewPending as any)?.workspaceId ||
              (rejectedMovesToRejectedAndAiPauses as any)?.workspaceId ||
              (suggestRespectsApplicationState as any)?.workspaceId ||
              (conversationPreviewHidesInternalEvents as any)?.workspaceId ||
              (toneNoSlangInAutoAndSuggest as any)?.workspaceId ||
              'scenario-er-p6-runtime',
          ).trim() || 'scenario-er-p6-runtime';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'erP6Runtime: userId missing' });
        } else if (!authHeader) {
          assertions.push({ ok: false, message: 'erP6Runtime: auth header missing' });
        } else {
          const lineId = `scenario-er-p6-runtime-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          const contactWaId = `+569${String(Date.now()).slice(-8)}`;

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario ER-P6 Runtime', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario ER-P6 Runtime', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const program = await prisma.program
            .create({
              data: {
                workspaceId: wsId,
                name: 'Scenario ER-P6 Program',
                slug: `scenario-er-p6-program-${Date.now()}`,
                isActive: true,
                agentSystemPrompt:
                  'Eres asistente de reclutamiento en español profesional. Nunca uses modismos/slang.',
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const phoneLine = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario ER-P6 Line',
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const contact = await prisma.contact
            .create({
              data: {
                workspaceId: wsId,
                displayName: 'Scenario ER-P6 Contact',
                waId: contactWaId,
                comuna: 'Providencia',
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const convo =
            phoneLine?.id && contact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: phoneLine.id,
                      contactId: contact.id,
                      programId: program?.id || null,
                      status: 'OPEN',
                      channel: 'sandbox',
                      conversationKind: 'CLIENT',
                      conversationStage: 'OP_REVIEW',
                      applicationRole: 'CONDUCTOR' as any,
                      applicationState: 'WAITING_OP_RESULT' as any,
                      aiPaused: true,
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

          if (!convo?.id || !program?.id || !phoneLine?.id || !contact?.id) {
            assertions.push({ ok: false, message: 'erP6Runtime: setup incompleto' });
          } else {
            await prisma.message
              .createMany({
                data: [
                  {
                    conversationId: convo.id,
                    direction: 'INBOUND',
                    text: 'Tengo CV y carnet al día.',
                    timestamp: new Date(now.getTime() - 30_000),
                    read: true,
                    rawPayload: JSON.stringify({ simulated: true }),
                  },
                  {
                    conversationId: convo.id,
                    direction: 'OUTBOUND',
                    text: 'Perfecto, quedaste en revisión de operación.',
                    timestamp: new Date(now.getTime() - 20_000),
                    read: true,
                    rawPayload: JSON.stringify({ simulated: true, sendResult: { success: true } }),
                  },
                  {
                    conversationId: convo.id,
                    direction: 'OUTBOUND',
                    text: '📝 Respuesta propuesta enviada a revisión',
                    timestamp: new Date(now.getTime() - 10_000),
                    read: true,
                    rawPayload: JSON.stringify({ simulated: true, internalEvent: true }),
                    isInternalEvent: true as any,
                  },
                ] as any,
              })
              .catch(() => {});

            if (
              docsMissingReactivatesAiAndRequestsExactMissingDocs &&
              typeof docsMissingReactivatesAiAndRequestsExactMissingDocs === 'object'
            ) {
              const requestDocRes = await app.inject({
                method: 'POST',
                url: `/api/op-review/${encodeURIComponent(convo.id)}/action`,
                headers: {
                  authorization: authHeader,
                  'x-workspace-id': wsId,
                  'content-type': 'application/json',
                },
                payload: JSON.stringify({ action: 'REQUEST_DOC', note: 'Falta foto de licencia por ambos lados.' }),
              });
              const convoAfterRequestDoc = await prisma.conversation
                .findUnique({
                  where: { id: convo.id },
                  select: { conversationStage: true, applicationState: true as any, aiPaused: true },
                })
                .catch(() => null);
              const stateOk =
                String((convoAfterRequestDoc as any)?.conversationStage || '').toUpperCase() === 'DOCS_PENDING' &&
                String((convoAfterRequestDoc as any)?.applicationState || '').toUpperCase() === 'REQUEST_OP_DOCS' &&
                !Boolean((convoAfterRequestDoc as any)?.aiPaused);
              assertions.push({
                ok: requestDocRes.statusCode === 200 && stateOk,
                message:
                  requestDocRes.statusCode === 200 && stateOk
                    ? 'docsMissingReactivatesAiAndRequestsExactMissingDocs: REQUEST_DOC reactiva IA y mueve a DOCS_PENDING'
                    : `docsMissingReactivatesAiAndRequestsExactMissingDocs: transición inválida (${requestDocRes.statusCode})`,
              });

              const context = await buildLLMContext({
                workspaceId: wsId,
                conversationId: convo.id,
                mode: 'SUGGEST',
                eventType: 'AI_SUGGEST',
                windowStatus: 'IN_24H',
              }).catch(() => null);
              const missingFields = Array.isArray((context as any)?.contextJson?.applicationFlow?.missingFields)
                ? ((context as any).contextJson.applicationFlow.missingFields as string[])
                : [];
              const asksForDocs = missingFields.some((f) => ['carnet', 'licencia', 'docs_vehiculo'].includes(String(f)));
              assertions.push({
                ok: asksForDocs,
                message: asksForDocs
                  ? `docsMissingReactivatesAiAndRequestsExactMissingDocs: missingFields=${missingFields.join(', ')}`
                  : 'docsMissingReactivatesAiAndRequestsExactMissingDocs: missingFields no detectó docs faltantes',
              });
            }

            if (acceptedMovesToInterviewPending && typeof acceptedMovesToInterviewPending === 'object') {
              await prisma.conversation
                .update({
                  where: { id: convo.id },
                  data: {
                    conversationStage: 'OP_REVIEW',
                    applicationState: 'WAITING_OP_RESULT' as any,
                    aiPaused: true,
                    updatedAt: new Date(),
                  } as any,
                })
                .catch(() => {});
              const acceptRes = await app.inject({
                method: 'POST',
                url: `/api/op-review/${encodeURIComponent(convo.id)}/action`,
                headers: {
                  authorization: authHeader,
                  'x-workspace-id': wsId,
                  'content-type': 'application/json',
                },
                payload: JSON.stringify({ action: 'ACCEPT' }),
              });
              const convoAccepted = await prisma.conversation
                .findUnique({
                  where: { id: convo.id },
                  select: { conversationStage: true, applicationState: true as any, aiPaused: true },
                })
                .catch(() => null);
              const pass =
                acceptRes.statusCode === 200 &&
                String((convoAccepted as any)?.conversationStage || '').toUpperCase() === 'INTERVIEW_PENDING' &&
                String((convoAccepted as any)?.applicationState || '').toUpperCase() === 'OP_ACCEPTED' &&
                !Boolean((convoAccepted as any)?.aiPaused);
              assertions.push({
                ok: pass,
                message: pass
                  ? 'acceptedMovesToInterviewPending: ACCEPT => INTERVIEW_PENDING + OP_ACCEPTED + aiPaused=false'
                  : `acceptedMovesToInterviewPending: transición inválida (${acceptRes.statusCode})`,
              });
            }

            if (rejectedMovesToRejectedAndAiPauses && typeof rejectedMovesToRejectedAndAiPauses === 'object') {
              await prisma.conversation
                .update({
                  where: { id: convo.id },
                  data: {
                    conversationStage: 'OP_REVIEW',
                    applicationState: 'WAITING_OP_RESULT' as any,
                    aiPaused: true,
                    updatedAt: new Date(),
                  } as any,
                })
                .catch(() => {});
              const rejectRes = await app.inject({
                method: 'POST',
                url: `/api/op-review/${encodeURIComponent(convo.id)}/action`,
                headers: {
                  authorization: authHeader,
                  'x-workspace-id': wsId,
                  'content-type': 'application/json',
                },
                payload: JSON.stringify({ action: 'REJECT' }),
              });
              const convoRejected = await prisma.conversation
                .findUnique({
                  where: { id: convo.id },
                  select: { conversationStage: true, applicationState: true as any, aiPaused: true },
                })
                .catch(() => null);
              const pass =
                rejectRes.statusCode === 200 &&
                String((convoRejected as any)?.conversationStage || '').toUpperCase() === 'REJECTED' &&
                String((convoRejected as any)?.applicationState || '').toUpperCase() === 'OP_REJECTED' &&
                Boolean((convoRejected as any)?.aiPaused);
              assertions.push({
                ok: pass,
                message: pass
                  ? 'rejectedMovesToRejectedAndAiPauses: REJECT => REJECTED + OP_REJECTED + aiPaused=true'
                  : `rejectedMovesToRejectedAndAiPauses: transición inválida (${rejectRes.statusCode})`,
              });
            }

            if (suggestRespectsApplicationState && typeof suggestRespectsApplicationState === 'object') {
              await prisma.conversation
                .update({
                  where: { id: convo.id },
                  data: {
                    conversationStage: 'OP_REVIEW',
                    applicationState: 'WAITING_OP_RESULT' as any,
                    aiPaused: true,
                    updatedAt: new Date(),
                  } as any,
                })
                .catch(() => {});
              const suggestWhileWaiting = await app.inject({
                method: 'POST',
                url: `/api/conversations/${encodeURIComponent(convo.id)}/ai-suggest`,
                headers: {
                  authorization: authHeader,
                  'x-workspace-id': wsId,
                  'content-type': 'application/json',
                },
                payload: JSON.stringify({ draftText: '', mode: 'SUGGEST' }),
              });
              let suggestWaitingBody: any = null;
              try {
                suggestWaitingBody = JSON.parse(String(suggestWhileWaiting.body || '{}'));
              } catch {
                suggestWaitingBody = null;
              }
              const internalSuggestion =
                suggestWhileWaiting.statusCode === 200 && Boolean(suggestWaitingBody?.meta?.internalSuggestion);
              assertions.push({
                ok: internalSuggestion,
                message: internalSuggestion
                  ? 'suggestRespectsApplicationState: WAITING_OP_RESULT devuelve sugerencia interna (sin reply candidato)'
                  : `suggestRespectsApplicationState: faltó sugerencia interna (${suggestWhileWaiting.statusCode})`,
              });
            }

            if (conversationPreviewHidesInternalEvents && typeof conversationPreviewHidesInternalEvents === 'object') {
              const listRes = await app.inject({
                method: 'GET',
                url: '/api/conversations?viewKey=ALL',
                headers: { authorization: authHeader, 'x-workspace-id': wsId },
              });
              let rows: any[] = [];
              try {
                const parsed = JSON.parse(String(listRes.body || '[]'));
                rows = Array.isArray(parsed) ? parsed : [];
              } catch {
                rows = [];
              }
              const row = rows.find((r: any) => String(r?.id || '') === convo.id);
              const previewText = String(row?.messages?.[0]?.text || row?.previewText || '').trim();
              const pass =
                listRes.statusCode === 200 &&
                previewText.includes('Perfecto, quedaste en revisión de operación') &&
                !/respuesta propuesta enviada a revisión/i.test(previewText);
              assertions.push({
                ok: pass,
                message: pass
                  ? 'conversationPreviewHidesInternalEvents: preview usa último mensaje real'
                  : `conversationPreviewHidesInternalEvents: preview inválido (${previewText || '—'})`,
              });
            }

            if (toneNoSlangInAutoAndSuggest && typeof toneNoSlangInAutoAndSuggest === 'object') {
              const autoRun = await prisma.agentRunLog
                .create({
                  data: {
                    workspaceId: wsId,
                    conversationId: convo.id,
                    phoneLineId: phoneLine.id,
                    eventType: 'INBOUND_MESSAGE',
                    status: 'RUNNING',
                    inputContextJson: JSON.stringify({ event: { inboundText: 'wena compa' } }),
                  } as any,
                  select: { id: true },
                })
                .catch(() => null);
              if (!autoRun?.id) {
                assertions.push({ ok: false, message: 'toneNoSlangInAutoAndSuggest: no se pudo crear run auto' });
              } else {
                await executeAgentResponse({
                  app,
                  workspaceId: wsId,
                  agentRunId: autoRun.id,
                  response: {
                    agent: 'scenario_er_p6_tone',
                    version: 1,
                    commands: [
                      {
                        command: 'SEND_MESSAGE',
                        type: 'SESSION_TEXT',
                        text: 'wena compa, me tinca seguir con tu postulación.',
                      },
                    ],
                  } as any,
                  transportMode: 'NULL',
                }).catch(() => null);
                const lastAuto = await prisma.message
                  .findFirst({
                    where: { conversationId: convo.id, direction: 'OUTBOUND' },
                    orderBy: { timestamp: 'desc' },
                    select: { text: true, transcriptText: true },
                  })
                  .catch(() => null);
                const autoText = normalizeForContains(String(lastAuto?.transcriptText || lastAuto?.text || ''));
                const autoHasSlang =
                  autoText.includes('wena') ||
                  autoText.includes('compa') ||
                  autoText.includes('tinca') ||
                  autoText.includes('cachai');
                assertions.push({
                  ok: !autoHasSlang,
                  message: !autoHasSlang
                    ? 'toneNoSlangInAutoAndSuggest: auto-reply sin modismos'
                    : `toneNoSlangInAutoAndSuggest: auto-reply contiene modismo (${autoText})`,
                });
              }

              const suggestRun = await runAgent({
                workspaceId: wsId,
                conversationId: convo.id,
                eventType: 'AI_SUGGEST',
                inboundMessageId: null,
                draftText: 'wena, me tinca postular',
              }).catch(() => null);
              const suggestText = normalizeForContains(
                String(
                  (suggestRun as any)?.response?.commands?.find((c: any) => String(c?.command || '') === 'SEND_MESSAGE')
                    ?.text || ''
                ),
              );
              const suggestHasSlang =
                suggestText.includes('wena') ||
                suggestText.includes('compa') ||
                suggestText.includes('tinca') ||
                suggestText.includes('cachai');
              assertions.push({
                ok: Boolean(suggestText) && !suggestHasSlang,
                message:
                  Boolean(suggestText) && !suggestHasSlang
                    ? 'toneNoSlangInAutoAndSuggest: suggest sin modismos'
                    : `toneNoSlangInAutoAndSuggest: suggest inválido (${suggestText || '—'})`,
              });
            }
          }

          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.program.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      if (clientLocationFreeText && typeof clientLocationFreeText === 'object') {
        const wsId =
          String((clientLocationFreeText as any)?.workspaceId || 'scenario-client-location-free-text').trim() ||
          'scenario-client-location-free-text';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'clientLocationFreeText: userId missing' });
        } else {
          const lineId = `scenario-client-loc-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);

          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Client Location Free Text', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Client Location Free Text', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const phoneLine = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Client Location (temp)',
                phoneE164: null,
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const contact = await prisma.contact
            .create({
              data: {
                workspaceId: wsId,
                displayName: 'Demo Cliente',
                waId: `scenario-client-loc-${Date.now()}`,
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const convo =
            phoneLine?.id && contact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: phoneLine.id,
                      contactId: contact.id,
                      status: 'OPEN',
                      channel: 'sandbox',
                      isAdmin: false,
                      conversationKind: 'CLIENT',
                      conversationStage: 'NEW_INTAKE',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

          if (!contact?.id || !convo?.id) {
            assertions.push({ ok: false, message: 'clientLocationFreeText: setup incompleto' });
          } else {
            const samples = [
              { text: 'Pudahuel', expectedComuna: 'pudahuel' },
              { text: 'Santiago, Pudahuel', expectedComuna: 'pudahuel' },
              { text: 'Providencia', expectedComuna: 'providencia' },
            ];
            for (const sample of samples) {
              await prisma.contact
                .update({
                  where: { id: contact.id },
                  data: { comuna: null, ciudad: null, region: null } as any,
                })
                .catch(() => {});
              await prisma.message
                .create({
                  data: {
                    conversationId: convo.id,
                    direction: 'INBOUND',
                    text: sample.text,
                    rawPayload: JSON.stringify({ simulated: true, scenario: 'client_location_free_text' }),
                    timestamp: new Date(),
                    read: true,
                  },
                })
                .catch(() => null);
              const run = await prisma.agentRunLog
                .create({
                  data: {
                    workspaceId: wsId,
                    conversationId: convo.id,
                    phoneLineId: phoneLine?.id || null,
                    eventType: 'INBOUND_MESSAGE',
                    status: 'RUNNING',
                    inputContextJson: JSON.stringify({ event: { inboundText: sample.text } }),
                  } as any,
                  select: { id: true },
                })
                .catch(() => null);
              if (!run?.id) {
                assertions.push({ ok: false, message: `clientLocationFreeText: no se pudo crear run (${sample.text})` });
                continue;
              }
              await executeAgentResponse({
                app,
                workspaceId: wsId,
                agentRunId: run.id,
                response: {
                  agent: 'scenario_client_location',
                  version: 1,
                  commands: [
                    {
                      command: 'UPSERT_PROFILE_FIELDS',
                      contactId: contact.id,
                      patch: {},
                    } as any,
                  ],
                } as any,
                transportMode: 'NULL',
              }).catch(() => null);

              const updated = await prisma.contact
                .findUnique({
                  where: { id: contact.id },
                  select: { comuna: true, ciudad: true, region: true },
                })
                .catch(() => null);
              const comunaNorm = normalizeForContains(String((updated as any)?.comuna || ''));
              const comunaOk = comunaNorm.includes(sample.expectedComuna);
              assertions.push({
                ok: comunaOk,
                message: comunaOk
                  ? `clientLocationFreeText: ${sample.text} -> comuna=${String((updated as any)?.comuna || '')}`
                  : `clientLocationFreeText: ${sample.text} no mapeó comuna (got ${String((updated as any)?.comuna || '—')})`,
              });
            }
          }

          // Cleanup: archive-only.
          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const clientRepeatedMessagesNoCannedRepeat =
        (step.expect as any)?.clientRepeatedMessagesNoCannedRepeat || (step.expect as any)?.clientNoCannedRepeat;
      if (clientRepeatedMessagesNoCannedRepeat && typeof clientRepeatedMessagesNoCannedRepeat === 'object') {
        const wsId =
          String((clientRepeatedMessagesNoCannedRepeat as any)?.workspaceId || 'scenario-client-repeated-no-canned')
            .trim() || 'scenario-client-repeated-no-canned';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'clientRepeatedMessagesNoCannedRepeat: userId missing' });
        } else {
          const lineId = `scenario-client-repeat-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Client Repeated No Canned', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Client Repeated No Canned', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});
          const phoneLine = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Client Repeat (temp)',
                phoneE164: null,
                waPhoneNumberId,
                isActive: true,
                archivedAt: null,
                needsAttention: false,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const contact = await prisma.contact
            .upsert({
              where: { workspaceId_waId: { workspaceId: wsId, waId: '56994830202' } } as any,
              create: { workspaceId: wsId, displayName: 'Demo Repeated', waId: '56994830202', archivedAt: null } as any,
              update: { displayName: 'Demo Repeated', archivedAt: null } as any,
              select: { id: true },
            })
            .catch(() => null);
          const convo =
            phoneLine?.id && contact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: phoneLine.id,
                      contactId: contact.id,
                      status: 'OPEN',
                      channel: 'sandbox',
                      isAdmin: false,
                      conversationKind: 'CLIENT',
                      conversationStage: 'NEW_INTAKE',
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

          if (!convo?.id) {
            assertions.push({ ok: false, message: 'clientRepeatedMessagesNoCannedRepeat: setup incompleto' });
          } else {
            await prisma.conversationAskedField
              .upsert({
                where: { conversationId_field: { conversationId: convo.id, field: 'location' } },
                create: {
                  conversationId: convo.id,
                  field: 'location',
                  askCount: 3,
                  lastAskedAt: now,
                  lastAskedHash: 'scenario-location-loop',
                  updatedAt: now,
                } as any,
                update: { askCount: 3, lastAskedAt: now, lastAskedHash: 'scenario-location-loop', updatedAt: now } as any,
              })
              .catch(() => {});

            const inboundBurst = ['hola', 'hola otra vez', 'pudahuel'];
            const outboundTexts: string[] = [];
            const blockedReasons: string[] = [];
            for (let i = 0; i < inboundBurst.length; i += 1) {
              const inboundText = inboundBurst[i];
              await prisma.message
                .create({
                  data: {
                    conversationId: convo.id,
                    direction: 'INBOUND',
                    text: inboundText,
                    rawPayload: JSON.stringify({ simulated: true, scenario: 'client_repeated_messages_no_canned_repeat' }),
                    timestamp: new Date(Date.now() + i * 1000),
                    read: true,
                  },
                })
                .catch(() => null);
              const run = await prisma.agentRunLog
                .create({
                  data: {
                    workspaceId: wsId,
                    conversationId: convo.id,
                    phoneLineId: phoneLine?.id || null,
                    eventType: 'INBOUND_MESSAGE',
                    status: 'RUNNING',
                    inputContextJson: JSON.stringify({ event: { inboundText } }),
                  } as any,
                  select: { id: true },
                })
                .catch(() => null);
              if (!run?.id) continue;
              await executeAgentResponse({
                app,
                workspaceId: wsId,
                agentRunId: run.id,
                response: {
                  agent: 'scenario_client_repeat',
                  version: 1,
                  commands: [
                    {
                      command: 'SEND_MESSAGE',
                      conversationId: convo.id,
                      channel: 'WHATSAPP',
                      type: 'SESSION_TEXT',
                      text: `Para avanzar, ¿me confirmas tu comuna y ciudad? (recibí: ${inboundText})`,
                      dedupeKey: `scenario-repeat-${i + 1}`,
                    } as any,
                  ],
                } as any,
                transportMode: 'NULL',
              }).catch(() => null);

              const lastMsg = await prisma.message
                .findFirst({
                  where: { conversationId: convo.id, direction: 'OUTBOUND' },
                  orderBy: { timestamp: 'desc' },
                  select: { text: true, transcriptText: true },
                })
                .catch(() => null);
              outboundTexts.push(String(lastMsg?.transcriptText || lastMsg?.text || '').trim());
              const lastLog = await prisma.outboundMessageLog
                .findFirst({
                  where: { conversationId: convo.id },
                  orderBy: { createdAt: 'desc' },
                  select: { blockedReason: true },
                })
                .catch(() => null);
              blockedReasons.push(String(lastLog?.blockedReason || ''));
            }

            const uniqueCount = new Set(outboundTexts.filter(Boolean)).size;
            assertions.push({
              ok: uniqueCount >= 2,
              message:
                uniqueCount >= 2
                  ? `clientRepeatedMessagesNoCannedRepeat: variantes OK (${uniqueCount} textos distintos)`
                  : 'clientRepeatedMessagesNoCannedRepeat: respuestas idénticas repetidas',
            });
            const noRigidTemplate = outboundTexts.every((t) => {
              const n = normalizeForContains(t);
              return !n.includes('responde asi') && !n.includes('1)') && !n.includes('2)');
            });
            assertions.push({
              ok: noRigidTemplate,
              message: noRigidTemplate
                ? 'clientRepeatedMessagesNoCannedRepeat: sin formato rígido/menú 1-2'
                : `clientRepeatedMessagesNoCannedRepeat: detectado formato rígido (${outboundTexts.join(' | ')})`,
            });
            const noSilentAntiLoop = blockedReasons.every((r) => !String(r || '').includes('ANTI_LOOP_SAME_TEXT'));
            assertions.push({
              ok: noSilentAntiLoop,
              message: noSilentAntiLoop
                ? 'clientRepeatedMessagesNoCannedRepeat: sin bloqueo ANTI_LOOP_SAME_TEXT'
                : `clientRepeatedMessagesNoCannedRepeat: bloqueo detectado (${blockedReasons.join(' | ')})`,
            });
          }

          // Cleanup: archive-only.
          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      if (noLegacyCopyLeaks && typeof noLegacyCopyLeaks === 'object') {
        const wsId = String((noLegacyCopyLeaks as any)?.workspaceId || 'envio-rapido').trim() || 'envio-rapido';
        const workspace = await prisma.workspace
          .findUnique({
            where: { id: wsId },
            select: { id: true, name: true, archivedAt: true },
          })
          .catch(() => null);
        if (!workspace?.id || workspace.archivedAt) {
          assertions.push({ ok: false, message: `noLegacyCopyLeaks: workspace no encontrado (${wsId})` });
        } else {
          const badRegex = /\$600\.?000|venta\s+en\s+terreno/i;
          const configRow = await prisma.systemConfig.findFirst().catch(() => null);
          const configLeak = badRegex.test(String((configRow as any)?.defaultJobTitle || '')) ||
            badRegex.test(String((configRow as any)?.recruitJobSheet || '')) ||
            badRegex.test(String((configRow as any)?.recruitFaq || ''));
          assertions.push({
            ok: !configLeak,
            message: !configLeak
              ? 'noLegacyCopyLeaks: SystemConfig sin copy legacy activo'
              : 'noLegacyCopyLeaks: SystemConfig aún contiene copy legacy',
          });
          const activePrograms = await prisma.program
            .findMany({
              where: { workspaceId: wsId, archivedAt: null, isActive: true },
              select: { id: true, slug: true, name: true, agentSystemPrompt: true },
              take: 30,
            })
            .catch(() => []);
          const leakyPrograms = activePrograms.filter((p: any) =>
            badRegex.test(String(p?.agentSystemPrompt || '')),
          );
          assertions.push({
            ok: leakyPrograms.length === 0,
            message:
              leakyPrograms.length === 0
                ? 'noLegacyCopyLeaks: prompts activos sin frases legacy'
                : `noLegacyCopyLeaks: prompts legacy detectados (${leakyPrograms.map((p: any) => p.slug || p.id).join(', ')})`,
          });
          const fallbackAllowedRaw = String(process.env.HUNTER_LEGACY_RECRUIT_FALLBACK_WORKSPACES || '').toLowerCase();
          const fallbackAllowed = fallbackAllowedRaw
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
          const fallbackBlockedForWs =
            wsId.toLowerCase() === 'envio-rapido' && !fallbackAllowed.includes(wsId.toLowerCase()) && !fallbackAllowed.includes('*');
          assertions.push({
            ok: fallbackBlockedForWs,
            message: fallbackBlockedForWs
              ? 'noLegacyCopyLeaks: fallback legacy bloqueado para envio-rapido'
              : 'noLegacyCopyLeaks: fallback legacy no está explícitamente bloqueado para envio-rapido',
          });
        }
      }

      if (promptLockPreventsSeedOverwrite && typeof promptLockPreventsSeedOverwrite === 'object') {
        const wsId =
          String((promptLockPreventsSeedOverwrite as any)?.workspaceId || 'scenario-er-p10-prompt-lock').trim() ||
          'scenario-er-p10-prompt-lock';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const now = new Date();
        if (!userId || !authHeader) {
          assertions.push({ ok: false, message: 'promptLockPreventsSeedOverwrite: auth/user missing' });
        } else {
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Prompt Lock', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Prompt Lock', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});
          const program = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'scenario-prompt-lock' } },
              create: {
                workspaceId: wsId,
                name: 'Scenario Prompt Lock',
                slug: 'scenario-prompt-lock',
                agentSystemPrompt: 'PROMPT_LOCKED_A',
                promptSource: 'MANUAL' as any,
                promptLocked: true as any,
                isActive: true,
                archivedAt: null,
              } as any,
              update: {
                name: 'Scenario Prompt Lock',
                isActive: true,
                archivedAt: null,
                agentSystemPrompt: 'PROMPT_LOCKED_A',
                promptSource: 'MANUAL' as any,
                promptLocked: true as any,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          if (!program?.id) {
            assertions.push({ ok: false, message: 'promptLockPreventsSeedOverwrite: no se pudo crear program' });
          } else {
            const patchNoForce = await app.inject({
              method: 'PATCH',
              url: `/api/programs/${encodeURIComponent(program.id)}`,
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
              payload: { agentSystemPrompt: 'PROMPT_LOCKED_B' },
            });
            assertions.push({
              ok: patchNoForce.statusCode === 409,
              message:
                patchNoForce.statusCode === 409
                  ? 'promptLockPreventsSeedOverwrite: cambio sin force bloqueado (409)'
                  : `promptLockPreventsSeedOverwrite: esperado 409 sin force (status=${patchNoForce.statusCode})`,
            });
            const patchForced = await app.inject({
              method: 'PATCH',
              url: `/api/programs/${encodeURIComponent(program.id)}`,
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
              payload: { agentSystemPrompt: 'PROMPT_LOCKED_B', forceUpdatePrompt: true, promptUpdateMode: 'FORCE_UPDATE_PROMPT' },
            });
            assertions.push({
              ok: patchForced.statusCode === 200,
              message:
                patchForced.statusCode === 200
                  ? 'promptLockPreventsSeedOverwrite: FORCE_UPDATE_PROMPT permitido'
                  : `promptLockPreventsSeedOverwrite: force update falló (status=${patchForced.statusCode})`,
            });
          }

          await prisma.program.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      if (programPromptIsEffective && typeof programPromptIsEffective === 'object') {
        const wsId =
          String((programPromptIsEffective as any)?.workspaceId || 'scenario-er-p8-prompt').trim() ||
          'scenario-er-p8-prompt';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'programPromptIsEffective: userId missing' });
        } else {
          const lineId = `scenario-prompt-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Prompt Effective', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Prompt Effective', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});
          const program = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'scenario-prompt-effective' } },
              create: {
                workspaceId: wsId,
                name: 'Scenario Prompt Effective',
                slug: 'scenario-prompt-effective',
                agentSystemPrompt: 'PROMPT_VERSION_A',
                isActive: true,
                archivedAt: null,
              } as any,
              update: {
                name: 'Scenario Prompt Effective',
                agentSystemPrompt: 'PROMPT_VERSION_A',
                isActive: true,
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const line = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Prompt Line',
                waPhoneNumberId,
                isActive: true,
                defaultProgramId: program?.id || null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const contact = await prisma.contact
            .create({
              data: { workspaceId: wsId, displayName: 'Scenario Prompt Contact', waId: `scenario-prompt-${Date.now()}` } as any,
              select: { id: true },
            })
            .catch(() => null);
          const convo =
            line?.id && contact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      programId: program?.id || null,
                      contactId: contact.id,
                      status: 'OPEN',
                      channel: 'sandbox',
                      conversationKind: 'CLIENT',
                      conversationStage: 'NEW_INTAKE',
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

          if (!program?.id || !convo?.id) {
            assertions.push({ ok: false, message: 'programPromptIsEffective: setup incompleto' });
          } else {
            const ctxA = await buildLLMContext({
              workspaceId: wsId,
              conversationId: convo.id,
              mode: 'INBOUND',
              eventType: 'INBOUND_MESSAGE',
              windowStatus: 'IN_24H',
              inboundMessageId: null,
              draftText: null,
            }).catch(() => null);
            const hashA = String((ctxA as any)?.contextJson?.runtimeResolution?.resolvedProgram?.promptHash || '');
            await prisma.program
              .update({
                where: { id: program.id },
                data: { agentSystemPrompt: 'PROMPT_VERSION_B', updatedAt: new Date() } as any,
              })
              .catch(() => {});
            const ctxB = await buildLLMContext({
              workspaceId: wsId,
              conversationId: convo.id,
              mode: 'INBOUND',
              eventType: 'INBOUND_MESSAGE',
              windowStatus: 'IN_24H',
              inboundMessageId: null,
              draftText: null,
            }).catch(() => null);
            const hashB = String((ctxB as any)?.contextJson?.runtimeResolution?.resolvedProgram?.promptHash || '');
            const hashChanged = Boolean(hashA) && Boolean(hashB) && hashA !== hashB;
            assertions.push({
              ok: hashChanged,
              message: hashChanged
                ? `programPromptIsEffective: promptHash cambió (${hashA} -> ${hashB})`
                : `programPromptIsEffective: promptHash no cambió (${hashA} -> ${hashB})`,
            });
          }

          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.program.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      if (assetsPublicDownloadOk && typeof assetsPublicDownloadOk === 'object') {
        const wsId = String((assetsPublicDownloadOk as any)?.workspaceId || 'envio-rapido').trim() || 'envio-rapido';
        const authHeader = String((request.headers as any)?.authorization || '');
        const integrityRes = await app.inject({
          method: 'GET',
          url: '/api/assets/integrity',
          headers: { authorization: authHeader, 'x-workspace-id': wsId },
        });
        let integrityJson: any = null;
        try {
          integrityJson = JSON.parse(String(integrityRes.body || '{}'));
        } catch {
          integrityJson = null;
        }
        assertions.push({
          ok: integrityRes.statusCode === 200 && integrityJson?.workspaceId === wsId,
          message:
            integrityRes.statusCode === 200 && integrityJson?.workspaceId === wsId
              ? 'assetsPublicDownloadOk: endpoint integrity disponible'
              : `assetsPublicDownloadOk: fallo endpoint integrity (status=${integrityRes.statusCode})`,
        });
        const critical = Array.isArray(integrityJson?.criticalAssets) ? integrityJson.criticalAssets : [];
        const criticalMissing = critical.filter((it: any) => Boolean(it?.missing));
        assertions.push({
          ok: critical.length >= 3 && criticalMissing.length === 0,
          message:
            critical.length >= 3 && criticalMissing.length === 0
              ? 'assetsPublicDownloadOk: 3 assets críticos presentes'
              : `assetsPublicDownloadOk: faltan assets críticos (${criticalMissing.map((it: any) => it?.expectedSlug || it?.key).join(', ') || 'sin detalle'})`,
        });
      }

      if (runtimeDebugPanelVisible && typeof runtimeDebugPanelVisible === 'object') {
        const wsId =
          String((runtimeDebugPanelVisible as any)?.workspaceId || 'scenario-er-p8-runtime-panel').trim() ||
          'scenario-er-p8-runtime-panel';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const authHeader = String((request.headers as any)?.authorization || '');
        const now = new Date();
        if (!userId || !authHeader) {
          assertions.push({ ok: false, message: 'runtimeDebugPanelVisible: auth/user missing' });
        } else {
          const lineId = `scenario-runtime-panel-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: { id: wsId, name: 'Scenario Runtime Panel', isSandbox: true, archivedAt: null } as any,
              update: { name: 'Scenario Runtime Panel', isSandbox: true, archivedAt: null } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});
          const program = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'scenario-runtime-panel' } },
              create: {
                workspaceId: wsId,
                name: 'Scenario Runtime Panel Program',
                slug: 'scenario-runtime-panel',
                agentSystemPrompt: 'Prompt runtime panel scenario',
                isActive: true,
              } as any,
              update: {
                name: 'Scenario Runtime Panel Program',
                agentSystemPrompt: 'Prompt runtime panel scenario',
                isActive: true,
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const line = await prisma.phoneLine
            .create({
              data: {
                id: lineId,
                workspaceId: wsId,
                alias: 'Scenario Runtime Panel Line',
                waPhoneNumberId,
                isActive: true,
                defaultProgramId: program?.id || null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const contact = await prisma.contact
            .create({
              data: { workspaceId: wsId, displayName: 'Scenario Runtime Panel Contact', waId: `scenario-runtime-${Date.now()}` } as any,
              select: { id: true },
            })
            .catch(() => null);
          const convo =
            line?.id && contact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      programId: program?.id || null,
                      contactId: contact.id,
                      status: 'OPEN',
                      channel: 'sandbox',
                      conversationKind: 'CLIENT',
                      conversationStage: 'NEW_INTAKE',
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;
          if (!convo?.id) {
            assertions.push({ ok: false, message: 'runtimeDebugPanelVisible: setup incompleto' });
          } else {
            const run = await prisma.agentRunLog
              .create({
                data: {
                  workspaceId: wsId,
                  conversationId: convo.id,
                  phoneLineId: line?.id || null,
                  programId: program?.id || null,
                  eventType: 'INBOUND_MESSAGE',
                  status: 'SUCCESS',
                  inputContextJson: JSON.stringify({
                    runtimeResolution: {
                      resolvedWorkspace: { id: wsId, name: 'Scenario Runtime Panel' },
                      resolvedPhoneLine: { id: line?.id || null, alias: 'Scenario Runtime Panel Line', waPhoneNumberId },
                      resolvedProgram: { id: program?.id || null, slug: 'scenario-runtime-panel', name: 'Scenario Runtime Panel Program', promptHash: 'scenariohash' },
                    },
                    applicationFlow: {
                      applicationRole: 'CONDUCTOR',
                      applicationState: 'COLLECT_MIN_INFO',
                      missingFields: ['availability', 'experience'],
                    },
                  }),
                  resultsJson: JSON.stringify({ modelRequested: 'gpt-4o-mini', modelResolved: 'gpt-4o-mini' }),
                } as any,
                select: { id: true },
              })
              .catch(() => null);
            if (run?.id) {
              await prisma.aiUsageLog
                .create({
                  data: {
                    workspaceId: wsId,
                    conversationId: convo.id,
                    agentRunId: run.id,
                    actor: 'AGENT',
                    model: 'gpt-4o-mini',
                    modelRequested: 'gpt-4o-mini',
                    modelResolved: 'gpt-4o-mini',
                    inputTokens: 10,
                    outputTokens: 10,
                    totalTokens: 20,
                  } as any,
                })
                .catch(() => {});
            }

            const detailRes = await app.inject({
              method: 'GET',
              url: `/api/conversations/${encodeURIComponent(convo.id)}`,
              headers: { authorization: authHeader, 'x-workspace-id': wsId },
            });
            let detailJson: any = null;
            try {
              detailJson = JSON.parse(String(detailRes.body || '{}'));
            } catch {
              detailJson = null;
            }
            const diag = detailJson?.runtimeDiagnostics;
            const diagOk =
              detailRes.statusCode === 200 &&
              Boolean(diag?.resolvedWorkspace) &&
              Boolean(diag?.resolvedProgram) &&
              typeof diag?.candidateReplyMode === 'string' &&
              typeof diag?.adminNotifyMode === 'string';
            assertions.push({
              ok: diagOk,
              message: diagOk
                ? 'runtimeDebugPanelVisible: runtimeDiagnostics disponible en API de conversación'
                : `runtimeDebugPanelVisible: runtimeDiagnostics incompleto (status=${detailRes.statusCode})`,
            });
          }

          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.program.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      if (intakeGreetingStartsFlow && typeof intakeGreetingStartsFlow === 'object') {
        const wsId =
          String((intakeGreetingStartsFlow as any)?.workspaceId || 'scenario-er-p12-intake-greeting').trim() ||
          'scenario-er-p12-intake-greeting';
        const userId = request.user?.userId ? String(request.user.userId) : '';
        const now = new Date();
        if (!userId) {
          assertions.push({ ok: false, message: 'intakeGreetingStartsFlow: userId missing' });
        } else {
          const lineId = `scenario-intake-greeting-line-${Date.now()}`;
          const waPhoneNumberId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 18);
          await prisma.workspace
            .upsert({
              where: { id: wsId },
              create: {
                id: wsId,
                name: 'Scenario ER-P12 Intake Greeting',
                isSandbox: true,
                candidateReplyMode: 'AUTO' as any,
                adminNotifyMode: 'HITS_ONLY' as any,
                archivedAt: null,
              } as any,
              update: {
                name: 'Scenario ER-P12 Intake Greeting',
                isSandbox: true,
                candidateReplyMode: 'AUTO' as any,
                adminNotifyMode: 'HITS_ONLY' as any,
                archivedAt: null,
              } as any,
            })
            .catch(() => {});
          await prisma.membership
            .upsert({
              where: { userId_workspaceId: { userId, workspaceId: wsId } },
              create: { userId, workspaceId: wsId, role: 'OWNER', archivedAt: null } as any,
              update: { role: 'OWNER', archivedAt: null } as any,
            })
            .catch(() => {});

          const intakeProgram = await prisma.program
            .upsert({
              where: { workspaceId_slug: { workspaceId: wsId, slug: 'postulacion-intake-envio-rapido' } },
              create: {
                workspaceId: wsId,
                name: 'Postulación — Intake (scenario)',
                slug: 'postulacion-intake-envio-rapido',
                agentSystemPrompt: 'Scenario prompt intake greeting',
                isActive: true,
                archivedAt: null,
              } as any,
              update: {
                name: 'Postulación — Intake (scenario)',
                agentSystemPrompt: 'Scenario prompt intake greeting',
                isActive: true,
                archivedAt: null,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const line = intakeProgram?.id
            ? await prisma.phoneLine
                .create({
                  data: {
                    id: lineId,
                    workspaceId: wsId,
                    alias: 'Scenario Intake Greeting Line',
                    waPhoneNumberId,
                    isActive: true,
                    defaultProgramId: intakeProgram.id,
                  } as any,
                  select: { id: true },
                })
                .catch(() => null)
            : null;
          const contact = await prisma.contact
            .create({
              data: {
                workspaceId: wsId,
                displayName: 'Scenario Intake Greeting Contact',
                waId: `scenario-intake-greeting-${Date.now()}`,
              } as any,
              select: { id: true },
            })
            .catch(() => null);
          const convo =
            line?.id && contact?.id
              ? await prisma.conversation
                  .create({
                    data: {
                      workspaceId: wsId,
                      phoneLineId: line.id,
                      contactId: contact.id,
                      status: 'OPEN',
                      channel: 'sandbox',
                      isAdmin: false,
                      conversationKind: 'CLIENT',
                      conversationStage: 'NEW_INTAKE',
                      programId: intakeProgram?.id || null,
                      applicationRole: null,
                      applicationState: null,
                      aiPaused: false,
                      archivedAt: null,
                    } as any,
                    select: { id: true },
                  })
                  .catch(() => null)
              : null;

          if (!convo?.id) {
            assertions.push({ ok: false, message: 'intakeGreetingStartsFlow: setup incompleto' });
          } else {
            const inboundMsg = await prisma.message
              .create({
                data: {
                  conversationId: convo.id,
                  direction: 'INBOUND',
                  text: 'holaaa',
                  rawPayload: JSON.stringify({ type: 'text', body: 'holaaa', source: 'scenario' }),
                  timestamp: new Date(),
                  read: false,
                } as any,
                select: { id: true },
              })
              .catch(() => null);
            await runAutomations({
              app,
              workspaceId: wsId,
              eventType: 'INBOUND_MESSAGE',
              conversationId: convo.id,
              inboundMessageId: inboundMsg?.id || null,
              inboundText: 'holaaa',
              transportMode: 'NULL',
            }).catch(() => {});

            const after = await prisma.conversation
              .findUnique({
                where: { id: convo.id },
                select: { applicationState: true as any, applicationRole: true as any },
              })
              .catch(() => null);
            const latestRun = await prisma.agentRunLog
              .findFirst({
                where: { conversationId: convo.id, eventType: 'INBOUND_MESSAGE' },
                orderBy: { createdAt: 'desc' },
                select: { commandsJson: true, resultsJson: true, status: true },
              })
              .catch(() => null);
            const runCommands = safeJsonParse((latestRun as any)?.commandsJson || null);
            const runResults = safeJsonParse((latestRun as any)?.resultsJson || null);
            const sentKickoffText = (() => {
              const commands = Array.isArray((runCommands as any)?.commands) ? (runCommands as any).commands : [];
              for (const cmd of commands) {
                if (!cmd || typeof cmd !== 'object') continue;
                if (String((cmd as any).command || '').toUpperCase() !== 'SEND_MESSAGE') continue;
                const text = String((cmd as any).text || '');
                if (
                  text.includes('1) Peoneta') &&
                  text.includes('2) Conductor') &&
                  text.includes('3) Conductor con vehículo propio')
                ) {
                  return true;
                }
              }
              return false;
            })();
            const resultRows = Array.isArray((runResults as any)?.results) ? (runResults as any).results : [];
            const replySent = resultRows.some((r: any) => {
              const sendResult = r?.details?.sendResult || r?.details?.result?.sendResult || null;
              return Boolean(sendResult && sendResult.success === true);
            });
            const blockedBySafeMode = resultRows.some((r: any) => {
              const blockedReason = String(r?.blockedReason || r?.details?.blockedReason || '').toUpperCase();
              return blockedReason.includes('SAFE_OUTBOUND_BLOCKED');
            });
            const kickoffAttempted = sentKickoffText || replySent || blockedBySafeMode;
            assertions.push({
              ok: kickoffAttempted,
              message: kickoffAttempted
                ? replySent
                  ? 'intakeGreetingStartsFlow: saludo dispara menú de cargos'
                  : blockedBySafeMode
                    ? 'intakeGreetingStartsFlow: saludo dispara menú (bloqueado por SAFE MODE esperado en scenario)'
                    : 'intakeGreetingStartsFlow: saludo procesado (kickoff command registrado)'
                : `intakeGreetingStartsFlow: no se confirmó envío kickoff (status=${String((latestRun as any)?.status || '—')})`,
            });
            const stateOk = String((after as any)?.applicationState || '').toUpperCase() === 'CHOOSE_ROLE';
            assertions.push({
              ok: stateOk,
              message: stateOk
                ? 'intakeGreetingStartsFlow: applicationState=CHOOSE_ROLE'
                : `intakeGreetingStartsFlow: state inesperado (${String((after as any)?.applicationState || '—')})`,
            });
          }

          await prisma.conversation.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.contact.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.phoneLine.updateMany({ where: { id: lineId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.program.updateMany({ where: { workspaceId: wsId }, data: { archivedAt: now, isActive: false } as any }).catch(() => {});
          await prisma.membership.updateMany({ where: { userId, workspaceId: wsId }, data: { archivedAt: now } as any }).catch(() => {});
          await prisma.workspace.updateMany({ where: { id: wsId }, data: { archivedAt: now } as any }).catch(() => {});
        }
      }

      const stepOk = assertions.every((a) => a.ok);
      ok = ok && stepOk;
      stepResults.push({
        step: idx + 1,
        inboundMessageId: message?.id || null,
        inboundText,
        inboundTimestamp: message?.timestamp ? message.timestamp.toISOString() : timestamp.toISOString(),
        assertions,
        outbound: {
          sentDelta: outboundSentAfter - outboundSentBefore,
          blockedDelta: outboundBlockedAfter - outboundBlockedBefore,
          lastBlockedReason: lastOutbound?.blockedReason || null,
          lastType: lastOutbound?.type || null,
          lastDedupeKey: lastOutbound?.dedupeKey || null,
          lastCreatedAt: lastOutbound?.createdAt ? lastOutbound.createdAt.toISOString() : null,
        },
        agentRun: lastAgentRun
          ? {
              id: lastAgentRun.id,
              createdAt: lastAgentRun.createdAt.toISOString(),
              eventType: lastAgentRun.eventType,
              status: lastAgentRun.status,
              programSlug: (lastAgentRun as any)?.program?.slug || null,
              error: lastAgentRun.error || null,
            }
          : null,
        snapshot: snap
          ? {
              status: snap.status,
              stage: snap.conversationStage,
              programId: snap.programId,
              contact: {
                candidateName: snap.contact.candidateName,
                comuna: (snap.contact as any).comuna,
                ciudad: (snap.contact as any).ciudad,
                region: (snap.contact as any).region,
                rut: (snap.contact as any).rut,
                email: (snap.contact as any).email,
              },
            }
          : null,
      });
    }

    const transcript = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { timestamp: 'asc' },
      select: { id: true, direction: true, text: true, transcriptText: true, timestamp: true },
    });

    const finishedAt = new Date();
    await prisma.scenarioRunLog
      .create({
        data: {
          workspaceId: 'sandbox',
          scenarioId: scenario.id,
          ok,
          sessionConversationId: conversation.id,
          triggeredByUserId: request.user?.userId || null,
          startedAt,
          finishedAt,
        } as any,
      })
      .catch(() => {});

    return {
      ok,
      scenario: { id: scenario.id, name: scenario.name },
      sessionId: conversation.id,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      steps: stepResults,
      transcript: transcript.map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.transcriptText || m.text,
        timestamp: m.timestamp.toISOString(),
      })),
    };
  });

  app.get('/sessions', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!(await requireWorkspaceAdmin(request, reply))) return;
    const sessions = await prisma.conversation.findMany({
      where: { workspaceId: 'sandbox', channel: 'sandbox', archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, sandboxSourceConversationId: true, createdAt: true },
    });
    return sessions.map((s) => ({
      id: s.id,
      sourceConversationId: s.sandboxSourceConversationId,
      createdAt: s.createdAt.toISOString(),
    }));
  });

  app.get('/sessions/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!(await requireWorkspaceAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    const session = await prisma.conversation.findFirst({
      where: { id, workspaceId: 'sandbox', channel: 'sandbox' },
      include: { contact: true, messages: { orderBy: { timestamp: 'asc' } } },
    });
    if (!session) return reply.code(404).send({ error: 'Sesión no encontrada.' });
    return {
      id: session.id,
      sourceConversationId: session.sandboxSourceConversationId,
      status: session.status,
      stage: session.conversationStage,
      contact: {
        id: session.contactId,
        displayName: session.contact.displayName,
        candidateName: session.contact.candidateName,
        candidateNameManual: (session.contact as any).candidateNameManual,
        comuna: (session.contact as any).comuna,
        ciudad: (session.contact as any).ciudad,
        rut: (session.contact as any).rut,
        email: (session.contact as any).email,
        noContact: session.contact.noContact,
      },
      messages: session.messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.transcriptText || m.text,
        timestamp: m.timestamp.toISOString(),
      })),
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  });

  app.post('/sessions', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!(await requireWorkspaceAdmin(request, reply))) return;
    const body = request.body as { sourceConversationId?: string | null };
    const contact = await prisma.contact.create({
      data: {
        workspaceId: 'sandbox',
        displayName: 'Sandbox',
        candidateName: null,
        candidateNameManual: null,
      } as any,
    });
    const conversation = await prisma.conversation.create({
      data: {
        workspaceId: 'sandbox',
        phoneLineId: 'sandbox-default',
        contactId: contact.id,
        status: 'NEW',
        conversationStage: 'SANDBOX',
        channel: 'sandbox',
        sandboxSourceConversationId: body?.sourceConversationId ? String(body.sourceConversationId) : null,
      } as any,
    });
    return { id: conversation.id, sourceConversationId: conversation.sandboxSourceConversationId, createdAt: conversation.createdAt.toISOString() };
  });

  app.post('/run', { preValidation: [app.authenticate] }, async (request, reply) => {
    if (!(await requireWorkspaceAdmin(request, reply))) return;
    const body = request.body as { sessionId?: string; inboundText?: string };
    const sessionId = String(body.sessionId || '').trim();
    const inboundText = String(body.inboundText || '').trim();
    if (!sessionId || !inboundText) {
      return reply.code(400).send({ error: '"sessionId" y "inboundText" son obligatorios.' });
    }
    const session = await prisma.conversation.findFirst({
      where: { id: sessionId, workspaceId: 'sandbox', channel: 'sandbox' },
      include: { contact: true },
    });
    if (!session) return reply.code(404).send({ error: 'Sesión no encontrada.' });

    const message = await prisma.message.create({
      data: {
        conversationId: session.id,
        direction: 'INBOUND',
        text: inboundText,
        rawPayload: JSON.stringify({ simulated: true, sandbox: true }),
        timestamp: new Date(),
        read: false,
      },
    });

    await prisma.conversation.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    });

    await runAutomations({
      app,
      workspaceId: 'sandbox',
      eventType: 'INBOUND_MESSAGE',
      conversationId: session.id,
      inboundMessageId: message.id,
      inboundText,
      transportMode: 'NULL',
    });

    const updated = await prisma.conversation.findUnique({
      where: { id: session.id },
      include: {
        contact: true,
        messages: { orderBy: { timestamp: 'asc' } },
      },
    });

    return {
      sessionId: session.id,
      conversation: updated && {
        id: updated.id,
        status: updated.status,
        stage: updated.conversationStage,
        contact: {
          id: updated.contactId,
          displayName: updated.contact.displayName,
          candidateName: updated.contact.candidateName,
          candidateNameManual: (updated.contact as any).candidateNameManual,
          comuna: (updated.contact as any).comuna,
          ciudad: (updated.contact as any).ciudad,
          rut: (updated.contact as any).rut,
          email: (updated.contact as any).email,
          noContact: updated.contact.noContact,
        },
        messages: updated.messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          text: m.transcriptText || m.text,
          timestamp: m.timestamp.toISOString(),
        })),
      },
    };
  });

  app.post('/replay/:conversationId', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await requireWorkspaceAdmin(request, reply);
    if (!access) return;
    const { conversationId } = request.params as { conversationId: string };
    const body = request.body as { sanitizePii?: boolean };
    const sanitize = body?.sanitizePii !== false;

    const source = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId: access.workspaceId },
      include: { contact: true, messages: { orderBy: { timestamp: 'asc' } } },
    });
    if (!source) return reply.code(404).send({ error: 'Conversación no encontrada.' });

    const contact = await prisma.contact.create({
      data: {
        workspaceId: 'sandbox',
        displayName: sanitize ? 'Sandbox (sanitizado)' : source.contact.displayName || 'Sandbox',
        candidateName: sanitize ? null : source.contact.candidateName,
        candidateNameManual: sanitize ? null : (source.contact as any).candidateNameManual,
        email: sanitize ? null : (source.contact as any).email,
        rut: sanitize ? null : (source.contact as any).rut,
        comuna: sanitize ? null : (source.contact as any).comuna,
        ciudad: sanitize ? null : (source.contact as any).ciudad,
        region: sanitize ? null : (source.contact as any).region,
        experienceYears: sanitize ? null : (source.contact as any).experienceYears,
        terrainExperience: sanitize ? null : (source.contact as any).terrainExperience,
        availabilityText: sanitize ? null : (source.contact as any).availabilityText,
      } as any,
    });

    const conversation = await prisma.conversation.create({
      data: {
        workspaceId: 'sandbox',
        phoneLineId: 'sandbox-default',
        contactId: contact.id,
        status: source.status,
        conversationStage: 'SANDBOX_REPLAY',
        channel: 'sandbox',
        aiMode: source.aiMode,
        sandboxSourceConversationId: source.id,
      } as any,
    });

    for (const msg of source.messages) {
      const text = msg.transcriptText || msg.text;
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: msg.direction,
          text: sanitize ? piiSanitizeText(text) : text,
          rawPayload: JSON.stringify({ replay: true, sourceMessageId: msg.id, sanitize }),
          timestamp: msg.timestamp,
          read: true,
        },
      });
    }

    return {
      id: conversation.id,
      sourceConversationId: source.id,
      createdAt: conversation.createdAt.toISOString(),
    };
  });

  app.post('/whatsapp', { preValidation: [app.authenticate] }, async (request, reply) => {
    const access = await requireWorkspaceAdmin(request, reply);
    if (!access) return;
    const { from, text, media, waMessageId } = request.body as {
      from?: string;
      text?: string;
      waMessageId?: string;
      media?: {
        type?: string;
        id?: string;
        mimeType?: string;
        filename?: string;
        caption?: string;
        dataBase64?: string;
      } | null;
    };

    const trimmedText = (text || '').trim();
    const hasMedia = Boolean(media && media.type);
    if (!from || (!trimmedText && !hasMedia)) {
      return reply
        .code(400)
        .send({ error: '"from" es obligatorio y debes enviar "text" o "media".' });
    }

    const config = await getSystemConfig();
    const normalizedFrom = normalizeWhatsAppId(from);
    const allowed = new Set([...getTestWaIdAllowlist(config), ...getAdminWaIdAllowlist(config)]);
    if (!normalizedFrom) {
      return reply.code(400).send({ error: '"from" inválido (usa E.164).' });
    }
    // Guardrail: simulation is TEST-ONLY and must never introduce synthetic candidate numbers in PROD.
    if (!allowed.has(normalizedFrom)) {
      return reply.code(400).send({
        error:
          'Simulación bloqueada: /api/simulate/whatsapp solo permite números admin/de prueba configurados.'
      });
    }

    const phoneLine = await prisma.phoneLine.findFirst({
      where: { workspaceId: access.workspaceId, archivedAt: null, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { waPhoneNumberId: true },
    });
    if (!phoneLine?.waPhoneNumberId) {
      return reply.code(400).send({ error: 'No hay PhoneLine activa configurada para este workspace.' });
    }

    const result = await handleInboundWhatsAppMessage(app, {
      from: normalizedFrom,
      waPhoneNumberId: phoneLine.waPhoneNumberId,
      waMessageId: typeof waMessageId === 'string' && waMessageId.trim() ? waMessageId.trim() : undefined,
      text: trimmedText,
      media: hasMedia
        ? {
          type: String(media?.type || ''),
          id: String(media?.id || `sim-${Date.now()}`),
            mimeType: media?.mimeType,
            filename: media?.filename,
            caption: media?.caption,
            dataBase64: media?.dataBase64
          }
        : null,
      rawPayload: {
        simulated: true,
        text: trimmedText || null,
        media: hasMedia
          ? {
              type: media?.type || null,
              mimeType: media?.mimeType || null,
              filename: media?.filename || null,
              caption: media?.caption || null
            }
          : null
      }
    });

    return reply.send({ status: 'ok', conversationId: result.conversationId });
  });
}
