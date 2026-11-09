import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NEC_EDITIONS, builtinCalcRegistry, type CalcRun, type RunRequest } from "@permitzip/bim-calc";
import { withPinnedPacks } from "@permitzip/bim-editor/contracts/building-model/installed-packs";
import { explain, failure, text, withSession, type ResolveBimCaller } from "../runtime";
import { CODE_EDITION_ARGS, codeEditionRequest } from "./code-editions";
import type { ProjectAdoptionLookup, ProjectFuelGasLookup, ProjectPlumbingLookup } from "./capabilities";
import { noAdoptedElectricalCode, noAdoptedFuelGasCode, noAdoptedPlumbingCode } from "./local";

/**
 * Engineering calcs for agents, read-only: list the calc plugins (NEC
 * electrical, duct and pipe), and run one with citations. Pure calcs need no
 * model; duct and pipe system calcs read the model. The code edition (NEC,
 * plumbing, fuel gas) is the one asked for, else the project's adopted code
 * from its Code Study, else the state's adoption; with none of those the run
 * is refused rather than guessed.
 */

// Preview calcs (point-to-point fault current) are off unless a deployment turns them on.
const registry = builtinCalcRegistry({ preview: process.env.MUTINYBIM_PREVIEW_CALCS === "1" });

export type { ProjectAdoptionLookup } from "./capabilities";

function present(run: CalcRun, includeDetail: boolean) {
  return {
    calc: run.calc,
    code: run.code,
    criteria: run.criteria,
    values: run.values.map((v) => ({ key: v.key, label: v.label, value: v.value, unit: v.unit, cite: v.cite.map((c) => c.text) })),
    steps: run.steps.map((s) => ({ label: s.label, detail: s.detail, cite: s.cite.map((c) => c.text) })),
    issues: run.issues.map((i) => ({ severity: i.severity, message: i.message, cite: i.cite.map((c) => c.text) })),
    citations: run.citations.map((c) => c.text),
    run_key: run.runKey,
    inputs: run.inputs,
    ...(includeDetail ? { detail: run.detail } : {}),
  };
}

export function registerBimCalcTools(server: McpServer, caller: ResolveBimCaller, options: { projectAdoption?: ProjectAdoptionLookup; fuelGas?: ProjectFuelGasLookup; plumbing?: ProjectPlumbingLookup } = {}) {
  // A host with no record of adopted codes answers none; a run then takes the edition or state given, or asks.
  const projectAdoption = options.projectAdoption ?? noAdoptedElectricalCode;
  const fuelGas = options.fuelGas ?? noAdoptedFuelGasCode;
  const plumbing = options.plumbing ?? noAdoptedPlumbingCode;

  server.registerTool(
    "bim_list_calcs",
    {
      title: "List engineering calcs",
      description:
        "The calc plugins bim_run_calc can run, electrical (NEC 2020 / 2023), mechanical and plumbing: id, version, what it calculates and from what, whether it reads a model, a worked example input, and the input schema. Free; no approval.",
      inputSchema: { domain: z.enum(["electrical", "mechanical", "plumbing"]).optional().describe("Only this trade.") },
    },
    async (args) => {
      const list = registry.list().filter((c) => !args.domain || c.domain === args.domain);
      return text({
        nec_editions: NEC_EDITIONS,
        calcs: list.map((c) => ({ id: c.id, version: c.version, domain: c.domain, title: c.title, summary: c.summary, code: c.codeFamily, reads_model: c.needsModel, example: c.example, input_schema: c.inputSchema })),
      });
    },
  );

  server.registerTool(
    "bim_run_calc",
    {
      title: "Run an engineering calc with citations",
      description:
        'Run one calc plugin and get values with units, the steps in plain language, issues, and the clause or method each value rests on (e.g. "NEC 2023 Table 310.16, copper 90°C column", "NEC 2023 250.122(B)"). Examples: size a feeder (calc nec.size_circuit, inputs {circuit: "feeder", system: "3ph_4w", voltage_v: 480, continuous_load_a: 100, length_ft: 250}); a 277 V site lighting branch kept on a 20 A breaker and upsized for voltage drop (ocpd_a: 20); a panel or service demand load from its raw inventory (nec.demand_load); duct or pipe system reports (mech.duct_system_pressure, plumbing.pipe_system, give model_id). Code edition: nec_edition / plumbing_edition / fuel_gas_edition if given, else the project\'s Code Study, else state; otherwise it asks. bim_list_calcs shows every calc\'s inputs. Read-only; no approval.',
      inputSchema: {
        project_id: z.string().uuid().describe("PermitZIP project id (access check, and its Code Study's codes)."),
        calc: z.string().min(1).max(80).describe("Calc id from bim_list_calcs, e.g. nec.size_circuit."),
        inputs: z.record(z.string(), z.unknown()).describe("The calc's inputs (see its example in bim_list_calcs)."),
        ...CODE_EDITION_ARGS,
        model_id: z.string().min(1).max(200).optional().describe("MutinyBIM model id, for calcs that read a model."),
        include_detail: z.boolean().default(false).describe("Also return the full structured result (size tables, the engine's report)."),
      },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        // A calc an add-on of the model brings is known only with that model's packs in force (below).
        const info = registry.get(args.calc)?.info;
        if (!info && !args.model_id) return failure(`No calc "${args.calc}". Available: ${registry.list().map((c) => c.id).join(", ")}.`);
        const adoption = info?.codeFamily === "nec" && !args.nec_edition ? await projectAdoption(extra, args.project_id) : null;
        const plumbingCode = info?.codeFamily === "ipc" && !args.plumbing_edition ? await plumbing(extra, args.project_id) : null;
        const fuelGasCode = info?.codeFamily === "ifgc" && !args.fuel_gas_edition ? await fuelGas(extra, args.project_id) : null;
        const request: RunRequest = { calc: args.calc, inputs: args.inputs, ...codeEditionRequest(args), projectAdoption: adoption, projectAdoptions: { plumbing: plumbingCode, fuel_gas: fuelGasCode } };
        if (!info || info.needsModel || args.model_id) {
          if (!args.model_id) return failure(`${info?.title ?? args.calc} reads a model; give model_id.`);
          return await withSession(who, args.model_id, undefined, async (s) => {
            const model = s.model();
            const result = withPinnedPacks(model, () => (registry.get(args.calc) ? registry.run({ ...request, model }) : null));
            if (result === null) return failure(`No calc "${args.calc}" in this model. Available: ${withPinnedPacks(model, () => registry.list().map((c) => c.id).join(", "))}.`);
            return result.ok ? text({ revision: model.revision, ...present(result.run, args.include_detail) }) : failure(result.reason);
          });
        }
        const result = registry.run(request);
        return result.ok ? text(present(result.run, args.include_detail)) : failure(result.reason);
      } catch (err) {
        return explain(err, "bim_run_calc");
      }
    },
  );
}
