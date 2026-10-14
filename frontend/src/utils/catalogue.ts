/**
 * Card-catalogue helpers for the Repository list: an accession number
 * (the paper's id, zero-padded) and a spine colour per subject.
 *
 * The spine is a mix of the theme's accent and ink, in one of six
 * steps picked by a hash of the subject name, so papers of one subject
 * share a spine and different subjects usually differ, while every
 * colour still follows the active skin and dark mode.
 */

export const SPINE_STEPS = 6;

/** "№ 0412" for paper 412. */
export function accession(id: number): string {
  return `№ ${String(Math.max(0, Math.trunc(id))).padStart(4, "0")}`;
}

/** Stable small integer from a subject name; case and spacing are ignored. */
export function subjectHash(subject: string): number {
  const text = subject.trim().toLowerCase().replace(/\s+/g, " ");
  let hash = 5381;

  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }

  return hash;
}

/** A CSS colour for the subject's spine, or null when it has no subject. */
export function spineColor(subject: string | null | undefined): string | null {
  if (!subject || !subject.trim()) return null;

  const step = subjectHash(subject) % SPINE_STEPS;
  // 100% accent ... 0% accent (all ink), evenly spaced
  const accent = Math.round(100 - (step * 100) / (SPINE_STEPS - 1));

  return `color-mix(in srgb, rgb(var(--accent)) ${accent}%, rgb(var(--gray-700)))`;
}
