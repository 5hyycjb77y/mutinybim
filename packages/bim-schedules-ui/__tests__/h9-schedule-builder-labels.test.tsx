/**
 * @jest-environment jsdom
 *
 * Round 9 lane H9: the schedule builder heads each discipline group with the
 * label the host's registry gives it, so fire alarm and an add-on's own
 * discipline read correctly. On 8b the builder had its own eight-entry label
 * table: fire alarm and any add-on discipline showed as the raw id.
 */
import { render as rtlRender, screen, within } from "@testing-library/react";
import { MutinyThemeProvider } from "@permitzip/bim-ui";
import type { ReactElement } from "react";
import { ScheduleBuilder } from "../src/ScheduleBuilder";
import { createMockCatalog, createMockFormulaEngine, createMockLibraryProvider } from "../src/mock/catalog";
import type { CatalogClass, ScheduleCatalog } from "../src/ports";
import fs from "node:fs";
import path from "node:path";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MutinyThemeProvider });

function catalogWith(extra: readonly CatalogClass[]): ScheduleCatalog {
  const base = createMockCatalog();
  return { ...base, classes: () => [...base.classes(), ...extra] };
}

function open(catalog: ScheduleCatalog) {
  render(<ScheduleBuilder open onOpenChange={() => undefined} catalog={catalog} formulaEngine={createMockFormulaEngine()} library={createMockLibraryProvider()} onSave={jest.fn()} />);
  return screen.getByRole("dialog", { name: "New schedule" });
}

describe("h9 schedule builder discipline labels come from the registry", () => {
  it("fire alarm and an add-on discipline are labelled by the host", () => {
    const sheet = open(
      catalogWith([
        { id: "fa.device", label: "Fire alarm device", discipline: "fire_alarm", disciplineLabel: "Fire alarm" },
        { id: "vt.car", label: "Elevator car", discipline: "firm:vertical_transport", disciplineLabel: "Vertical transportation" },
      ]),
    );
    expect(within(within(sheet).getByRole("group", { name: "Fire alarm" })).getByRole("checkbox", { name: "Fire alarm device" })).toBeInTheDocument();
    expect(within(within(sheet).getByRole("group", { name: "Vertical transportation" })).getByRole("checkbox", { name: "Elevator car" })).toBeInTheDocument();
    expect(within(sheet).queryByText("fire_alarm")).toBeNull();
  });

  it("a discipline the host didn't label reads in the id's words, never the raw id", () => {
    const sheet = open(catalogWith([{ id: "lv.rack", label: "Data rack", discipline: "firm:low_voltage" }]));
    expect(within(sheet).getByRole("group", { name: "Low voltage" })).toBeInTheDocument();
    expect(within(sheet).queryByText("firm:low_voltage")).toBeNull();
  });

  it("the builder names no discipline itself", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../src/ScheduleBuilder.tsx"), "utf8");
    for (const word of ["Architecture", "Structural", "Mechanical", "Electrical", "Plumbing", "Fire protection", "General contracting"]) expect(src).not.toContain(`"${word}"`);
  });
});
