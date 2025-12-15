export function normalizeEscapedWhitespace(value: string): string {
  if (!value) return '';
  return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

