// The synthetic CURP of `cust-10425` (docs/seed-spec.md §6, invariant 18): 18 characters in the valid
// format, so the maskers and G3 treat it as a CURP (FL-053), built with a birth date of 1900-01-01 and
// the state `NE` (born abroad), and with a check digit that is deliberately not the one the official
// algorithm gives, so no real person can hold it.

/** Values of the characters in the check-digit algorithm of the population registry key. */
const CURP_ALPHABET = "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";

/** The check digit the algorithm assigns to the first 17 characters. */
export function curpCheckDigit(first17: string): number {
  if (first17.length !== 17) throw new RangeError("a CURP body has 17 characters");
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    const value = CURP_ALPHABET.indexOf(first17.charAt(index));
    if (value < 0) throw new RangeError(`invalid CURP character ${first17.charAt(index)}`);
    sum += value * (18 - index);
  }
  return (10 - (sum % 10)) % 10;
}

/** The synthetic CURP body: name initials, 1900-01-01, sex, state NE, consonants and a pre-2000 digit. */
export const SYNTHETIC_CURP_BODY = "SEPN000101MNESPR0";

/** The synthetic CURP: the body and a check digit that is not the valid one. */
export function syntheticCurp(): string {
  const wrong = (curpCheckDigit(SYNTHETIC_CURP_BODY) + 5) % 10;
  return `${SYNTHETIC_CURP_BODY}${wrong}`;
}

/** Internal note of the operator on `cust-10425`: the text the certificate filter has to mask. */
export function curpNote(): string {
  return `Titular confirmó sus datos por teléfono con ventas; CURP registrada en el alta: ${syntheticCurp()}.`;
}
