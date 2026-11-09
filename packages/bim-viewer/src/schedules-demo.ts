/**
 * Standalone schedules demo: the schedule grid, builder and library browser
 * over in-memory mocks of the schedule engine, sync and library (no server,
 * no host app). Run `npm run demo -w @permitzip/bim-schedules-ui`.
 *
 * `?rows=10000` sets the water heater count (default 10,000) for the scroll
 * and edit feel at whole-building size.
 */
import "@permitzip/bim-grid/grid.css";
import "@permitzip/bim-schedules-ui/schedules.css";
import { MutinyThemeProvider } from "@permitzip/bim-ui";
import {
  LibraryBrowser,
  ScheduleBuilder,
  ScheduleGrid,
  type BuilderSectionId,
  type ScheduleDefinitionV2,
} from "@permitzip/bim-schedules-ui";
import {
  createMockCatalog,
  createMockFormulaEngine,
  createMockLibraryProvider,
  createMockScheduleConnection,
  doorSchedule,
  sprinklerSchedule,
  waterHeaterSchedule,
} from "@permitzip/bim-schedules-ui/mock";
import { createElement as h, StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

const params = new URLSearchParams(location.search);
const rows = Math.max(1, Math.min(50_000, Number(params.get("rows") ?? 10_000) || 10_000));

const SCHEDULES = [
  { viewId: "sched-water-heaters", title: "Water heater schedule" },
  { viewId: "sched-doors", title: "Door schedule" },
  { viewId: "sched-sprinklers", title: "Sprinkler head schedule" },
] as const;

function Demo() {
  const connection = useMemo(
    () =>
      createMockScheduleConnection({
        actor: { id: "demo-you", name: "You", color: "#0ea5e9" },
        schedules: [waterHeaterSchedule(rows), doorSchedule(400), sprinklerSchedule(1200)],
        openDelayMs: 300,
      }),
    [],
  );
  const catalog = useMemo(() => createMockCatalog(), []);
  const formulaEngine = useMemo(() => createMockFormulaEngine(), []);
  const library = useMemo(() => createMockLibraryProvider(), []);
  const [viewId, setViewId] = useState<string>(SCHEDULES[0].viewId);
  const [builder, setBuilder] = useState<{ open: boolean; section?: BuilderSectionId }>({ open: false });
  const [log, setLog] = useState<string>("");
  const current = SCHEDULES.find((s) => s.viewId === viewId) ?? SCHEDULES[0];

  return h(
    "div",
    { className: "demo-shell" },
    h(
      "nav",
      { className: "demo-nav", "aria-label": "Schedules" },
      h("h1", null, "Schedules"),
      h(
        "ul",
        null,
        SCHEDULES.map((s) =>
          h(
            "li",
            { key: s.viewId },
            h("a", { href: `#${s.viewId}`, "aria-current": s.viewId === viewId ? "page" : undefined, onClick: () => setViewId(s.viewId) }, s.title),
          ),
        ),
      ),
      h(
        "p",
        { className: "demo-help" },
        "Simulate a colleague: ",
        h(
          "a",
          {
            href: "#avery",
            onClick: () => {
              connection.simulateEditing({ id: "avery", name: "Avery", color: "#7c3aed" }, "sched-water-heaters", { rowKey: "wh2", columnId: "mark" });
              setLog("Avery is now editing WH-3 › Mark for 8 seconds. Try typing in that cell.");
            },
          },
          "Avery edits WH-3 Mark",
        ),
      ),
      h("p", { className: "demo-help", role: "status" }, log),
      h("h2", null, "Library"),
      h(LibraryBrowser, { provider: library, types: ["formula", "schedule_template", "field"] }),
    ),
    h(
      "main",
      { className: "demo-main" },
      h(ScheduleGrid, {
        key: viewId,
        connection,
        target: { viewId },
        title: current.title,
        height: Math.max(320, window.innerHeight - 140),
        onOpenBuilder: (section) => setBuilder({ open: true, section }),
        onShowInModel: (ids) => setLog(`Show in model: ${ids.join(", ")}`),
        onGoToSource: (column, cell) => setLog(`Go to source: ${column.source?.label ?? column.heading} (${cell.rowKey})`),
        onExportCsv: (csv, filename) => setLog(`${filename}: ${csv.split("\n").length - 1} rows exported`),
      }),
    ),
    h(ScheduleBuilder, {
      open: builder.open,
      onOpenChange: (open: boolean) => setBuilder((b) => ({ ...b, open })),
      ...(builder.section ? { section: builder.section } : {}),
      catalog,
      formulaEngine,
      library,
      onSave: (def: ScheduleDefinitionV2) => setLog(`Saved "${def.name}": ${def.columns.length} columns over ${def.source.kind === "classes" ? def.source.classes.join(", ") : def.source.kind}`),
    }),
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("schedules demo: #root missing");
createRoot(root).render(h(StrictMode, null, h(MutinyThemeProvider, { presentation: "standalone", children: h(Demo) })));
