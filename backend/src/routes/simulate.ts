import { FastifyInstance } from 'fastify';
import { handleInboundWhatsAppMessage } from '../services/whatsappInboundService';
import { getAdminWaIdAllowlist, getSystemConfig, getTestWaIdAllowlist } from '../services/configService';
import { normalizeWhatsAppId } from '../utils/whatsapp';
import { prisma } from '../db/client';
import { runAutomations } from '../services/automationRunnerService';
import { piiSanitizeText } from '../services/agent/tools';
import { isWorkspaceAdmin, resolveWorkspaceAccess } from '../services/workspaceAuthService';
import { SCENARIOS, getScenario, ScenarioDefinition, ScenarioStep } from '../services/simulate/scenarios';
import { runAgent } from '../services/agent/agentRuntimeService';
import { resolveInboundPhoneLineRouting } from '../services/phoneLineRoutingService';

export async function registerSimulationRoutes(app: FastifyInstance) {
  const normalizeForContains = (value: string): string =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

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
              assertions.push({ ok: false, message: `owner user ${email} missing` });
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

        const phoneLine = await prisma.phoneLine
          .findFirst({ where: { workspaceId: wsId, archivedAt: null, isActive: true }, select: { id: true } })
          .catch(() => null);
        assertions.push({
          ok: Boolean(phoneLine?.id),
          message: phoneLine?.id ? 'ssclinicalStageAssign: phoneLine OK' : 'ssclinicalStageAssign: no active phoneLine in workspace',
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
          }
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
