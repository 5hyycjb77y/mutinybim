/**
 * @jest-environment node
 *
 * Round 14 guard (K14 step 5): the kernel's sources name no Mechanical
 * element kind. The unit, duct, tap, elbow and air terminal records are read
 * through their kind rows (`ELEMENT_KIND_POINT`: connector ends, `root`,
 * `hostedBy` placement, authored shape fields, `viewCategory`,
 * `scheduleListing` / `scheduleCategory` / `scheduleFamily`), never by
 * comparing `kind` with their names.
 *
 * The same five words are still kernel vocabulary in other senses, listed
 * below with the reason. Each entry is the number of occurrences of the
 * literal in that file; a count may only fall (lower it here when it does),
 * a file not listed may not gain one, and no line may use one of the words
 * as an element kind (`.kind === "…"`, `elementsOfKind(…, "…")`,
 * `requireKind(…, "…")`, `Extract<BimElement, { kind: "…" }>`).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");
const WORD = /"(duct_segment|equipment|terminal|elbow|tap)"/g;

const WORDS = ["duct_segment", "equipment", "terminal", "elbow", "tap"] as const;
type Word = (typeof WORDS)[number];
const isWord = (w: string | undefined): w is Word => WORDS.some((x) => x === w);
type Vocabulary = Readonly<Record<string, Partial<Record<Word, number>>>>;

/** Run fitting types (`FITTING_TYPES`): a fitting's shape on any run, every trade's (an elbow on a pipe, a tap on a duct). */
const FITTING_TYPES: Vocabulary = {
  "drawing/runs.ts": { elbow: 1, tap: 1 },
  "routing/commands.ts": { elbow: 13, tap: 1 },
  "routing/connect-commands.ts": { elbow: 1 },
  "routing/fitting-commands.ts": { elbow: 11, tap: 3 },
  "routing/fittings/geometry.ts": { elbow: 2, tap: 1 },
  "routing/fittings/library.ts": { elbow: 4, tap: 2 },
  "routing/follow-core.ts": { tap: 1 },
  "routing/pipe/families.ts": { elbow: 1, tap: 1 },
  "routing/pipe/geometry.ts": { elbow: 1 },
  "routing/rules.ts": { elbow: 1, tap: 2 },
  "routing/stretch-commands.ts": { elbow: 3, tap: 1 },
  "routing/types.ts": { elbow: 1, tap: 1 },
  "routing/validate.ts": { elbow: 1, tap: 1 },
  "selection-scopes.ts": { elbow: 1, tap: 1 },
  "services/registry.ts": { tap: 2 },
};

/** "Equipment" as a view, tag or text category and drawing role: what electrical, plumbing and mechanical equipment draw under alike. */
const CATEGORY_WORDS: Vocabulary = {
  "annotation/annotations.ts": { equipment: 5 },
  "annotation/auto-tag.ts": { equipment: 3 },
  "categories/registry.ts": { equipment: 4 },
  "diagrams/definition.ts": { equipment: 1 },
  "diagrams/evaluate.ts": { equipment: 2 },
  "diagrams/riser-layout.ts": { equipment: 1 },
  "documents.ts": { equipment: 1 },
  "drawing/solids.ts": { equipment: 4 },
  "layout/one-line.ts": { equipment: 1 },
  "organization/model.ts": { equipment: 1 },
  "part-model/preview.ts": { equipment: 2 },
  "spaces/derived-zones.ts": { equipment: 1 },
};

/** Plain words: a diagram piece's role at the end of a branch, a leader line's bend. */
const PLAIN_WORDS: Vocabulary = {
  "diagrams/graph.ts": { terminal: 1 },
  "annotation/elbow-leader.ts": { elbow: 1 },
};

/**
 * Deferred, with the closing work (K14-notes, run 4):
 * - `registry/element-kinds.ts`: the five stored names, kept only so a library file's
 *   recognition rule (`bim-library/src/schema.ts`) and the agent's kind filter
 *   (`lib/mcp/tools/bim.ts`) still parse them; those two read the kinds in force instead,
 *   then the list goes.
 * (`registry/builtin.ts` closed in run 5: the kind rows name their class, `ElementKindItem.classId`.)
 */
const DEFERRED: Vocabulary = {
  "registry/element-kinds.ts": { duct_segment: 1, elbow: 1, equipment: 1, tap: 1, terminal: 1 },
};

const ALLOWED: Vocabulary = { ...FITTING_TYPES, ...CATEGORY_WORDS, ...PLAIN_WORDS, ...DEFERRED };

/** A word used as an element kind: compared with a record's kind, or named as a kind to read or narrow to. A run's joint (`joint.kind`) is a fitting type. */
const AS_ELEMENT_KIND = [
  /(?<!joint)\.kind\s*[!=]==?\s*"(duct_segment|equipment|terminal|elbow|tap)"/,
  /elementsOfKind\([^)]*"(duct_segment|equipment|terminal|elbow|tap)"/,
  /requireKind\([^)]*"(duct_segment|equipment|terminal|elbow|tap)"/,
  /Extract<BimElement,\s*\{\s*kind:\s*"(duct_segment|equipment|terminal|elbow|tap)"/,
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__") out.push(...sources(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function occurrences(): Record<string, Partial<Record<Word, number>>> {
  const out: Record<string, Partial<Record<Word, number>>> = {};
  for (const file of sources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    for (const m of readFileSync(file, "utf8").matchAll(WORD)) {
      const word = m[1];
      if (!isWord(word)) continue;
      const row = (out[rel] ??= {});
      row[word] = (row[word] ?? 0) + 1;
    }
  }
  return out;
}

describe("the kernel names no Mechanical element kind", () => {
  it("uses the five words only as the vocabulary listed here, never more often", () => {
    const found = occurrences();
    const over: string[] = [];
    const lower: string[] = [];
    for (const [file, words] of Object.entries(found)) {
      for (const word of WORDS) {
        const n = words[word] ?? 0;
        const allowed = ALLOWED[file]?.[word] ?? 0;
        if (n > allowed) over.push(`${file}: "${word}" ${allowed} → ${n}`);
        if (n < allowed) lower.push(`${file}: "${word}" ${allowed} → ${n}`);
      }
    }
    for (const [file, words] of Object.entries(ALLOWED)) {
      for (const word of WORDS) {
        const allowed = words[word] ?? 0;
        if (allowed > 0 && (found[file]?.[word] ?? 0) === 0) lower.push(`${file}: "${word}" ${allowed} → 0`);
      }
    }
    if (lower.length > 0) console.log(`[k14-no-mechanical-kind-names] fell; lower the allow-list:\n${lower.join("\n")}`);
    expect(over).toEqual([]);
  });

  it("never uses one of them as an element kind", () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (AS_ELEMENT_KIND.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the word list itself is the five Mechanical stored kinds", () => {
    const deferred = Object.keys(DEFERRED["registry/element-kinds.ts"] ?? {}).sort();
    expect(deferred).toEqual(["duct_segment", "elbow", "equipment", "tap", "terminal"]);
  });
});
