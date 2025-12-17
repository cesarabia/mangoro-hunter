import test from 'node:test';
import assert from 'node:assert/strict';
import { repairAgentResponseBeforeValidation } from './agentResponseRepair';
import { AgentResponseSchema } from './commandSchema';
import { validateAgentResponseSemantics } from './semanticValidation';

test('repairAgentResponseBeforeValidation fills UPSERT_PROFILE_FIELDS.patch from parameters', () => {
  const input: any = {
    agent: 'Hunter CRM',
    version: 1,
    commands: [
      {
        command: 'UPSERT_PROFILE_FIELDS',
        contactId: 'contact-1',
        parameters: {
          comuna: 'Puente Alto',
          ciudad: 'Santiago',
          region: 'Región Metropolitana',
        },
      },
      {
        command: 'SEND_MESSAGE',
        conversationId: 'c-1',
        channel: 'WHATSAPP',
        type: 'SESSION_TEXT',
        text: 'ok',
        dedupeKey: 'k-1',
      },
    ],
  };

  const repaired = repairAgentResponseBeforeValidation(input);
  assert.equal(typeof repaired?.commands?.[0]?.patch, 'object');
  const parsed = AgentResponseSchema.safeParse(repaired);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    const cmd = parsed.data.commands[0];
    assert.equal(cmd.command, 'UPSERT_PROFILE_FIELDS');
    if (cmd.command !== 'UPSERT_PROFILE_FIELDS') return;
    assert.deepEqual(cmd.patch, {
      comuna: 'Puente Alto',
      ciudad: 'Santiago',
      region: 'Región Metropolitana',
    });
  }
});

test('repairAgentResponseBeforeValidation fills UPSERT_PROFILE_FIELDS.patch from top-level keys', () => {
  const input: any = {
    agent: 'Hunter CRM',
    version: 1,
    commands: [
      {
        command: 'UPSERT_PROFILE_FIELDS',
        contactId: 'contact-1',
        comuna: 'Puente Alto',
        ciudad: 'Santiago',
        experienceYears: '2',
        terrainExperience: 'sí',
      },
      {
        command: 'SEND_MESSAGE',
        conversationId: 'c-1',
        channel: 'WHATSAPP',
        type: 'SESSION_TEXT',
        text: 'ok',
        dedupeKey: 'k-1',
      },
    ],
  };

  const repaired = repairAgentResponseBeforeValidation(input);
  const parsed = AgentResponseSchema.safeParse(repaired);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    const cmd = parsed.data.commands[0];
    assert.equal(cmd.command, 'UPSERT_PROFILE_FIELDS');
    if (cmd.command !== 'UPSERT_PROFILE_FIELDS') return;
    assert.deepEqual(cmd.patch, {
      comuna: 'Puente Alto',
      ciudad: 'Santiago',
      experienceYears: 2,
      terrainExperience: true,
    });
  }
});

test('repairAgentResponseBeforeValidation fills SEND_MESSAGE.text from payload', () => {
  const input: any = {
    agent: 'Hunter CRM',
    version: 1,
    commands: [
      {
        command: 'SEND_MESSAGE',
        conversationId: 'c-1',
        channel: 'WHATSAPP',
        type: 'SESSION_TEXT',
        payload: { text: 'Hola!' },
        dedupeKey: 'k-1',
      },
    ],
  };

  const repaired = repairAgentResponseBeforeValidation(input);
  const parsed = AgentResponseSchema.safeParse(repaired);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const cmd = parsed.data.commands[0];
  assert.equal(cmd.command, 'SEND_MESSAGE');
  if (cmd.command !== 'SEND_MESSAGE') return;
  assert.equal(cmd.text, 'Hola!');
  assert.deepEqual(validateAgentResponseSemantics(parsed.data), []);
});

test('repairAgentResponseBeforeValidation converts SESSION_TEXT->TEMPLATE when templateName exists', () => {
  const input: any = {
    agent: 'Hunter CRM',
    version: 1,
    commands: [
      {
        command: 'SEND_MESSAGE',
        conversationId: 'c-1',
        channel: 'WHATSAPP',
        type: 'SESSION_TEXT',
        templateName: 'postulacion_completar_1',
        dedupeKey: 'k-1',
      },
    ],
  };

  const repaired = repairAgentResponseBeforeValidation(input);
  const parsed = AgentResponseSchema.safeParse(repaired);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const cmd = parsed.data.commands[0];
  assert.equal(cmd.command, 'SEND_MESSAGE');
  if (cmd.command !== 'SEND_MESSAGE') return;
  assert.equal(cmd.type, 'TEMPLATE');
  assert.deepEqual(validateAgentResponseSemantics(parsed.data), []);
});
