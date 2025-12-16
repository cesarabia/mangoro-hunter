import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentResponseSemantics } from './semanticValidation';

test('validateAgentResponseSemantics flags missing text for SESSION_TEXT', () => {
  const issues = validateAgentResponseSemantics({
    agent: 'test',
    version: 1,
    commands: [
      {
        command: 'SEND_MESSAGE',
        conversationId: 'c1',
        channel: 'WHATSAPP',
        type: 'SESSION_TEXT',
        dedupeKey: 'k1',
      } as any,
    ],
  });
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].path, ['commands', 0, 'text']);
});

test('validateAgentResponseSemantics flags missing templateName for TEMPLATE', () => {
  const issues = validateAgentResponseSemantics({
    agent: 'test',
    version: 1,
    commands: [
      {
        command: 'SEND_MESSAGE',
        conversationId: 'c1',
        channel: 'WHATSAPP',
        type: 'TEMPLATE',
        dedupeKey: 'k1',
      } as any,
    ],
  });
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].path, ['commands', 0, 'templateName']);
});

test('validateAgentResponseSemantics accepts valid SESSION_TEXT', () => {
  const issues = validateAgentResponseSemantics({
    agent: 'test',
    version: 1,
    commands: [
      {
        command: 'SEND_MESSAGE',
        conversationId: 'c1',
        channel: 'WHATSAPP',
        type: 'SESSION_TEXT',
        text: 'Hola',
        dedupeKey: 'k1',
      } as any,
    ],
  });
  assert.equal(issues.length, 0);
});

