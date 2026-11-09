/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { MutinyMark, MutinySplash, MutinyThemeProvider, useMutinyTheme, type MutinyThemeAdapter } from "../src";

function rootOf(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>("[data-mutiny-root]");
  if (!root) throw new Error("no MutinyBIM root rendered");
  return root;
}

function AccentProbe() {
  return <span data-testid="accent">{useMutinyTheme().colors.accent}</span>;
}

const hostAdapter: MutinyThemeAdapter = () => ({ id: "host", colors: { accent: "#a8471b", surface: "#fbfaf8" }, viewer: { selection: "#a8471b" } });

describe("MutinyThemeProvider", () => {
  it("scopes the Mutiny default as CSS variables on its own root, not the page", () => {
    const { container } = render(
      <MutinyThemeProvider>
        <AccentProbe />
      </MutinyThemeProvider>,
    );
    const root = rootOf(container);
    expect(root.style.getPropertyValue("--mutiny-accent")).toBe("#D7E620");
    expect(root.style.getPropertyValue("--mutiny-viewer-selection")).toBe("#D7E620");
    expect(root.dataset.mutinyTheme).toBe("mutiny-default");
    expect(document.documentElement.style.getPropertyValue("--mutiny-accent")).toBe("");
    expect(screen.getByTestId("accent")).toHaveTextContent("#D7E620");
  });

  it("lets a host adapter map its own tokens, and explicit overrides win over the adapter", () => {
    const { container, rerender } = render(
      <MutinyThemeProvider adapter={hostAdapter}>
        <AccentProbe />
      </MutinyThemeProvider>,
    );
    expect(rootOf(container).style.getPropertyValue("--mutiny-surface")).toBe("#fbfaf8");
    expect(rootOf(container).style.getPropertyValue("--mutiny-viewer-selection")).toBe("#a8471b");
    expect(screen.getByTestId("accent")).toHaveTextContent("#a8471b");

    rerender(
      <MutinyThemeProvider adapter={hostAdapter} theme={{ colors: { accent: "#000000" } }}>
        <AccentProbe />
      </MutinyThemeProvider>,
    );
    expect(screen.getByTestId("accent")).toHaveTextContent("#000000");
    expect(rootOf(container).style.getPropertyValue("--mutiny-surface")).toBe("#fbfaf8");
  });

  it("adds host bridge variables and, for a page that is only MutinyBIM, writes them on <html> and cleans up", () => {
    const { container, unmount } = render(
      <MutinyThemeProvider presentation="standalone" hostVars={(t) => ({ "--primary": t.colors.accent })} applyToDocument>
        <span />
      </MutinyThemeProvider>,
    );
    expect(rootOf(container).style.getPropertyValue("--primary")).toBe("#D7E620");
    expect(document.documentElement.style.getPropertyValue("--mutiny-surface")).toBe("#FBFBFB");
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("#D7E620");
    unmount();
    expect(document.documentElement.style.getPropertyValue("--mutiny-surface")).toBe("");
  });

  it("logs a theme a host built wrong instead of failing silently", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    render(
      <MutinyThemeProvider theme={{ viewer: { edges: "black" as `#${string}` } }}>
        <span />
      </MutinyThemeProvider>,
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[MutinyThemeProvider]"), expect.objectContaining({ problems: ['Viewer color "edges" must be a #rrggbb color, got "black".'] }));
    spy.mockRestore();
  });

  it("shows the full brand when standalone and only a small mark when embedded", () => {
    const standalone = render(
      <MutinyThemeProvider presentation="standalone" theme={{ brand: { logoUrl: "/brand/logo.png" } }}>
        <MutinySplash status="Opening the model…" />
      </MutinyThemeProvider>,
    );
    expect(screen.getByTestId("mutiny-splash")).toHaveAttribute("data-presentation", "standalone");
    expect(screen.getByAltText("MutinyBIM logo")).toHaveAttribute("src", "/brand/logo.png");
    expect(screen.getByRole("img", { name: "MutinyBIM" })).toBeInTheDocument();
    standalone.unmount();

    render(
      <MutinyThemeProvider presentation="embedded">
        <MutinySplash status="Opening the model…" />
        <MutinyMark />
      </MutinyThemeProvider>,
    );
    expect(screen.getByTestId("mutiny-splash")).toHaveAttribute("data-presentation", "embedded");
    expect(screen.queryByAltText("MutinyBIM logo")).toBeNull();
    expect(screen.getAllByTestId("mutiny-mark")[0]).toHaveTextContent("MutinyBIM");
  });
});
