import { AgentResponse } from './commandSchema';

export type SemanticIssue = {
  path: Array<string | number>;
  message: string;
};

export function validateAgentResponseSemantics(response: AgentResponse): SemanticIssue[] {
  const issues: SemanticIssue[] = [];

  response.commands.forEach((cmd: any, idx: number) => {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.command === 'SEND_MESSAGE') {
      if (cmd.type === 'SESSION_TEXT') {
        const text = typeof cmd.text === 'string' ? cmd.text.trim() : '';
        if (!text) {
          issues.push({
            path: ['commands', idx, 'text'],
            message: 'SEND_MESSAGE requiere "text" cuando type=SESSION_TEXT',
          });
        }
      }
      if (cmd.type === 'TEMPLATE') {
        const name = typeof cmd.templateName === 'string' ? cmd.templateName.trim() : '';
        if (!name) {
          issues.push({
            path: ['commands', idx, 'templateName'],
            message: 'SEND_MESSAGE requiere "templateName" cuando type=TEMPLATE',
          });
        }
      }
    }
  });

  return issues;
}

