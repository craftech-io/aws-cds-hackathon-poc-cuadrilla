// The account's phone (ADR-0029 §1, docs/test-plan.md, FL-123): E.164, filler, ranges that are no
// person's mobile and the home region of the foreign SMS quota.
import { describe, expect, it } from "vitest";
import { HOME_PREFIXES, NON_PERSONAL_PREFIXES, isHomeNumber, parseAccountPhone } from "./number";

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
    expect(parseAccountPhone("+44 20 7946 0018")).toBe("+442079460018");
  });

  it("[FL-123] a number that ends in seven or more equal digits is filler: PHONE_INVALID", () => {
    for (const raw of ["+5491100000000", "+52 55 1111 1111", "+34 699 999 999"]) expect(reasonOf(raw)).toBe("PHONE_INVALID");
    expect(reasonOf("+525500000012")).toBeUndefined();
  });

  it("[FL-123] every range that is no person's mobile is PHONE_NOT_PERSONAL, typed with or without separators", () => {
    expect(NON_PERSONAL_PREFIXES).toEqual(["+3197", "+4470", "+882", "+883", "+870", "+881", "+888", "+979"]);
    for (const prefix of NON_PERSONAL_PREFIXES) expect(reasonOf(`${prefix}12345678`), prefix).toBe("PHONE_NOT_PERSONAL");
    expect(reasonOf("+31 97 0123 456 789")).toBe("PHONE_NOT_PERSONAL");
    // The neighbours of those ranges are people's phones.
    for (const raw of ["+31612345678", "+447911123456", "+8613812345678"]) expect(reasonOf(raw)).toBeUndefined();
  });

  it("[FL-123] the home region is Latin America and Spain; the rest of +1 and every other country is foreign", () => {
    expect(HOME_PREFIXES).toHaveLength(21);
    for (const phone of ["+5491123456781", "+5511912345678", "+56912345678", "+573001234567", "+525512345678", "+51912345678", "+59899123456", "+595981123456", "+59171234567", "+593991234567", "+584121234567", "+50688123456", "+50761234567", "+50251234567", "+50371234567", "+50491234567", "+50581234567", "+18095550123", "+18295550123", "+18495550123", "+34612345678"]) {
      expect(isHomeNumber(phone), phone).toBe(true);
    }
    for (const phone of ["+14155550101", "+18885550123", "+447911123456", "+358401234567", "+4915112345678", "+5012345678"]) expect(isHomeNumber(phone), phone).toBe(false);
  });
});
