import { FastifyInstance } from 'fastify';
import { handleInboundWhatsAppMessage } from '../services/whatsappInboundService';
import { getAdminWaIdAllowlist, getSystemConfig, getTestWaIdAllowlist } from '../services/configService';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { prisma } from '../db/client';
import { runAutomations } from '../services/automationRunnerService';
import { piiSanitizeText } from '../services/agent/tools';
import { isWorkspaceAdmin, resolveWorkspaceAccess } from '../services/workspaceAuthService';
import { SCENARIOS, getScenario, ScenarioDefinition, ScenarioStep } from '../services/simulate/scenarios';
import { resolveReplyContextForInboundMessage, runAgent } from '../services/agent/agentRuntimeService';
import { executeAgentResponse } from '../services/agent/commandExecutorService';
import { resolveInboundPhoneLineRouting } from '../services/phoneLineRoutingService';
import { normalizeWorkspaceTemplateId, seedWorkspaceTemplate } from '../services/workspaceTemplateService';

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
