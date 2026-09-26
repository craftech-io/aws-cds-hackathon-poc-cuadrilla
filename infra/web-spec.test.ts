import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { API_PREFIX } from "../packages/bff/src/routers/api-path";
import { CONSOLE_CSP } from "./ci-spec";
import { ANONYMOUS_IP_HEADER_AT_ORIGIN } from "./waf-spec";
import {
  API_PATH,
  API_PATH_PATTERN,
  EDGE_BUDGETS,
  ORIGIN_VERIFY_HEADER,
  VIEWER_ADDRESS_HEADER,
  WAF_CSP_SOURCES,
  WAF_SDK_ORIGIN,
  WAF_TOKEN_ORIGIN,
  apiOriginRequestPolicyName,
  LAMBDA_ROUTES,
  LEGAL_PAGES,
  ROUTER_READ_TIMEOUT_MAX_SECONDS,
  STATIC_FILE_OPTIONS,
  lambdaRouteFor,
  legalUrl,
  routeMatches,
  type EdgeFunction,
} from "./web-spec";

const EDGE_FUNCTIONS = Object.keys(LAMBDA_ROUTES) as EdgeFunction[];
const web = readFileSync(resolve(process.cwd(), "infra/web.ts"), "utf8");
const dns = readFileSync(resolve(process.cwd(), "infra/dns.ts"), "utf8");

/** Mirrors SST's upload: entries are applied in reverse and a file keeps the first one that matches. */
function optionFor(file: string) {
  const toRegex = (glob: string) =>
    new RegExp(
      `^${glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "\u0000")
        .replace(/\*\*/g, "\u0001")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, "(?:.*/)?")
        .replace(/\u0001/g, ".*")}$`,
    );
  return [...STATIC_FILE_OPTIONS].reverse().find((option) => toRegex(option.files).test(file));
}

describe("domain", () => {
  it("serves the app on cuadrilla.demo.craftech.io inside the delegated demos zone", () => {
    expect(dns).toContain('export const ZONE_ID = "Z043097217S4W7QWXU5O0";');
    expect(dns).toContain('export const PRODUCT_SUBDOMAIN = "cuadrilla";');
    expect(dns).not.toMatch(/export const \w*(sim|inbound|mx)\w*/i);
    expect(dns).toContain("sst.aws.dns({ zone: ZONE_ID })");
    expect(web).toMatch(/domain: \{\n\s+name: appDomain,\n\s+dns,\n\s+\}/);
  });
});

describe("router layout", () => {
  it("uses the prefix the BFF handler strips", () => {
    expect(API_PATH).toBe(API_PREFIX);
  });

  it("reserves /api for the BFF and sends everything else to the console", () => {
    expect(Object.keys(LAMBDA_ROUTES)).toEqual(["bff"]);
    expect(lambdaRouteFor("/api/orders.list")).toBe("bff");
    expect(lambdaRouteFor("/api")).toBe("bff");
    for (const uri of ["/", "/app/orders", "/join", "/u/abc123", "/upload", "/apix", "/legal/privacy.html", "/login"]) {
      expect(lambdaRouteFor(uri)).toBeUndefined();
    }
  });

  it("matches on segment boundaries like the Router's CloudFront function", () => {
    expect(routeMatches(API_PATH, "/api")).toBe(true);
    expect(routeMatches(API_PATH, "/api/health")).toBe(true);
    expect(routeMatches(API_PATH, "/apix")).toBe(false);
    expect(routeMatches("/", "/anything")).toBe(true);
  });

  it("keeps the prefixes disjoint so no route shadows another", () => {
    const prefixes = Object.values(LAMBDA_ROUTES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const a of prefixes) for (const b of prefixes) if (a !== b) expect(routeMatches(a, b)).toBe(false);
    for (const prefix of prefixes) expect(prefix).toMatch(/^\/[a-z]+$/);
  });

  it("serves the legal pages from the console bucket, never from a Lambda", () => {
    expect(LEGAL_PAGES).toEqual({ privacy: "/legal/privacy.html", terms: "/legal/terms.html" });
    for (const page of Object.values(LEGAL_PAGES)) expect(lambdaRouteFor(page)).toBeUndefined();
    expect(legalUrl("cuadrilla.demo.craftech.io", "privacy")).toBe("https://cuadrilla.demo.craftech.io/legal/privacy.html");
  });

  it("declares no inline routes, so bff.ts can attach its functions with url.router", () => {
    expect(web).not.toMatch(/\broutes:/);
    expect(web).toContain('protection: "none"');
  });
});

