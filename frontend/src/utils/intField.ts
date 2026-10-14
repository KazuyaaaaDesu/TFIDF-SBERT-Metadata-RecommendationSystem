/**
 * INTEGER FIELD VALIDATION
 *
 * The tournament's number settings are text boxes (a number input that
 * coerces on every keystroke cannot be cleared and retyped). This is the
 * strict check behind them: what the person typed is either a whole
 * number in range, or there is a one-line reason it is not.
 */

/** Why `raw` is not an acceptable whole number in [min, max], or null. */
export function intFieldError(
  raw: string,
  min: number,
  max: number,
): string | null {
  const text = raw.trim();

  if (text === "") return "Required.";

  if (/^[+-]?\d+[.,]\d*$|^[+-]?\d*[.,]\d+$/.test(text)) {
    return "Whole numbers only (no decimals).";
  }

  if (/^-\d+$/.test(text)) {
    if (min >= 0) return "Can't be negative.";

    const n = Number(text);

    if (!Number.isSafeInteger(n) || n < min) return `Must be at least ${min}.`;
    if (n > max) return `Must be at most ${max}.`;

    return null;
  }

  if (!/^\d+$/.test(text)) {
    return "Digits only (0-9).";
  }

  // Beyond 15 digits Number() loses precision; it is out of range anyway.
  if (text.replace(/^0+/, "").length > 15) return `Must be at most ${max}.`;

  const n = Number(text);

  if (n < min) return `Must be at least ${min}.`;
  if (n > max) return `Must be at most ${max}.`;

  return null;
}
