export function serializeJson(data: unknown): string {
  try {
    return JSON.stringify(data ?? null);
  } catch (err) {
    return JSON.stringify({ error: 'serialization_failed' });
  }
}
