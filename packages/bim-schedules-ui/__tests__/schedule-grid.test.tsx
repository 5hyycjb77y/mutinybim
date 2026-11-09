/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { MutinyThemeProvider } from "@permitzip/bim-ui";
import { toSI } from "@permitzip/bim-units";
import type { ReactElement } from "react";
import { ScheduleGrid } from "../src/ScheduleGrid";
import { createMockScheduleConnection, type MockScheduleConnection } from "../src/mock/connection";
import { doorSchedule, waterHeaterSchedule } from "../src/mock/samples";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MutinyThemeProvider });

const ME = { id: "u-casey", name: "Casey", color: "#0ea5e9" };
const AVERY = { id: "u-avery", name: "Avery", color: "#7c3aed" };

function setup(count = 40) {
  const connection = createMockScheduleConnection({ actor: ME, schedules: [waterHeaterSchedule(count), doorSchedule(10)] });
  const onGoToSource = jest.fn();
  const onShowInModel = jest.fn();
  const utils = render(
    <ScheduleGrid connection={connection} target={{ viewId: "sched-water-heaters" }} title="Water heater schedule" onGoToSource={onGoToSource} onShowInModel={onShowInModel} />,
  );
  return { connection, onGoToSource, onShowInModel, ...utils };
}

async function ready() {
  return screen.findByRole("treegrid", { name: "Water heater schedule" });
}

function cellIn(grid: HTMLElement, rowIndex: number, colIndex: number): HTMLElement {
  const row = grid.querySelector(`[role='row'][aria-rowindex='${rowIndex + 2}']`);
  const cell = row?.querySelector(`[role='gridcell'][aria-colindex='${colIndex + 1}']`);
  if (!(cell instanceof HTMLElement)) throw new Error(`no cell ${rowIndex},${colIndex}`);
  return cell;
}

