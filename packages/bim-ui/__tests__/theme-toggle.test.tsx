/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createMemoryColorSchemeAdapter, mutinyDarkTheme, mutinyDefaultTheme, MutinyThemeProvider, ThemeToggle, type ColorSchemeAdapter, type MutinyColorScheme } from "../src";

type Listener = () => void;

/** A `prefers-color-scheme` the test can flip, like the OS switching at sunset. */
function fakeSystemScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<Listener>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("dark") ? dark : false;
    },
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: (_: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      dark = next;
      for (const cb of listeners) cb();
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

function root(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-mutiny-root]");
  if (!el) throw new Error("no MutinyBIM root rendered");
  return el;
}

describe("ThemeToggle and colour scheme", () => {
  let system: ReturnType<typeof fakeSystemScheme>;
  beforeEach(() => {
    system = fakeSystemScheme(false);
  });
  afterEach(() => system.restore());

  it("standalone: shows Light / Dark / System and switches every --mutiny-* color to the dark set", () => {
    render(
      <MutinyThemeProvider presentation="standalone">
        <ThemeToggle />
      </MutinyThemeProvider>,
    );
    expect(screen.getByRole("radio", { name: "Light theme" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "System theme" })).toHaveAttribute("aria-checked", "true");
    expect(root().dataset.mutinyScheme).toBe("light");
    expect(root().style.getPropertyValue("--mutiny-surface")).toBe(mutinyDefaultTheme.colors.surface);

    fireEvent.click(screen.getByRole("radio", { name: "Dark theme" }));
    expect(root().dataset.mutinyScheme).toBe("dark");
    expect(root()).toHaveClass("dark");
    expect(root().style.colorScheme).toBe("dark");
    expect(root().style.getPropertyValue("--mutiny-surface")).toBe(mutinyDarkTheme.colors.surface);
    expect(root().style.getPropertyValue("--mutiny-viewer-background")).toBe(mutinyDarkTheme.viewer.background);
    expect(root().style.getPropertyValue("--mutiny-viewer-edges")).toBe(mutinyDarkTheme.viewer.edges);
  });

  it("system follows the OS, including a change while the window is open", () => {
    system.set(true);
    render(
      <MutinyThemeProvider presentation="standalone">
        <ThemeToggle />
      </MutinyThemeProvider>,
    );
    expect(root().dataset.mutinySchemePreference).toBe("system");
    expect(root().dataset.mutinyScheme).toBe("dark");
    act(() => system.set(false));
    expect(root().dataset.mutinyScheme).toBe("light");
  });

  it("an explicit pick ignores the OS", () => {
    system.set(true);
    render(
      <MutinyThemeProvider presentation="standalone" colorSchemeAdapter={createMemoryColorSchemeAdapter("light")}>
        <ThemeToggle />
      </MutinyThemeProvider>,
    );
    expect(root().dataset.mutinyScheme).toBe("light");
  });

  it("syncs with the host both ways: a click saves through the adapter, and a change elsewhere shows here", async () => {
    const memory = createMemoryColorSchemeAdapter("light");
    const saved: MutinyColorScheme[] = [];
    const adapter: ColorSchemeAdapter = { get: memory.get, set: (s) => { saved.push(s); return memory.set(s); }, subscribe: memory.subscribe };
    render(
      <MutinyThemeProvider presentation="standalone" colorSchemeAdapter={adapter}>
        <ThemeToggle />
      </MutinyThemeProvider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Dark theme" }));
    expect(saved).toEqual(["dark"]);

    act(() => memory.set("light"));
    expect(root().dataset.mutinyScheme).toBe("light");
    expect(screen.getByRole("radio", { name: "Light theme" })).toHaveAttribute("aria-checked", "true");
  });

  it("reads a saved scheme that arrives later (a network read)", async () => {
    let answer: (s: MutinyColorScheme) => void = () => undefined;
    const adapter: ColorSchemeAdapter = { get: () => new Promise((resolve) => { answer = resolve; }), set: () => undefined };
    render(
      <MutinyThemeProvider presentation="standalone" colorSchemeAdapter={adapter}>
        <ThemeToggle />
      </MutinyThemeProvider>,
    );
    expect(root().dataset.mutinyScheme).toBe("light");
    await act(async () => answer("dark"));
    expect(root().dataset.mutinyScheme).toBe("dark");
  });

  it("goes back and says so when saving fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const adapter: ColorSchemeAdapter = { get: () => "light", set: () => Promise.reject(new Error("offline")) };
    render(
      <MutinyThemeProvider presentation="standalone" colorSchemeAdapter={adapter}>
        <ThemeToggle />
      </MutinyThemeProvider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Dark theme" }));
    await waitFor(() => expect(root().dataset.mutinyScheme).toBe("light"));
    expect(screen.getByTestId("mutiny-theme-error")).toHaveAttribute("aria-label", expect.stringContaining("Couldn't save your theme"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("set() failed"), expect.objectContaining({ next: "dark", previous: "light" }));
    spy.mockRestore();
  });

  it("embedded: no toggle of its own (even with an adapter) and follows the host's scheme", () => {
    const { rerender } = render(
      <MutinyThemeProvider presentation="embedded" colorScheme="dark" colorSchemeAdapter={createMemoryColorSchemeAdapter("light")}>
        <ThemeToggle />
      </MutinyThemeProvider>,
    );
    expect(screen.queryByTestId("mutiny-theme-toggle")).toBeNull();
    expect(root().dataset.mutinyScheme).toBe("dark");
    rerender(
      <MutinyThemeProvider presentation="embedded" colorScheme="light">
        <ThemeToggle />
      </MutinyThemeProvider>,
    );
    expect(screen.queryByTestId("mutiny-theme-toggle")).toBeNull();
    expect(root().dataset.mutinyScheme).toBe("light");
  });

  it("server-renders the scheme the host knows, so the first paint is right", () => {
    const html = renderToString(
      <MutinyThemeProvider presentation="standalone" initialSystemScheme="dark">
        <ThemeToggle />
      </MutinyThemeProvider>,
    );
    expect(html).toContain('data-mutiny-scheme="dark"');
    expect(html).toContain(`--mutiny-surface:${mutinyDarkTheme.colors.surface}`);
  });

  it("a page that is only MutinyBIM gets the scheme on <html> for native controls, and it is removed on unmount", () => {
    const { unmount } = render(
      <MutinyThemeProvider presentation="standalone" colorSchemeAdapter={createMemoryColorSchemeAdapter("dark")} applyToDocument>
        <span />
      </MutinyThemeProvider>,
    );
    expect(document.documentElement.dataset.mutinyScheme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    unmount();
    expect(document.documentElement.dataset.mutinyScheme).toBeUndefined();
  });
});
