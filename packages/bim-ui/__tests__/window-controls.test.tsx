/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FULLSCREEN_UNSUPPORTED, MutinyThemeProvider, POPUP_BLOCKED, WindowControls, useMutinyPortalContainer } from "../src";

/** jsdom has no Fullscreen API; this stands in for the browser's. */
function installFullscreen(enabled: boolean) {
  let current: Element | null = null;
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => enabled });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => current });
  const request = jest.fn(function (this: Element) {
    current = this;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  const exit = jest.fn(() => {
    current = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: request });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  /** The browser leaving full screen on its own (the person pressed Esc). */
  const pressEscape = () => {
    current = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  };
  return { request, exit, pressEscape };
}

function Controls({ onProblem, href }: { onProblem: (m: string) => void; href?: string }) {
  const root = useMutinyPortalContainer();
  return <WindowControls fullscreenTarget={root} newWindowHref={href} newWindowName="mutinybim-p1" onProblem={onProblem} />;
}

function renderControls(onProblem: (m: string) => void, href?: string) {
  const utils = render(
    <MutinyThemeProvider>
      <Controls onProblem={onProblem} href={href} />
    </MutinyThemeProvider>,
  );
  const root = utils.container.querySelector("[data-mutiny-root]");
  if (!root) throw new Error("no root");
  return { ...utils, root };
}

describe("Building Model window controls", () => {
  beforeAll(() => {
    // Radix positions tooltips with ResizeObserver, which jsdom lacks.
    Reflect.set(globalThis, "ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  it("puts the BIM root full screen, and Esc (the browser) brings the button back to Open in full screen", async () => {
    const fs = installFullscreen(true);
    const { root } = renderControls(jest.fn());
    fireEvent.click(screen.getByRole("button", { name: "Open in full screen" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Exit full screen" })).toHaveAttribute("aria-pressed", "true"));
    expect(fs.request.mock.contexts[0]).toBe(root);

    act(() => fs.pressEscape());
    expect(screen.getByRole("button", { name: "Open in full screen" })).toHaveAttribute("aria-pressed", "false");
  });

  it("leaves full screen from the button too", async () => {
    const fs = installFullscreen(true);
    renderControls(jest.fn());
    fireEvent.click(screen.getByRole("button", { name: "Open in full screen" }));
    await screen.findByRole("button", { name: "Exit full screen" });
    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
    await screen.findByRole("button", { name: "Open in full screen" });
    expect(fs.exit).toHaveBeenCalledTimes(1);
  });

  it("disables full screen with the reason when the browser doesn't allow it", async () => {
    installFullscreen(false);
    renderControls(jest.fn());
    const button = screen.getByRole("button", { name: "Open in full screen" });
    expect(button).toBeDisabled();
    fireEvent.focus(button.parentElement ?? button);
    expect(await screen.findAllByText(FULLSCREEN_UNSUPPORTED)).not.toHaveLength(0);
  });

  it("opens the standalone window by name, cuts its link back to this page, and says so when pop-ups are blocked", () => {
    installFullscreen(true);
    const fake = { opener: {} as unknown, focus: jest.fn() };
    const open = jest.spyOn(window, "open").mockReturnValueOnce(fake as unknown as Window).mockReturnValueOnce(null);
    const onProblem = jest.fn();
    renderControls(onProblem, "/mutinybim/p1?view=3d");
    fireEvent.click(screen.getByRole("button", { name: "Open in new window" }));
    expect(open).toHaveBeenCalledWith("/mutinybim/p1?view=3d", "mutinybim-p1");
    expect(fake.opener).toBeNull();
    expect(onProblem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open in new window" }));
    expect(onProblem).toHaveBeenCalledWith(POPUP_BLOCKED);
    open.mockRestore();
  });

  it("has no new-window button when there is nowhere else to go (already standalone)", () => {
    installFullscreen(true);
    renderControls(jest.fn());
    expect(screen.queryByRole("button", { name: "Open in new window" })).toBeNull();
  });
});
