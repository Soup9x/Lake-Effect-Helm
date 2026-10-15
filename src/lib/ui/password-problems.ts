/**
 * The password-policy refusal, as the two forms that render it read it.
 *
 * The change-password and reset routes answer a policy failure with the list
 * of rules the candidate broke under `error.details.problems`, so a form can
 * show one line per rule rather than a semicolon-joined sentence. Two forms
 * read it; this is the one place that decides what shape counts.
 */
export function policyProblems(details: Record<string, unknown> | undefined): string[] | null {
  const problems = details?.problems;
  return Array.isArray(problems) && problems.every((p) => typeof p === 'string') ? problems : null;
}
