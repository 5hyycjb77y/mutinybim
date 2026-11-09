import type { FormulaLibraryItem, LibraryItemSummary, LibraryProviderPort, LibraryQuery, LibraryScope, PublishResult, ScopeCapabilities } from "@permitzip/bim-schedules-ui";
import type { EditorDataAnswer, EditorDataHost } from "@permitzip/bim-editor-host";
import { EditorServiceUnavailableError, unavailableWords } from "@permitzip/bim-editor/host/unavailable";

/**
 * The browser's view of the host's firm library (`firmLibrary` port), shaped
 * as the schedule UI's `LibraryProviderPort` so the library browser, the
 * builder's calculation picker and "Save to firm library" all use one path.
 */

const LIBRARY = "The firm library";

interface ScopesBody {
  readonly scopes: readonly LibraryScope[];
  readonly capabilities: readonly (ScopeCapabilities & { readonly scope: string })[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isScopesBody(value: unknown): value is ScopesBody {
  return isRecord(value) && Array.isArray(value.scopes) && Array.isArray(value.capabilities);
}

function isItemsBody(value: unknown): value is { readonly items: readonly LibraryItemSummary[] } {
  return isRecord(value) && Array.isArray(value.items);
}

function isPublishResult(value: unknown): value is PublishResult {
  return isRecord(value) && typeof value.ok === "boolean" && (value.ok ? isRecord(value.summary) : typeof value.message === "string");
}

async function errorText(res: EditorDataAnswer): Promise<string> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error("[httpLibraryPort] reading the refusal failed", err);
    return null;
  });
  return isRecord(body) && typeof body.error === "string" ? body.error : `The library answered HTTP ${res.status}.`;
}

export function libraryPortFrom(port: EditorDataHost["firmLibrary"]): LibraryProviderPort & { refresh(): void } {
  let scopes: Promise<ScopesBody> | null = null;
  const loadScopes = () => {
    if (!port) return Promise.reject(new EditorServiceUnavailableError(LIBRARY));
    scopes ??= port
      .scopes()
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorText(res));
        const body: unknown = await res.json();
        if (!isScopesBody(body)) throw new Error("The library came back in an unexpected shape.");
        return body;
      })
      .catch((err: unknown) => {
        scopes = null;
        throw err;
      });
    return scopes;
  };
  return {
    refresh: () => {
      scopes = null;
    },
    scopes: async () => (await loadScopes()).scopes,
    capabilities: async (scope) => {
      const found = (await loadScopes()).capabilities.find((c) => c.scope === scope);
      return found ? { read: found.read, publish: found.publish, ...(found.reason ? { reason: found.reason } : {}) } : { read: false, publish: false, reason: "That library isn't available to you." };
    },
    list: async (scope: string, query?: LibraryQuery) => {
      if (!port) throw new EditorServiceUnavailableError(LIBRARY);
      const res = await port.search({ scope, ...(query?.type ? { type: query.type } : {}), ...(query?.text ? { text: query.text } : {}), ...(query?.includeDeprecated ? { includeDeprecated: true } : {}) });
      if (!res.ok) throw new Error(await errorText(res));
      const body: unknown = await res.json();
      if (!isItemsBody(body)) throw new Error("The library items came back in an unexpected shape.");
      return body.items;
    },
    publish: async (scope: string, item: FormulaLibraryItem, baseRevision: number) => {
      if (!port) return { ok: false, code: "forbidden", message: unavailableWords("Publishing to the firm library") };
      const res = await port.publish({ scope, item, baseRevision });
      const body: unknown = await res.json().catch((err: unknown) => {
        console.error("[httpLibraryPort] reading the publish answer failed", err);
        return null;
      });
      if (isPublishResult(body)) return body;
      if (isRecord(body) && typeof body.error === "string") return { ok: false, code: "forbidden", message: body.error };
      return { ok: false, code: "invalid", message: `Publishing failed (HTTP ${res.status}). Nothing was saved; try again.` };
    },
  };
}