describe("edge budgets", () => {
  it("keeps every route timeout inside CloudFront's limits", () => {
    for (const fn of EDGE_FUNCTIONS) {
      const { routerReadTimeoutSeconds } = EDGE_BUDGETS[fn];
      expect(routerReadTimeoutSeconds).toBeGreaterThanOrEqual(1);
      expect(routerReadTimeoutSeconds).toBeLessThanOrEqual(ROUTER_READ_TIMEOUT_MAX_SECONDS);
    }
  });

  it("ends buffered Lambdas before CloudFront stops waiting for them", () => {
    for (const fn of EDGE_FUNCTIONS) expect(EDGE_BUDGETS[fn].timeoutSeconds).toBeLessThan(EDGE_BUDGETS[fn].routerReadTimeoutSeconds);
  });

  it("stays within Lambda's memory range and reserves the concurrency of docs/architecture.md §12", () => {
    for (const fn of EDGE_FUNCTIONS) {
      expect(EDGE_BUDGETS[fn].memoryMb).toBeGreaterThanOrEqual(128);
      expect(EDGE_BUDGETS[fn].memoryMb).toBeLessThanOrEqual(10_240);
    }
    expect(EDGE_BUDGETS.bff.reservedConcurrency).toBe(10);
  });
});

describe("static file options", () => {
  it("caches hashed bundles forever and HTML never", () => {
    expect(optionFor("assets/index-3f9a.js")?.cacheControl).toContain("immutable");
    expect(optionFor("index.html")?.cacheControl).toContain("no-store");
    expect(optionFor("brand/logo-craftech-color.svg")?.cacheControl).toBe("max-age=3600,public");
  });

  it("serves the legal pages publicly as UTF-8 HTML with a short cache", () => {
    for (const page of Object.values(LEGAL_PAGES)) {
      const option = optionFor(page.slice(1));
      expect(option?.contentType).toBe("text/html; charset=utf-8");
      expect(option?.cacheControl).toBe("max-age=300,public");
    }
  });
});

// ---- The edge of the own sign-up (ADR-0025 §3 and §4, docs/test-plan.md §3) ---------------------------

const template = readFileSync(resolve(process.cwd(), "infra/bootstrap/ci-role.yaml"), "utf8");
const directive = (name: string): string[] => (CONSOLE_CSP.split("; ").find((entry) => entry.startsWith(`${name} `)) ?? "").split(" ").slice(1);

describe("CSP of the console with AWS WAF's silent challenge [FL-114]", () => {
  it("loads the WAF SDK only from *.sdk.awswaf.com and talks to it and to *.token.awswaf.com", () => {
    expect([WAF_SDK_ORIGIN, WAF_TOKEN_ORIGIN]).toEqual(["https://*.sdk.awswaf.com", "https://*.token.awswaf.com"]);
    expect(directive("script-src")).toEqual(["'self'", WAF_SDK_ORIGIN]);
    expect(directive("connect-src")).toEqual(expect.arrayContaining([WAF_SDK_ORIGIN, WAF_TOKEN_ORIGIN]));
    expect(directive("connect-src").filter((source) => source.includes("awswaf"))).toEqual([...WAF_CSP_SOURCES["connect-src"]]);
    for (const other of ["img-src", "media-src", "default-src", "style-src", "font-src"]) expect(directive(other).join(" "), other).not.toContain("awswaf");
    expect(CONSOLE_CSP).not.toMatch(/captcha\.awswaf|https:\/\/\*\.awswaf\.com/);
  });

  it("is the CSP the bootstrap's response headers policy applies", () => {
    expect(template).toContain(`ContentSecurityPolicy: !Sub "${CONSOLE_CSP}"`);
  });
});

describe("origin of /api/* [FL-114]", () => {
  it("names the origin header, the viewer's address and the WAF header the Bff reads", () => {
    expect(ORIGIN_VERIFY_HEADER).toBe("x-cuadrilla-origin");
    expect(VIEWER_ADDRESS_HEADER).toBe("CloudFront-Viewer-Address");
    expect(ANONYMOUS_IP_HEADER_AT_ORIGIN).toBe("x-amzn-waf-cuadrilla-anon");
    expect(API_PATH_PATTERN).toBe("/api/*");
  });

  it("forwards every viewer value and CloudFront-Viewer-Address on /api/* by the bootstrap's policy", () => {
    expect(apiOriginRequestPolicyName("aws-cds-hackathon-poc-cuadrilla", "poc")).toBe("aws-cds-hackathon-poc-cuadrilla-poc-api");
    const policy = template.slice(template.indexOf("  ApiOriginRequestPolicy:"), template.indexOf("  # ---- Permissions boundary"));
    expect(policy).toContain('Name: !Sub "${AppName}-${DeployStage}-api"');
    expect(policy).toContain("HeaderBehavior: allViewerAndWhitelistCloudFront");
    expect(policy).toContain(`Headers: [${VIEWER_ADDRESS_HEADER}]`);
    expect(policy).toContain("QueryStringBehavior: all");
    expect(web).toContain("aws.cloudfront.getOriginRequestPolicyOutput({ name: apiOriginRequestPolicyName($app.name, $app.stage) })");
  });

  it("puts the origin header on the distribution's origins from OriginVerifyKey, never a literal", () => {
    expect(web).toContain("$util.all([origins, OriginVerifyKey.value])");
    expect(web).toContain("{ name: ORIGIN_VERIFY_HEADER, value: key }");
    expect(web).not.toMatch(/x-cuadrilla-origin["']\s*,\s*value:\s*["']/);
  });
});
