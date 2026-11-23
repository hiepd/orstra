/** Replace `{{ a.b.c }}` with values from `ctx`. Missing paths become empty strings; arrays join with ", ". */
export function renderTemplate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path: string) => {
    let cur: unknown = ctx;
    for (const part of path.split('.')) {
      if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        return '';
      }
    }
    if (cur === null || cur === undefined) return '';
    if (Array.isArray(cur)) return cur.join(', ');
    if (typeof cur === 'object') return JSON.stringify(cur);
    return String(cur);
  });
}
