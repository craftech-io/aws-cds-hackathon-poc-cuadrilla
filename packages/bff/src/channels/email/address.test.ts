import { describe, expect, it } from "vitest";
import { MAX_ADDRESS, isWithinDomain, parseEmailAddress } from "./address";

const char = (codePoint: number) => String.fromCodePoint(codePoint);

describe("parseEmailAddress", () => {
  it("accepts a dot-atom address with a sub-address tag and normalizes it to lower case", () => {
    expect(parseEmailAddress("success+c10421@simulator.amazonses.com")).toEqual({
      ok: true,
      address: { localPart: "success+c10421", domain: "simulator.amazonses.com", normalized: "success+c10421@simulator.amazonses.com" },
    });
    expect(parseEmailAddress("Success+G07-C10421@Simulator.AmazonSES.com")).toMatchObject({ ok: true, address: { domain: "simulator.amazonses.com", normalized: "success+g07-c10421@simulator.amazonses.com" } });
    expect(parseEmailAddress("o'neil.x_y=z@mail.co.mx")).toMatchObject({ ok: true });
  });

  it.each([
    ["", "EMPTY"],
    [`${"a".repeat(MAX_ADDRESS)}@x.io`, "TOO_LONG"],
    ["success@simulator.amazonses.com\r\nBcc: x@y.io", "CONTROL_CHARACTER"],
    [`success@simulator.amazonses.com${char(0)}`, "CONTROL_CHARACTER"],
    ["succéss@simulator.amazonses.com", "NON_ASCII"],
    [`success@simulat${char(0xf6)}r.amazonses.com`, "NON_ASCII"],
    [" success@simulator.amazonses.com", "WHITESPACE"],
    ["suc cess@simulator.amazonses.com", "WHITESPACE"],
    ['"success"@simulator.amazonses.com', "QUOTED"],
    ["Cuadrilla <success@simulator.amazonses.com>", "WHITESPACE"],
    ["<success@simulator.amazonses.com>", "DISPLAY_NAME"],
    ["success(comment)@simulator.amazonses.com", "DISPLAY_NAME"],
    ["success.simulator.amazonses.com", "MISSING_AT"],
    ["a@b@simulator.amazonses.com", "MULTIPLE_AT"],
    [".success@simulator.amazonses.com", "BAD_LOCAL_PART"],
    ["suc..cess@simulator.amazonses.com", "BAD_LOCAL_PART"],
    [`${"a".repeat(65)}@simulator.amazonses.com`, "BAD_LOCAL_PART"],
    ["@simulator.amazonses.com", "BAD_LOCAL_PART"],
    ["success@[192.0.2.10]", "IP_LITERAL"],
    ["success@simulator.amazonses.com.", "TRAILING_DOT"],
    ["success@xn--simulatr-u9a.amazonses.com", "IDN"],
    ["success@localhost", "BAD_DOMAIN"],
    ["success@-simulator.amazonses.com", "BAD_DOMAIN"],
    ["success@simulator..amazonses.com", "BAD_DOMAIN"],
    ["success@simulator.amazonses.c0m", "BAD_DOMAIN"],
    ["success@", "BAD_DOMAIN"],
  ])("refuses %j with %s", (raw, error) => {
    expect(parseEmailAddress(raw)).toEqual({ ok: false, error });
  });
});

describe("isWithinDomain", () => {
  it("matches the domain and its subdomains by whole labels, never by a suffix of a label", () => {
    expect(isWithinDomain("simulator.amazonses.com", "simulator.amazonses.com")).toBe(true);
    expect(isWithinDomain("mail.cuadrilla.demo.craftech.io", "cuadrilla.demo.craftech.io")).toBe(true);
    expect(isWithinDomain("evilsimulator.amazonses.com", "simulator.amazonses.com")).toBe(false);
    expect(isWithinDomain("simulator.amazonses.com.attacker.example", "simulator.amazonses.com")).toBe(false);
  });
});
