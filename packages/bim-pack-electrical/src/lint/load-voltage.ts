import { connectionTypeOfLoadPoint, connectionTypeTrade, loadPointLabel, type BimElement, type LoadRecord } from "@permitzip/bim-kernel";
import { electricalFieldsOf } from "../catalog/connection-fields";
import { clip, LOAD_RULE_FIX, loadRuleAt, type RuleDef } from "@permitzip/bim-lint";
import { distributionOf, loadRefusal } from "../connections/systems";

function isLoad(el: BimElement): el is LoadRecord {
  return el.kind === "load_point";
}

/** A power load its panel can't serve at its voltage and poles (KERNEL-REQUIREMENTS-MODEL §3.4); runs with the shared load rules. */
export const loadVoltageRules: readonly RuleDef[] = [
  {
    id: "load-voltage-mismatch",
    version: 1,
    pack: "electrical",
    severity: "warning",
    title: "A power load whose panel can't serve its voltage or poles",
    scope: "element",
    kinds: ["load_point"],
    run: (ctx, el) => {
      if (!isLoad(el) || !el.servedBy || (el.service !== undefined && el.service !== "power")) return;
      const els = ctx.model.elements;
      const ct = connectionTypeOfLoadPoint(els, el);
      if (!ct || connectionTypeTrade(ct) !== "electrical") return;
      const source = els[el.servedBy];
      if (source?.kind !== "part") return;
      const dist = distributionOf(els, source);
      if (!dist) return;
      const why = loadRefusal(loadPointLabel(els, el), { connector: "load", voltage: electricalFieldsOf(ct).voltage, poles: ct.poles }, dist.name, dist.system);
      if (!why) return;
      ctx.emit({
        rule: "load-voltage-mismatch",
        severity: "warning",
        elementIds: [el.id, source.id],
        at: loadRuleAt(ctx, el),
        message: clip(why),
        fix: { tool: LOAD_RULE_FIX, hint: clip(`serve it from a panel at its voltage, or correct connection type ${ct.designator}`, 120) },
      });
    },
  },
];
