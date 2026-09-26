import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AUTH_EMAIL_RENDERERS, RENDER_BRANDS, renderAuthEmails, type AuthEmailRenderer } from "./neutral-renderers";
import { DIST_DIR, README_FILE, decodeEscapes, formatFindings, isVisibleSource, productReadme, scanDist, scanSources, scanText } from "./neutral-surfaces";
import { NEUTRAL_TERMS, findNeutralTerms } from "./neutral-terms";

const REPO = process.cwd();
const ADR = "docs/adr/0023-superficies-publicas-neutrales.md";

/** The Spanish spelling of the words that carry an accent. */
const ACCENTED: Readonly<Record<string, string>> = { hackaton: "hackatón", certamenes: "certámenes", evaluacion: "evaluación" };

const termsOf = (source: string, text: string): string[] => scanText(source, text).map((finding) => finding.term);

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** A throwaway repository with these files; returns its root. */
function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "neutral-surfaces-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const noEmails: readonly AuthEmailRenderer[] = [];

describe("the list of words [FL-120]", () => {
  it("is the list of ADR-0023, in its order", () => {
    const line = readFileSync(resolve(REPO, ADR), "utf8")
      .split("\n")
      .find((text) => text.includes("Lista (en su forma sin acentos)"));
    expect(line).toBeDefined();
    const adrList = [...(line ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    expect(adrList).toHaveLength(40);
    expect([...NEUTRAL_TERMS]).toEqual(adrList);
  });

  it("is written without accents, in lower case", () => {
    for (const term of NEUTRAL_TERMS) expect(term).toMatch(/^[a-z]+( [a-z]+)?$/);
  });
});

describe("matching [FL-120]", () => {
  for (const term of NEUTRAL_TERMS) {
    it(`reports "${term}" in lower case, upper case, capitalized${term in ACCENTED ? ", with its accent" : ""} and inside a sentence`, () => {
      const variants = [term, term.toUpperCase(), term.charAt(0).toUpperCase() + term.slice(1), ...(ACCENTED[term] ? [ACCENTED[term], ACCENTED[term].toUpperCase()] : [])];
      for (const variant of variants) {
        expect(termsOf("f", variant), variant).toEqual([term]);
        expect(termsOf("f", `Esto es parte del ${variant}, como dijimos.`), variant).toEqual([term]);
        expect(termsOf("f", `(${variant})`), variant).toEqual([term]);
      }
    });
  }

  it("passes ordinary words, words that only contain a term and camelCase identifiers", () => {
    for (const text of ["evaluar", "Vamos a evaluar la potencia.", "prejuicio", "reevaluación", "contestar", "Nos contestó el cliente.", "premiado", "hackathonero", "concursante", "premiere", "evalScore", "evaluationTab", "juzgado", "awscds"]) {
      expect(termsOf("f", text), text).toEqual([]);
    }
  });

  it("splits words at a hyphen and at punctuation, as lint:forbidden does", () => {
    expect(termsOf("f", "evaluation-tab")).toEqual(["evaluation"]);
    expect(termsOf("f", "repo aws-cds-hackathon-poc")).toEqual(["hackathon"]);
    expect(termsOf("f", "Built for AWS  CDS partners")).toEqual(["aws cds"]);
  });

  it("names the source, the line and the word of every finding", () => {
    expect(findNeutralTerms("copy.ts", "hola\nel concurso dijo\nnada\nDevpost y Premio")).toEqual([
      { source: "copy.ts", line: 2, term: "concurso" },
      { source: "copy.ts", line: 4, term: "devpost" },
      { source: "copy.ts", line: 4, term: "premio" },
    ]);
    expect(formatFindings(scanText("copy.ts", "x\nJueces"))).toEqual(['  copy.ts:2  "jueces"']);
  });

  it("decodes HTML character references and JavaScript escapes before matching, keeping the lines", () => {
    expect(termsOf("f", "evaluaci&oacute;n")).toEqual(["evaluacion"]);
    expect(termsOf("f", "evaluaci&#243;n y cert&#xE1;menes")).toEqual(["certamenes", "evaluacion"]);
    // Several words on one line come in the list's order.
    expect(termsOf("f", '"Evaluaci\\u00f3n" "\\u{63}oncurso" "\\x6aury"')).toEqual(["concurso", "jury", "evaluacion"]);
    expect(termsOf("f", "AWS&nbsp;CDS")).toEqual(["aws cds"]);
    expect(decodeEscapes("a\\u000ab &#10;c \\u{110000}")).toBe("a b  c \\u{110000}");
    expect(scanText("f", "uno\\u000a devpost").map((finding) => finding.line)).toEqual([1]);
    // A control escape separates words: a word right after it is found, on the same line.
    const glued = JSON.stringify({ note: "Revisión lista.\nPremio\tcertamen\r\bdevpost\fhackathon" });
    expect(termsOf("f", glued).sort()).toEqual(["certamen", "devpost", "hackathon", "premio"]);
    expect(scanText("f", 'x\n"a\\nPremio"').map((finding) => finding.line)).toEqual([2]);
  });
});

describe("which files are visible sources [FL-120]", () => {
  it("covers every row of ADR-0023's table", () => {
    for (const path of [
      "packages/web/src/views/landing/copy.ts",
      "packages/web/src/app.tsx",
      "packages/web/index.html",
      "packages/web/public/legal/terms.html",
      "packages/web/public/landing/manifest.json",
      "packages/web/public/brand/logo.svg",
      "packages/bff/src/copy/es-MX.ts",
      "packages/bff/src/copy/auth-emails.en.ts",
      "packages/bff/src/certificates/render.ts",
      "packages/bff/src/leads/notify.ts",
      "packages/bff/src/story/main-story.ts",
      "packages/bff/src/agent/system-prompt.ts",
      "packages/bff/src/agent-tools/orders/schema.ts",
      "infra/agent-tool-schemas.ts",
      "infra/auth-email.ts",
      "scripts/seed/data/manual/v001.md",
      "scripts/seed/data/worlds/guest.json",
      "scripts/seed/photos/texts.ts",
      "scripts/seed/audio/texts.ts",
      "scripts/landing/capture.ts",
      "scripts/seed/photos/templates/acta-muestra.pdf",
      "tests/fixtures/acta-ejemplo.pdf",
    ]) {
      expect(isVisibleSource(path), path).toBe(true);
    }
  });

  it("leaves out the internal exceptions and the code that is not a surface", () => {
    for (const path of [
      "docs/build-plan.md",
      "docs/submission.pdf",
      "CLAUDE.md",
      "CONTEXT.md",
      ".claude/agents/devops.md",
      "tests/cases/FL-120.md",
      "tests/flows/guest.test.ts",
      "packages/web/e2e/login.spec.ts",
      "packages/web/src/lib/auth-claims.test.ts",
      "packages/web/src/views/landing/LandingView.test.tsx",
      "packages/bff/src/copy/keywords.test.ts",
      "packages/bff/src/agent/system-prompt.test.ts",
      "packages/bff/src/agent-tools/orders/handler.ts",
      "packages/bff/src/routers/index.ts",
      "packages/shared/src/enums.ts",
      "infra/auth.ts",
      "scripts/lint/neutral-terms.ts",
      "scripts/seed/generate/world.ts",
    ]) {
      expect(isVisibleSource(path), path).toBe(false);
    }
  });

  it("gives the seed's data no exception, not even a test file", () => {
    expect(isVisibleSource("scripts/seed/data/worlds/guest.test.ts")).toBe(true);
  });

  it("reads the README only up to the Submission notes heading", () => {
    const readme = "# Cuadrilla\n\nA field copilot.\n\n## Submission notes\n\nBuilt for a hackathon.\n";
    expect(productReadme(readme)).toBe("# Cuadrilla\n\nA field copilot.\n");
    expect(productReadme("# Cuadrilla\nno notes yet\n")).toBe("# Cuadrilla\nno notes yet\n");
  });
});

describe("scanning a repository [FL-120]", () => {
  const files = {
    "docs/adr/0099-x.md": "La entrega al hackathon y su premio.\n",
    "CLAUDE.md": "Contexto del concurso.\n",
    "tests/cases/FL-001.md": "Recorrido del certamen.\n",
    "packages/web/src/lib/claims.test.ts": 'it("counts the prizes", () => {});\n',
    "packages/web/e2e/landing.spec.ts": "// premio\n",
    "packages/web/src/lib/claims.ts": "// Marks a guest from the claims.\nexport const x = 1;\n",
    [README_FILE]: "# Cuadrilla\n\nTry it with your own account.\n\n## Submission notes\n\nEntry of Craftech to the AWS CDS hackathon (Devpost).\n",
  };

  it("reports nothing in docs, CLAUDE.md, tests, e2e or the Submission notes", async () => {
    const root = tree(files);
    const result = await scanSources(root, { files: Object.keys(files), renderers: noEmails });
    expect(result.findings).toEqual([]);
    expect(result.checked).toBe(2);
  });

  it("reports a visible source, the product README and a comment of a visible source", async () => {
    const dirty = {
      ...files,
      "packages/web/src/lib/claims.ts": "// Marks an evaluator from the claims.\nexport const x = 1;\n",
      "packages/web/public/legal/terms.html": "<p>Uso de la demo.</p>\n<p>Solo para el Concurso.</p>\n",
      [README_FILE]: "# Cuadrilla\n\nBuilt for the Hackathon.\n\n## Submission notes\n\nDevpost.\n",
    };
    const root = tree(dirty);
    const { findings } = await scanSources(root, { files: Object.keys(dirty), renderers: noEmails });
    expect(findings).toEqual([
      { source: README_FILE, line: 3, term: "hackathon" },
      { source: "packages/web/public/legal/terms.html", line: 2, term: "concurso" },
      { source: "packages/web/src/lib/claims.ts", line: 1, term: "evaluator" },
    ]);
  });

  it("reads the text of a versioned PDF with the extractor, but not a PDF of the docs", async () => {
    const pdfs = { "scripts/seed/photos/templates/acta.pdf": "%PDF-1.7 binary", "docs/brief.pdf": "%PDF-1.7 binary" };
    const root = tree(pdfs);
    const read: string[] = [];
    const extractPdf = async (bytes: Buffer): Promise<string> => {
      read.push(bytes.toString("utf8"));
      return "Acta de instalación\nFirmado por el Evaluador";
    };
    const { findings } = await scanSources(root, { files: Object.keys(pdfs), renderers: noEmails, extractPdf });
    expect(read).toHaveLength(1);
    expect(findings).toEqual([{ source: "scripts/seed/photos/templates/acta.pdf (pdf text and metadata)", line: 2, term: "evaluador" }]);
  });
});

describe("rendered authentication emails [FL-120]", () => {
  const leaky: AuthEmailRenderer = {
    source: "packages/bff/src/copy/auth-emails.ts signUpCode",
    locales: ["es", "en"],
    render: (locale, brand) => ({
      subject: locale === "es" ? "Tu código" : "Your code",
      body: brand.mode === "cobrand" ? `<p>${brand.partnerDisplayName}</p>\n<p>Gracias por tu evaluaci&oacute;n.</p>` : "<p>Cuadrilla</p>",
    }),
  };

  it("renders every template in each of its locales with the neutral and the co-branding brand", () => {
    const rendered = renderAuthEmails([leaky]);
    expect(rendered.map((email) => email.source)).toEqual([
      `${leaky.source} (rendered, es, neutral)`,
      `${leaky.source} (rendered, es, cobrand)`,
      `${leaky.source} (rendered, en, neutral)`,
      `${leaky.source} (rendered, en, cobrand)`,
    ]);
    expect(RENDER_BRANDS).toEqual(["neutral", "cobrand"]);
  });

  it("reports a rendered email that carries a word, with the rendering that carries it", async () => {
    const { findings } = await scanSources(tree({}), { files: [], renderers: [leaky] });
    expect(findings).toEqual([
      { source: `${leaky.source} (rendered, es, cobrand)`, line: 3, term: "evaluacion" },
      { source: `${leaky.source} (rendered, en, cobrand)`, line: 3, term: "evaluacion" },
    ]);
  });

  it("renders the pool's templates of infra/auth-email.ts, and none carries a word", async () => {
    expect(AUTH_EMAIL_RENDERERS.map((renderer) => renderer.source)).toEqual(["infra/auth-email.ts invitationEmail", "infra/auth-email.ts verificationEmail"]);
    const rendered = renderAuthEmails();
    expect(rendered).toHaveLength(4);
    expect(rendered.find((email) => email.source.endsWith("(rendered, es, cobrand)"))?.text).toContain("Design Partner Demo");
    const { findings } = await scanSources(tree({}), { files: [] });
    expect(findings).toEqual([]);
  });
});

describe("the web build [FL-120]", () => {
  it("reports a word in a fake build, escaped or not", async () => {
    const root = tree({
      [`${DIST_DIR}/index.html`]: "<title>Cuadrilla</title>",
      [`${DIST_DIR}/assets/index-abc.js`]: 'const a="Consola";\nconst b="Evaluaci\\u00f3n del manual";',
      [`${DIST_DIR}/legal/terms.html`]: "<p>Premios</p>",
      [`${DIST_DIR}/brand/logo.png`]: "\u0089PNG\u0000\u0000binary premio",
    });
    const { findings, checked } = await scanDist(root);
    expect(checked).toBe(4);
    expect(findings).toEqual([
      { source: `${DIST_DIR}/assets/index-abc.js`, line: 2, term: "evaluacion" },
      { source: `${DIST_DIR}/legal/terms.html`, line: 1, term: "premios" },
    ]);
  });

  it("fails closed without a build", async () => {
    await expect(scanDist(tree({}))).rejects.toThrow(/packages\/web\/dist does not exist/);
  });
});

describe("the command [FL-120]", () => {
  const TSX = resolve(REPO, "node_modules/.bin/tsx");
  const SCRIPT = resolve(REPO, "scripts/lint/neutral-surfaces.ts");
  const run = (cwd: string): { status: number; output: string } => {
    try {
      return { status: 0, output: execFileSync(TSX, [SCRIPT, "--dist"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { status: failed.status, output: `${failed.stdout}${failed.stderr}` };
    }
  };

  it("exits 1 and prints file, line and word on a finding; exits 0 on a clean build; exits 1 without a build", () => {
    const dirty = run(tree({ [`${DIST_DIR}/index.html`]: "<p>ok</p>\n<p>Jueces</p>" }));
    expect(dirty.status).toBe(1);
    expect(dirty.output).toContain(`${DIST_DIR}/index.html:2  "jueces"`);
    const clean = run(tree({ [`${DIST_DIR}/index.html`]: "<p>Cuadrilla</p>" }));
    expect(clean.status).toBe(0);
    expect(clean.output).toContain("no word of ADR-0023");
    expect(run(tree({})).status).toBe(1);
  }, 30_000);
});

describe("wiring in the workflows [FL-120]", () => {
  interface Step {
    readonly name?: string;
    readonly run?: string;
    readonly uses?: string;
  }
  const steps = (workflow: string, job: string): Step[] =>
    (parse(readFileSync(resolve(REPO, ".github/workflows", workflow), "utf8")) as { jobs: Record<string, { steps: Step[] }> }).jobs[job]?.steps ?? [];
  const runs = (step: Step | undefined): string[] => (step?.run ?? "").split("\n").map((line) => line.trim());
  const indexOf = (list: readonly Step[], command: string): number => list.findIndex((step) => runs(step).includes(command));

  for (const [workflow, job] of [
    ["ci.yml", "checks"],
    ["deploy.yml", "deploy"],
  ] as const) {
    it(`${workflow} runs the guard right after lint:forbidden, and on the build after building it`, () => {
      const list = steps(workflow, job);
      const sources = indexOf(list, "npm run lint:neutral-surfaces");
      const dist = indexOf(list, "npm run lint:neutral-surfaces -- --dist");
      expect(sources).toBeGreaterThan(0);
      expect(indexOf(list, "npm run lint:forbidden")).toBe(sources - 1);
      expect(dist).toBeGreaterThan(indexOf(list, "npm run build -w packages/web"));
      expect(dist).toBeGreaterThan(indexOf(list, "npm run lint:forbidden -- --dist"));
      expect(indexOf(list, "npm run build -w packages/web")).toBeGreaterThan(sources);
      const credentials = list.findIndex((step) => (step.uses ?? "").startsWith("aws-actions/configure-aws-credentials"));
      if (workflow === "deploy.yml") expect(dist).toBeLessThan(credentials);
      else expect(credentials).toBe(-1);
    });
  }

  it("names the tour step as a guided tour", () => {
    expect(steps("ci.yml", "checks").map((step) => step.name)).toContain("Guided tour matches the README (tour:check)");
  });
});
