import { describe, expect, it } from "vitest";
import { parseFlags } from "./cli-args";

describe("parseFlags", () => {
  it("hands each flag its value and repeats a flag as often as it is given", () => {
    const isps: string[] = [];
    let apply = false;
    parseFlags(["--isp", "isp-demo", "--apply", "--isp", "isp-judge-01"], {
      "--isp": (value) => {
        isps.push(value());
      },
      "--apply": () => {
        apply = true;
      },
    });
    expect(isps).toEqual(["isp-demo", "isp-judge-01"]);
    expect(apply).toBe(true);
  });

  it("refuses a flag without its value and a flag it does not know", () => {
    const handlers = { "--stage": (value: () => string) => void value() };
    expect(() => parseFlags(["--stage"], handlers)).toThrow('--stage needs a value');
    expect(() => parseFlags(["--stage", "--apply"], handlers)).toThrow('--stage needs a value');
    expect(() => parseFlags(["--stag", "poc"], handlers)).toThrow('unknown argument "--stag"');
    expect(() => parseFlags(["toString"], handlers)).toThrow('unknown argument "toString"');
  });
});
