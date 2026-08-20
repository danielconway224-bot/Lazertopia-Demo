// The Lasertopia Acknowledgement and Release, transcribed from lasertopia.ca/waiver.
//
// ⚠️  LEGAL TEXT — DO NOT EDIT FOR STYLE.
//
// Reproduced word for word, including the punctuation and spacing of the original. Several
// clauses run words together ("REIMBURSE(indemnify)any", "18,a parent") and clause 5 says
// "manages" where it plainly means "managers". Those are in the source document and are
// left alone: a waiver has to say what the business published, not a tidied-up version, and
// silently correcting a legal instrument is not ours to do.
//
// ⚠️  CLAUSE 9 IS INCOMPLETE. Only its tail was legible in the source we transcribed from.
// It is marked below and shown to the customer as-is rather than guessed at. Get the full
// wording from Lasertopia before this waiver is relied on.
//
// TERMS_VERSION is stored on every signature. When the wording changes, change the version
// too — a waiver from last year has to prove what THAT person agreed to, not what the
// current text happens to say.

export const TERMS_VERSION = '2026-08-lasertopia.ca';

export const WAIVER_TITLE = 'Lasertopia Acknowledgement and Release';

export const WAIVER_PREAMBLE =
  'FOR AND IN CONSIDERATION OF THE ADMISSION PRICE AND THE PERMISSION TO USE THE '
  + 'LASERTOPIA INC. FACILITIES: YOU HEREBY AGREE TO AND ACKNOWLEDGE THE FOLLOWING:';

export const WAIVER_CLAUSES = [
  'That you are at least 18 years of age and understand that by signing this Acknowledgement '
  + 'and Release you are waiving certain legal rights, including the right to sue, If you are '
  + 'under the age of 18,a parent, guardian, or accompanying adult must read and sign this '
  + 'document along with you.',

  'That you are only authorized to use the LASERTOPIA INC, premises and facilities, which '
  + 'includes the building, all fixtures and accessories connected to it, the surrounding '
  + 'parking area and the equipment associated with the operation of the foregoing (the '
  + '"LASERTOPIA INC. Facilities"),upon the proper execution of this Acknowledgement and Release.',

  'That this Acknowledgment and Release is a material part of this consideration and the '
  + 'agreement between you and LASERTOPIA INC. for the admission to and use of the LASERTOPIA '
  + 'INC. Facilities.',

  'That you acknowledge that the owners and operators of LASERTOPIA INC. have employed '
  + 'diligent efforts and care in making the LASERTOPIA INC. facilities as safe as possible; '
  + 'and that despite the foregoing efforts, you are AWARE OF THE RISKS,DANGERS,AND HAZARDS '
  + 'ASSOCIATED WITH USING THE LASERTOPIA INC. facilities, which risks include, but are not '
  + 'limited to, possible trips, falls, collisions with other people/objects, AND FREELY '
  + 'ACKNOWLEDGE SUCH RISKS AND THE POSSIBILITY THAT YOU MAY SUFFER PERSONAL INJURY,DEATH,'
  + 'PROPERTY DAMAGE OR LOSS and agree to use the LASERTOPIA INC. facilities with the full '
  + 'understanding of same.',

  'That you will HOLD LASERTOPIA INC. ITS OWNERS, DIRECTORS, OFFICERS, MANAGERS, AGENTS, AND '
  + 'EMPLOYEES HARMLESS FROM AND WILL REIMBURSE(indemnify)any and all liability for any '
  + 'property damage or personal injury suffered by anyone, resulting from your use of the '
  + 'LASERTOPIA INC. facilities and agree to RELEASE,INDEMNIFY AND HOLD LASERTOPIA INC., its '
  + 'owners, directors, officers, manages, agents and employees HARMLESS FROM SAID INJURIES OR '
  + 'ANY COSTS OR EXPENSES ASSOCIATED THEREWITH due to any cause whatsoever including '
  + 'negligence, gross negligence, breach of contract, or breach of any statutory or other duty '
  + 'of care owed under the Occupiers Liability Act on the part of LASERTOPIA INC. its owners, '
  + 'directors, officers, managers, agents, employees and representatives.',

  'That you agree to obey all rules and regulations for the use of the LASERTOPIA INC. '
  + 'facilities which are posted throughout the premises, and all directions, if any, given by '
  + 'LASERTOPIA INC. representatives while in the LASERTOPIA INC. facility.',

  'That you specifically agree to allow the employees, directors, representatives or agents of '
  + 'LASERTOPIA INC.to make use of any photographs or video taken of you or your likeness while '
  + 'in the LASERTOPIA INC. facilities for promotional purposes including use on the LASERTOPIA '
  + 'INC, website and that all such photographs or videos are the property of LASERTOPIA INC. '
  + 'and may be used without further permission or consent.',

  'That any person playing laser tag is 6 YEARS OF AGE OR OLDER on the day of play.',

  // ⚠️ INCOMPLETE — only the tail of this clause was legible in the source.
  '[…] acknowledge that any questions about the content of this document or use of the '
  + 'premises and facilities have been answered by a representative of LASERTOPIA INC.',
];

/** Index (1-based) of any clause known to be incomplete, so the page can say so. */
export const INCOMPLETE_CLAUSES = [9];

export const WAIVER_VALIDITY_NOTE = 'Waiver valid for one year from Today’s Date';

/** How Lasertopia asks people where they heard about them. */
export const HEARD_ABOUT_OPTIONS = ['Web Search', 'Social Media', 'Family/Friends'];

/** A waiver lasts a year. Derived, never stored — a stored date can disagree with the row. */
export const WAIVER_VALID_MONTHS = 12;

/** Whole years old on a given date. Used for the under-18 guardian rule. */
export function ageOn(dobISO, onISO) {
  const dob = new Date(`${dobISO}T00:00:00`);
  const on = new Date(`${onISO}T00:00:00`);
  if (Number.isNaN(dob.getTime()) || Number.isNaN(on.getTime())) return null;
  let age = on.getFullYear() - dob.getFullYear();
  const m = on.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && on.getDate() < dob.getDate())) age -= 1;
  return age;
}
