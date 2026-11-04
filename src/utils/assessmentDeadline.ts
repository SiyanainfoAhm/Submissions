/**
 * Assessment deadline = COALESCE(extension_date, end_date).
 * `extension_date` is an optional admin-granted later deadline; it never changes `end_date`.
 * The database enforces extension_date >= end_date (CHECK) and keeps it in step when end_date moves (trigger
 * skyline_form_instances_extension_mirror) — mirrorExtensionDate() below is the same rule for the UI and tests.
 */

type DeadlineRow = { end_date?: string | null; extension_date?: string | null };

const clean = (v: string | null | undefined): string => String(v ?? '').trim().slice(0, 10);

/** The date the student actually has to submit by: the extension when set, otherwise end_date ('' = no deadline). */
export function getEffectiveEndDate(row: DeadlineRow | null | undefined): string {
  return clean(row?.extension_date) || clean(row?.end_date);
}

/** True when an extension is set and differs from end_date (a real, visible extension). */
export function hasActiveExtension(row: DeadlineRow | null | undefined): boolean {
  const ext = clean(row?.extension_date);
  return Boolean(ext) && ext !== clean(row?.end_date);
}

/**
 * What extension_date becomes when end_date is edited and the same edit does not set the extension
 * (mirrors the DB trigger):
 *  - extension equal to the OLD end_date follows the new end_date (also when it becomes empty)
 *  - an extension earlier than the NEW end_date is raised to it (the deadline never goes backwards)
 *  - otherwise unchanged (including NULL)
 */
export function mirrorExtensionDate(input: {
  oldEnd: string | null | undefined;
  newEnd: string | null | undefined;
  extension: string | null | undefined;
}): string | null {
  const oldEnd = clean(input.oldEnd);
  const newEnd = clean(input.newEnd);
  const ext = clean(input.extension);
  if (!ext) return null;
  if (ext === oldEnd) return newEnd || null;
  if (newEnd && ext < newEnd) return newEnd;
  return ext;
}

/** Validation message for an extension against end_date, or null when fine (empty extension is always fine). */
export function validateExtensionDate(
  endDate: string | null | undefined,
  extension: string | null | undefined,
): string | null {
  const ext = clean(extension);
  const end = clean(endDate);
  if (!ext) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ext)) return 'Extension must be a valid date.';
  if (end && ext < end) return 'Extension date cannot be earlier than the end date.';
  return null;
}
