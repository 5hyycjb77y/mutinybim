/**
 * @jest-environment jsdom
 */
import { fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { MutinyThemeProvider } from "@permitzip/bim-ui";
import type { ReactElement } from "react";
import { LibraryBrowser } from "../src/LibraryBrowser";
import { ScheduleBuilder } from "../src/ScheduleBuilder";
import { suggestCalculationKey } from "../src/SaveToLibrary";
import { createMockCatalog, createMockFormulaEngine, createMockLibraryProvider } from "../src/mock/catalog";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MutinyThemeProvider });

function openBuilder(overrides: Partial<Parameters<typeof ScheduleBuilder>[0]> = {}) {
  const onSave = jest.fn();
  const library = createMockLibraryProvider();
  render(<ScheduleBuilder open onOpenChange={() => undefined} catalog={createMockCatalog()} formulaEngine={createMockFormulaEngine()} library={library} onSave={onSave} {...overrides} />);
  const sheet = screen.getByRole("dialog", { name: "New schedule" });
  return { sheet, onSave, library };
}

function pickWaterHeaters(sheet: HTMLElement) {
  fireEvent.click(within(sheet).getByRole("checkbox", { name: "Water heater" }));
}

describe("ScheduleBuilder", () => {
  it("groups object classes by discipline, every trade included", () => {
    const { sheet } = openBuilder();
    for (const trade of ["Architecture", "Structural", "Civil", "Mechanical", "Electrical", "Plumbing", "Fire protection", "General contracting"]) {
      expect(within(sheet).getByRole("group", { name: trade })).toBeInTheDocument();
    }
    expect(within(within(sheet).getByRole("group", { name: "Fire protection" })).getByRole("checkbox", { name: "Sprinkler head" })).toBeInTheDocument();
  });

  it("refuses a unit-mismatched formula inline, marks the operator, and won't add the column", () => {
    const { sheet } = openBuilder();
    pickWaterHeaters(sheet);
    const formula = within(sheet).getByRole("textbox", { name: "Formula" });
    fireEvent.change(formula, { target: { value: "{length} + {own.mbh}" } });
    expect(formula).toHaveAttribute("aria-invalid", "true");
    expect(formula).toHaveAccessibleDescription(/^Can't add .*\(MBH\) to length \(ft\)\./);
    const mark = sheet.querySelector(".mutiny-sched-error-span mark");
    expect(mark?.textContent).toBe("+");
    const add = within(sheet).getByRole("button", { name: "Add as column" });
    expect(add).toBeDisabled();
    expect(within(sheet).getByText("Fix the formula first.")).toBeInTheDocument();

    fireEvent.change(formula, { target: { value: "{own.mbh} * 1000" } });
    expect(formula).toHaveAttribute("aria-invalid", "false");
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(within(within(sheet).getByRole("list", { name: "Columns in this schedule" })).getByText("{own.mbh} * 1000")).toBeInTheDocument();
  });

  it("refuses a total on served loads with the reason, and allows it on the heater's own input", () => {
    const { sheet } = openBuilder();
    pickWaterHeaters(sheet);
    fireEvent.click(within(sheet).getByRole("button", { name: "Add Serves load" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Add Gas input" }));
    const columns = within(sheet).getByRole("list", { name: "Columns in this schedule" });
    const items = within(columns).getAllByRole("listitem");
    const serves = items.find((li) => li.textContent?.startsWith("Serves load"));
    const gas = items.find((li) => li.textContent?.startsWith("Gas input"));
    if (!serves || !gas) throw new Error("columns missing");
    const servesTotal = within(serves).getByRole("checkbox", { name: "Total" });
    expect(servesTotal).toBeDisabled();
    expect(servesTotal).toHaveAccessibleDescription("Served loads are already counted on the fixtures.");
    expect(within(gas).getByRole("checkbox", { name: "Total" })).toBeEnabled();
  });

  it("Save says why it's disabled, then saves a definition with the chosen classes and columns", async () => {
    const { sheet, onSave } = openBuilder();
    const save = within(sheet).getByRole("button", { name: "Save schedule" });
    expect(save).toBeDisabled();
    expect(within(sheet).getByText("Choose at least one kind of item to list.")).toBeInTheDocument();
    pickWaterHeaters(sheet);
    expect(within(sheet).getByText("Add at least one column.")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Add Mark" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Add Serves as a sub-list" }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const def = onSave.mock.calls[0]?.[0];
    expect(def.source).toEqual({ kind: "classes", classes: ["mep.water_heater"], includeSubclasses: true });
    expect(def.columns.map((c: { kind: string }) => c.kind)).toEqual(["parameter", "expand"]);
  });

  it("opening from Arrange lands on Sort, group and totals", async () => {
    openBuilder({ section: "arrange" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sort, group and totals" })).toHaveFocus());
  });

  it("Save to firm library publishes the checked formula as a named calculation", async () => {
    const { sheet, library } = openBuilder();
    pickWaterHeaters(sheet);
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Column heading" }), { target: { value: "Gas input btuh" } });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Formula" }), { target: { value: "{own.mbh} * 1000" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save to firm library" }));
    const dialog = await screen.findByRole("dialog", { name: "Save to firm library" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Library" })).toHaveValue("firm:permitzip"));
    expect(within(dialog).getByRole("textbox", { name: "Formula name" })).toHaveValue("PZ.GasInputBtuh");
    fireEvent.click(within(dialog).getByRole("button", { name: /Publish/ }));
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Saved to PermitZIP as PZ.GasInputBtuh, revision 1."));
    expect(library.published[0]?.body).toMatchObject({ key: "PZ.GasInputBtuh", expression: "{own.mbh} * 1000", result: { valueType: "quantity", kind: "flow_gas_energy", unit: "MBH" }, appliesTo: ["mep.water_heater"] });
  });
});

describe("LibraryBrowser", () => {
  it("lists firm calculations, hides retired ones until asked, and searches", async () => {
    render(<LibraryBrowser provider={createMockLibraryProvider()} types={["formula", "schedule_template"]} />);
    const list = await screen.findByRole("list", { name: "Calculations in PermitZIP" });
    expect(within(list).getByText("Gas demand (Btu/h)")).toBeInTheDocument();
    expect(within(list).queryByText("Old demand factor")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include retired items" }));
    expect(await screen.findByText("Retired")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "zzz" } });
    expect(await screen.findByText("No calculations in PermitZIP match “zzz”.")).toBeInTheDocument();
  });

  it("says the built-in library is read-only and why", async () => {
    render(<LibraryBrowser provider={createMockLibraryProvider()} types={["schedule_template"]} />);
    expect(await screen.findByText("PermitZIP has no schedule templates yet.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Library" }), { target: { value: "builtin" } });
    expect(await screen.findByText(/^The built-in library ships with MutinyBIM/)).toBeInTheDocument();
    expect(screen.queryByText(/is read-only here\./)).not.toBeInTheDocument();
    expect(await screen.findByText("Door schedule")).toBeInTheDocument();
  });

  it("names the formula after the calculation", () => {
    expect(suggestCalculationKey("gas demand (btu/h)")).toBe("PZ.GasDemandBtuH");
    expect(suggestCalculationKey("")).toBe("");
  });
});
