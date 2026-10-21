/**
 * Which kinds of entry can be copied, shared by the server (copyEntries) and
 * the lists that offer "Make a copy". A procedure is versions and steps, and a
 * custom record keeps secret pointers inside its data; copy_asset() refuses
 * both (1020).
 */
export const UNCOPYABLE_KINDS: ReadonlySet<string> = new Set(['sop', 'flexible_asset']);

export const isCopyable = (nodeType: string | null | undefined): boolean =>
  Boolean(nodeType) && !UNCOPYABLE_KINDS.has(nodeType!);
