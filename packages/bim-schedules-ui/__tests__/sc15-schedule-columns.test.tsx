/**
 * @jest-environment jsdom
 *
 * Round 15 SC15: a schedule is changed one column at a time from the grid's
 * Columns button. Every control sends exactly one `edit_schedule` step (the
 * kernel's, shared with the agent and scripts), so each change is one undo
 * step; a refusal is shown in words; read-only says why.
 *
 * Fails on the code before SC15: there was no Columns panel (columns changed
 * only through the whole-definition builder), and the grid had no Columns button.
 */
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import { MutinyThemeProvider } from "@permitzip/bim-ui";
import type { ReactElement } from "react";
import { ScheduleColumnsSheet } from "../src/ScheduleColumnsSheet";
import { ScheduleGrid } from "../src/ScheduleGrid";
import type { ScheduleColumnStep, ScheduleDefinitionV2 } from "../src/contracts";
import { createMockCatalog } from "../src/mock/catalog";
import { createMockScheduleConnection } from "../src/mock/connection";
import { waterHeaterSchedule } from "../src/mock/samples";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MutinyThemeProvider });

const DEF: ScheduleDefinitionV2 = {
  name: "Water heater schedule",
  source: { kind: "classes", classes: ["mep.water_heater"], includeSubclasses: true },
  columns: [
    { id: "mark", kind: "field", path: "mark" },
    { id: "mbh", kind: "field", path: "own.mbh", heading: "INPUT" },
    { id: "level", kind: "field", path: "level" },
  ],
  filters: [],
  sort: [],
  groups: [],
  grandTotals: false,
  itemize: true,
  presentation: { kind: "list" },
  display: { textSizeMm: 2.5, emptyText: "NONE" },
};

function open(overrides: Partial<Parameters<typeof ScheduleColumnsSheet>[0]> = {}) {
  const steps: ScheduleColumnStep[] = [];
  const onStep = jest.fn((step: ScheduleColumnStep) => {
    steps.push(step);
    return null;
  });
  const fields = createMockCatalog().fieldsFor(["mep.water_heater"]);
  render(<ScheduleColumnsSheet open onOpenChange={() => undefined} definition={DEF} fields={fields} onStep={onStep} {...overrides} />);
  return { steps, onStep, panel: screen.getByTestId("schedule-columns-panel") };
}

describe("sc15 Columns panel: one step per change", () => {
  it("moves, renames, sorts, groups, totals, adds and removes, each one step", () => {
    const { steps, panel } = open();
    fireEvent.click(within(panel).getByRole("button", { name: "Move Level left" }));
    const heading = within(panel).getByRole("textbox", { name: "Heading of column 1" });
    fireEvent.change(heading, { target: { value: "TAG" } });
    fireEvent.blur(heading);
    fireEvent.click(within(within(panel).getByTestId("schedule-column-mark")).getByRole("button", { name: "Sort" }));
    fireEvent.click(within(within(panel).getByTestId("schedule-column-level")).getByRole("button", { name: "Group" }));
    fireEvent.click(within(within(panel).getByTestId("schedule-column-mbh")).getByRole("checkbox", { name: "Total" }));
    fireEvent.change(within(panel).getByRole("combobox", { name: "Add a column" }), { target: { value: "storage" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Add" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Remove INPUT" }));
    expect(steps).toEqual([
      { op: "move_column", columnId: "level", to: 1 },
      { op: "rename_column", columnId: "mark", heading: "TAG" },
      { op: "sort", sort: [{ path: "mark", direction: "asc" }] },
      { op: "group", groups: [{ path: "level", header: true, footer: true, totals: true }] },
      { op: "totals", columnId: "mbh", show: true },
      { op: "add_column", column: { id: "storage", kind: "field", path: "storage" } },
      { op: "remove_column", columnId: "mbh" },
    ]);
    expect(within(panel).getByTestId("schedule-columns-feedback")).toHaveTextContent("Removed INPUT. Undo (Ctrl+Z) puts it back.");
  });

  it("says why a text column has no total and why the last column stays; shows a refusal in words", () => {
    const { panel } = open({ definition: { ...DEF, columns: [DEF.columns[0] ?? { id: "mark", kind: "field", path: "mark" }] }, onStep: () => "the model server is offline" });
    const mark = within(panel).getByTestId("schedule-column-mark");
    expect(within(mark).getByRole("checkbox", { name: "Total" })).toBeDisabled();
    expect(within(mark).getByTitle("Only numbers add up.")).toBeInTheDocument();
    expect(within(mark).getByRole("button", { name: "Remove Mark" })).toBeDisabled();
    expect(within(mark).getByRole("button", { name: "Remove Mark" })).toHaveAttribute("title", "A schedule keeps at least one column");
    fireEvent.click(within(mark).getByRole("button", { name: "Sort" }));
    expect(within(panel).getByRole("alert")).toHaveTextContent("Not changed: the model server is offline");
  });

  it("read only: every control is off and the panel says why", () => {
    const { panel, onStep } = open({ blocked: "You can view this model, not change it." });
    expect(within(panel).getByRole("note")).toHaveTextContent("Read only: You can view this model, not change it.");
    expect(within(panel).getByRole("button", { name: "Move Level left" })).toBeDisabled();
    expect(onStep).not.toHaveBeenCalled();
  });

  it("the grid's toolbar shows Columns when the host can change columns", async () => {
    const onOpenColumns = jest.fn();
    const connection = createMockScheduleConnection({ actor: { id: "me", name: "Me", color: "#000" }, schedules: [waterHeaterSchedule(3)] });
    render(<ScheduleGrid connection={connection} target={{ viewId: "sched-water-heaters" }} title="Water heater schedule" onOpenColumns={onOpenColumns} />);
    await screen.findByRole("treegrid", { name: "Water heater schedule" });
    fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
    expect(onOpenColumns).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^Fields$/ })).toBeNull();
  });

  it("an empty schedule points at the control the toolbar shows, not the Fields button it no longer has", async () => {
    const connection = createMockScheduleConnection({ actor: { id: "me", name: "Me", color: "#000" }, schedules: [waterHeaterSchedule(0)] });
    render(<ScheduleGrid connection={connection} target={{ viewId: "sched-water-heaters" }} title="Water heater schedule" onOpenColumns={() => undefined} />);
    expect(await screen.findByText(/No items in the model match this schedule/)).toHaveTextContent("Change what it lists with Columns › What it lists, formulas and paper.");
  });
});
