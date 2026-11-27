// The account's phone (ADR-0029 §1, docs/test-plan.md, FL-123): E.164, filler, ranges that are no
// person's mobile, only the Americas and the home region of the foreign SMS quota.
import { describe, expect, it } from "vitest";
import { AMERICAS_PREFIXES, HOME_PREFIXES, NON_PERSONAL_PREFIXES, isAmericasNumber, isHomeNumber, parseAccountPhone } from "./number";

const reasonOf = (raw: string): string | undefined => {
  try {
    parseAccountPhone(raw);
    return undefined;
  } catch (error) {
    return (error as { reason?: string }).reason;
  }
};

describe("the account's phone [FL-123]", () => {
  it("[FL-123] keeps an international number without separators", () => {
    expect(parseAccountPhone("+52 (55) 1234-5678")).toBe("+525512345678");
    expect(parseAccountPhone("+1 416 555 0123")).toBe("+14165550123");
  });

  it("[FL-123] a number that ends in seven or more equal digits is filler: PHONE_INVALID", () => {
    for (const raw of ["+5491100000000", "+52 55 1111 1111", "+34 699 999 999"]) expect(reasonOf(raw)).toBe("PHONE_INVALID");
    expect(reasonOf("+525500000012")).toBeUndefined();
  });

  it("[FL-123] every range that is no person's mobile is PHONE_NOT_PERSONAL, typed with or without separators", () => {
    expect(NON_PERSONAL_PREFIXES).toEqual(["+3197", "+4470", "+882", "+883", "+870", "+881", "+888", "+979"]);
    for (const prefix of NON_PERSONAL_PREFIXES) expect(reasonOf(`${prefix}12345678`), prefix).toBe("PHONE_NOT_PERSONAL");
    expect(reasonOf("+31 97 0123 456 789")).toBe("PHONE_NOT_PERSONAL");
    // The neighbours of those ranges are people's phones (refused only because they are outside the Americas).
    for (const raw of ["+31612345678", "+447911123456", "+8613812345678"]) expect(reasonOf(raw)).toBe("PHONE_COUNTRY_NOT_ALLOWED");
  });

  it("[FL-123] only the Americas: +1 and +5 are accepted; Europe, Asia, Africa and Oceania are PHONE_COUNTRY_NOT_ALLOWED", () => {
    expect(AMERICAS_PREFIXES).toEqual(["+1", "+5"]);
    for (const raw of ["+14155550101", "+1 (416) 555-0123", "+525512345678", "+5491123456781", "+51912345678", "+5352345678", "+50937123456", "+59899123456"]) expect(reasonOf(raw), raw).toBeUndefined();
    for (const raw of ["+34612345678", "+447911123456", "+4915112345678", "+33612345678", "+358401234567", "+819012345678", "+8613812345678", "+919812345678", "+27821234567", "+61412345678"]) {
      expect(reasonOf(raw), raw).toBe("PHONE_COUNTRY_NOT_ALLOWED");
    }
    expect(isAmericasNumber("+18095550123")).toBe(true);
    expect(isAmericasNumber("+34612345678")).toBe(false);
  });

  it("[FL-123] the home region is Latin America (Spain no longer); the rest of the Americas is foreign", () => {
    expect(HOME_PREFIXES).toHaveLength(20);
    expect(HOME_PREFIXES).not.toContain("+34");
    for (const phone of ["+5491123456781", "+5511912345678", "+56912345678", "+573001234567", "+525512345678", "+51912345678", "+59899123456", "+595981123456", "+59171234567", "+593991234567", "+584121234567", "+50688123456", "+50761234567", "+50251234567", "+50371234567", "+50491234567", "+50581234567", "+18095550123", "+18295550123", "+18495550123"]) {
      expect(isHomeNumber(phone), phone).toBe(true);
    }
    for (const phone of ["+14155550101", "+18885550123", "+5352345678", "+50937123456", "+5012345678", "+34612345678"]) expect(isHomeNumber(phone), phone).toBe(false);
  });
});
