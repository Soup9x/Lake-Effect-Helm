/**
 * Turning what somebody typed into a tag list.
 *
 * Commas, because the bulk toolbar taught everyone to type three tags that way
 * and a control that accepted only one at a time would be used once.
 *
 * Extracted from the component so the rules are testable without a DOM: this
 * repository has no jsdom, and the parts of a form worth asserting are the
 * decisions, not the markup.
 */
export function parseTagDraft(draft: string, existing: readonly string[] = []): string[] {
  const have = new Set(existing);
  const out: string[] = [];
  for (const raw of draft.split(',')) {
    const tag = raw.trim();
    // Already on the record, already in this batch, or empty. Sending a
    // duplicate is harmless — the UPDATE is a set union — but it makes the
    // optimistic list show the same chip twice until the refresh corrects it.
    if (!tag || have.has(tag)) continue;
    have.add(tag);
    out.push(tag);
  }
  return out;
}