function typeInto(grid: HTMLElement, text: string) {
  fireEvent.keyDown(grid, { key: "Enter" });
  const input = within(grid).getByRole("textbox");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function moveTo(grid: HTMLElement, row: number, col: number) {
  grid.focus();
  fireEvent.keyDown(grid, { key: "Home", ctrlKey: true });
  for (let r = 0; r < row; r++) fireEvent.keyDown(grid, { key: "ArrowDown" });
  for (let c = 0; c < col; c++) fireEvent.keyDown(grid, { key: "ArrowRight" });
}

describe("ScheduleGrid", () => {
  it("shows loading, then rows formatted through the unit profile with units in the headings", async () => {
    setup();
    expect(screen.getByText(/Loading Water heater schedule/)).toBeInTheDocument();
    const grid = await ready();
    expect(within(grid).getByRole("columnheader", { name: /Gas input \(MBH\)/ })).toBeInTheDocument();
    expect(within(grid).getByRole("columnheader", { name: /Gas input \(Btu\/h\)/ })).toBeInTheDocument();
    expect(cellIn(grid, 0, 4)).toHaveTextContent("199");
    expect(cellIn(grid, 0, 5)).toHaveTextContent("199,000");
  });

  it("a type-scope edit asks first: 'Changes all 14 parts of type WH-1', Cancel focused, Cancel changes nothing", async () => {
    const { connection } = setup();
    const grid = await ready();
    moveTo(grid, 0, 4);
    typeInto(grid, "250");
    const dialog = await screen.findByRole("alertdialog", { name: "Change every part of this type?" });
    expect(dialog).toHaveTextContent("Changes all 14 parts of type WH-1 (Gas input)");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(within(dialog).getByRole("button", { name: "Change all 14" })).toBeInTheDocument();
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(connection.sent).toHaveLength(0);
    expect(cellIn(grid, 0, 4)).toHaveTextContent("199");
    expect(screen.getByRole("status")).toHaveTextContent("Not changed.");
  });

  it("confirming a type-scope edit sends one batch and every row of that type updates, formula column included", async () => {
    const { connection } = setup();
    const grid = await ready();
    moveTo(grid, 0, 4);
    typeInto(grid, "250");
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Change all 14" }));
    await waitFor(() => expect(cellIn(grid, 0, 4)).toHaveTextContent("250"));
    expect(connection.sent).toHaveLength(1);
    expect(connection.sent[0]?.edits).toEqual([{ rowKey: "wh0", columnId: "mbh", value: toSI(250, "MBH") }]);
    // Row 3 is also WH-1; its Btu/h formula column follows.
    expect(cellIn(grid, 3, 4)).toHaveTextContent("250");
    expect(cellIn(grid, 3, 5)).toHaveTextContent("250,000");
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
  });

  it("an instance edit saves without asking; a bad number is refused at the cell with the reason, nothing sent", async () => {
    const { connection } = setup();
    const grid = await ready();
    moveTo(grid, 1, 0);
    typeInto(grid, "WH-99");
    await waitFor(() => expect(cellIn(grid, 1, 0)).toHaveTextContent("WH-99"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(connection.sent).toHaveLength(1);

    moveTo(grid, 1, 3);
    typeInto(grid, "lots");
    expect(connection.sent).toHaveLength(1);
    expect(cellIn(grid, 1, 3)).toHaveAttribute("aria-invalid", "true");
    expect(cellIn(grid, 1, 3)).toHaveAccessibleDescription(/Not saved: "lots" isn't a volume value\. Start with a number/);
    expect(screen.getByRole("status")).toHaveTextContent(/Not changed: .*Start with a number/);
  });

  it("a server refusal keeps the typed value and names the fault", async () => {
    setup();
    const grid = await ready();
    moveTo(grid, 1, 0);
    typeInto(grid, "WH-1");
    await waitFor(() => expect(cellIn(grid, 1, 0)).toHaveAttribute("aria-invalid", "true"));
    expect(cellIn(grid, 1, 0)).toHaveAccessibleDescription("Not saved: WH-1 is already used by another water heater.");
  });

  it("holds this person's edit while Avery is in the cell, then sends it when he leaves", async () => {
    const { connection } = setup();
    const grid = await ready();
    act(() => connection.simulateEditing(AVERY, "sched-water-heaters", { rowKey: "wh2", columnId: "mark" }));
    expect(cellIn(grid, 2, 0)).toHaveAccessibleDescription("Avery is editing this cell.");
    moveTo(grid, 2, 0);
    typeInto(grid, "WH-300");
    expect(within(cellIn(grid, 2, 0)).getByText("Avery")).toBeInTheDocument();
    expect(cellIn(grid, 2, 0)).toHaveAccessibleDescription("Waiting: Avery is editing this cell.");
    expect(screen.getByRole("status")).toHaveTextContent("Avery is editing this cell. Your change will be sent when they finish.");
    expect(connection.sent).toHaveLength(0);
    act(() => connection.simulateRelease(AVERY, "sched-water-heaters", { rowKey: "wh2", columnId: "mark" }));
    await waitFor(() => expect(connection.sent).toHaveLength(1));
    await waitFor(() => expect(cellIn(grid, 2, 0)).toHaveTextContent("WH-300"));
  });

  it("the hold ends after the 8 second ceiling even if the other person never releases", async () => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
    try {
      const { connection } = setup();
      const grid = await ready();
      act(() => connection.simulateEditing(AVERY, "sched-water-heaters", { rowKey: "wh2", columnId: "mark" }, 60_000));
      moveTo(grid, 2, 0);
      typeInto(grid, "WH-301");
      expect(connection.sent).toHaveLength(0);
      await act(async () => {
        jest.advanceTimersByTime(8_100);
      });
      await waitFor(() => expect(connection.sent).toHaveLength(1));
      // Avery's outline is gone too, though his client never sent a release.
      await waitFor(() => expect(cellIn(grid, 2, 0)).not.toHaveAccessibleDescription(/Avery/));
    } finally {
      jest.useRealTimers();
    }
  });

  it("reports when this person starts and stops editing a cell (editing_cell presence)", async () => {
    const { connection } = setup();
    const grid = await ready();
    moveTo(grid, 0, 0);
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(connection.editingCalls.at(-1)).toEqual({ rowKey: "wh0", columnId: "mark" });
    fireEvent.keyDown(within(grid).getByRole("textbox"), { key: "Escape" });
    expect(connection.editingCalls.at(-1)).toBeNull();
  });

  it("a calculated cell is locked, explains itself and links to its formula", async () => {
    const { onGoToSource } = setup();
    const grid = await ready();
    moveTo(grid, 0, 5);
    const cell = cellIn(grid, 0, 5);
    expect(cell).toHaveAttribute("aria-readonly", "true");
    expect(cell).toHaveAccessibleDescription(/Locked: Calculated by \{own\.mbh\} \* 1000\./);
    fireEvent.keyDown(grid, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", { name: "Gas input is locked" });
    await waitFor(() => expect(dialog).toHaveTextContent("199 MBH × 1000 = 199,000 Btu/h"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Go to formula" }));
    expect(onGoToSource).toHaveBeenCalledWith(expect.objectContaining({ id: "btuh" }), { rowKey: "wh0", columnId: "btuh" }, "el-wh-0");
  });

  it("Serves ▸ expands the heater's served fixtures with their own values; editing a fixture's load updates the heater total", async () => {
    setup();
    const grid = await ready();
    expect(cellIn(grid, 0, 6)).toHaveTextContent("5.5");
    fireEvent.click(within(grid).getByRole("button", { name: "Show Serves (3) for WH-1" }));
    expect(within(grid).getByText("L-1")).toBeInTheDocument();
    expect(cellIn(grid, 1, 0)).toHaveTextContent("L-1");
    // Each fixture's own load sits under the heater's "Serves load" column, and says what it is.
    expect(cellIn(grid, 1, 6)).toHaveTextContent("1");
    expect(cellIn(grid, 1, 6)).toHaveAccessibleDescription("Load.");
    expect(cellIn(grid, 1, 2)).toHaveAccessibleDescription(/^Length from source\. Locked: Measured along the piping/);
    moveTo(grid, 1, 6);
    typeInto(grid, "4");
    await waitFor(() => expect(cellIn(grid, 0, 6)).toHaveTextContent("8.5"));
  });

  it("Show in model selects the active row's element; the overflow menu says why items are unavailable", async () => {
    const { onShowInModel } = setup();
    const grid = await ready();
    moveTo(grid, 2, 0);
    fireEvent.click(screen.getByRole("button", { name: /Show in model/ }));
    expect(onShowInModel).toHaveBeenCalledWith(["el-wh-2"]);
  });

  it("losing access closes the grid with a plain message and the next step", async () => {
    const { connection } = setup();
    await ready();
    act(() => connection.revokeAccess("sched-water-heaters"));
    expect(screen.queryByRole("treegrid")).toBeNull();
    expect(screen.getByText("You can't see this schedule any more")).toBeInTheDocument();
    expect(screen.getByText(/Ask the project lead for access/)).toBeInTheDocument();
  });

  it("works for other trades: a door schedule edits a choice column and refuses a value outside the choices", async () => {
    const connection: MockScheduleConnection = createMockScheduleConnection({ actor: ME, schedules: [doorSchedule(10)] });
    render(<ScheduleGrid connection={connection} target={{ viewId: "sched-doors" }} title="Door schedule" />);
    const grid = await screen.findByRole("grid", { name: "Door schedule" });
    expect(cellIn(grid, 0, 2)).toHaveTextContent(`2'-6"`);
    moveTo(grid, 0, 4);
    fireEvent.paste(grid, { clipboardData: { getData: () => "120 min" } });
    expect(cellIn(grid, 0, 4)).toHaveAccessibleDescription(/Pick one of: None, 20 min, 45 min, 90 min/);
    expect(connection.sent).toHaveLength(0);
  });
});
