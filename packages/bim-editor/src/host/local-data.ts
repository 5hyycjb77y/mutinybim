import type {
  EditorDataAnswer,
  EditorDataHost,
  EditorFirmLibraryPort,
  EditorLayoutPrefsPort,
  EditorRouteDefaultsPort,
  EditorSchedulePrefsPort,
  EditorTitleBlocksPort,
  EditorViewPrefsPort,
} from '@permitzip/bim-editor-host'
import type { FileLibraryProvider, LibraryQuery } from '@permitzip/bim-library'

/**
 * The standalone app's server requests: what one computer can answer by
 * itself. The library browser reads the built-in catalog (and the add-ons'
 * rows); there is no firm library to save to, so saving says so. Layout,
 * schedule column widths, Route defaults and where each view was left are
 * kept for this visit. Every
 * other port is absent, so the editor says, in plain words, that it isn't
 * available here.
 */

/** A host answer with a JSON body, the way a server would send it. */
export function jsonAnswer(body: unknown, status = 200): EditorDataAnswer {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  }
}

const NO_FIRM_LIBRARY = 'This computer has no firm library to save to. The built-in library still works; to share items with a firm, open the model where a firm library is connected.'

function refusal(message: string): EditorDataAnswer {
  return jsonAnswer({ ok: false, code: 'read_only', message, error: message }, 403)
}

const BUILTIN = 'builtin'

/** The built-in catalog as a library provider, loaded the first time the library is opened. */
function builtinLibrary(): () => Promise<FileLibraryProvider> {
  let loaded: Promise<FileLibraryProvider> | null = null
  return () => {
    loaded ??= Promise.all([import('@permitzip/bim-library'), import('@permitzip/bim-library/bim-formula')])
      .then(([{ FileLibraryProvider: Provider, builtinLibrarySource }, { bimFormulaEngine, bimUnitsCatalog }]) => new Provider({ env: { formula: bimFormulaEngine, units: bimUnitsCatalog }, sources: [builtinLibrarySource()] }))
      .catch((err: unknown) => {
        console.error('[local-data] the built-in library could not be loaded', err)
        loaded = null
        throw err
      })
    return loaded
  }
}

function localFirmLibrary(): EditorFirmLibraryPort {
  const library = builtinLibrary()
  const items = async (query: { readonly scope: string; readonly type?: string; readonly text?: string; readonly includeDeprecated?: boolean }): Promise<EditorDataAnswer> => {
    // The firm's and a project's scopes are empty here: only the built-in catalog exists on this computer.
    if (query.scope !== BUILTIN) return jsonAnswer({ items: [] })
    const provider = await library()
    const { scope, ...filters } = query
    // The type is the item type the editor asked for; an unknown one simply lists nothing.
    const listed = await provider.list(scope, filters as LibraryQuery)
    return jsonAnswer({ items: listed })
  }
  return {
    async scopes() {
      const provider = await library()
      const scopes = await provider.scopes()
      const capabilities = await Promise.all(scopes.map(async (s) => ({ scope: s.id, ...(await provider.capabilities(s.id)), publish: false, reason: NO_FIRM_LIBRARY })))
      return jsonAnswer({ scopes, capabilities })
    },
    listOfType: ({ scope, type }) => items({ scope, type }),
    search: (query) => items(query),
    publish: async () => refusal(NO_FIRM_LIBRARY),
    fields: async () => jsonAnswer({ fields: [], project: { allowed: false, reason: NO_FIRM_LIBRARY } }),
    partTypes: async () => jsonAnswer({ canPublish: false, partTypes: [] }),
    publishPartType: async () => refusal(NO_FIRM_LIBRARY),
    importPartType: async () => refusal(NO_FIRM_LIBRARY),
    // No firm part library on this computer: Place part offers the built-in and model parts only.
    firmParts: async () => refusal(NO_FIRM_LIBRARY),
    scheduleTemplates: async () => jsonAnswer({ canWrite: false, firm: [] }),
    saveScheduleTemplate: async () => refusal(NO_FIRM_LIBRARY),
  }
}

/** No firm title blocks here: new sheets use the built-in title block types. */
const localTitleBlocks: EditorTitleBlocksPort = {
  list: async () => jsonAnswer({ choices: [], defaultId: null, canWrite: false }),
  makeDefault: async () => refusal(NO_FIRM_LIBRARY),
}

type Collapsed = { readonly [sectionId: string]: boolean }

function memoryLayoutPrefs(): EditorLayoutPrefsPort {
  const surfaces = new Map<string, { readonly surface: string; readonly collapsed: Collapsed; readonly widthPx: number | null }>()
  return {
    read: async () => jsonAnswer({ surfaces: [...surfaces.values()] }),
    async save(input) {
      surfaces.set(input.surface, { surface: input.surface, collapsed: input.collapsed, widthPx: input.widthPx })
      return jsonAnswer({ ok: true })
    },
  }
}

function memorySchedulePrefs(): EditorSchedulePrefsPort {
  const widths = new Map<string, { readonly [column: string]: number }>()
  const lastOpened = new Map<string, string>()
  const key = (projectId: string, viewId: string) => `${projectId}\u0000${viewId}`
  return {
    read: async ({ projectId, viewId }) => jsonAnswer({ viewId, columnWidths: widths.get(key(projectId, viewId)) ?? {}, frozenColumns: null, expandedRows: [], lastOpenedViewId: lastOpened.get(projectId) ?? null }),
    async opened({ projectId, viewId }) {
      lastOpened.set(projectId, viewId)
      return jsonAnswer({ ok: true })
    },
    async saveColumnWidths({ projectId, viewId, columnWidths }) {
      widths.set(key(projectId, viewId), columnWidths)
      return jsonAnswer({ ok: true })
    },
  }
}

const ROUTE_DOMAINS = ['duct', 'pipe'] as const
type RouteSettings = { readonly [setting: string]: unknown }

function memoryRouteDefaults(): EditorRouteDefaultsPort {
  const saved = new Map<string, RouteSettings>()
  const key = (scope: string, domain: string) => `${scope}\u0000${domain}`
  const rows = (projectId: string) =>
    ROUTE_DOMAINS.map((domain) => {
      const allProjects = saved.get(key('all', domain)) ?? null
      const thisProject = saved.get(key(projectId, domain)) ?? null
      const effective = allProjects || thisProject ? { ...(allProjects ?? {}), ...(thisProject ?? {}) } : null
      return { domain, allProjects, thisProject, effective }
    })
  const isSettings = (value: unknown): value is RouteSettings => typeof value === 'object' && value !== null && !Array.isArray(value)
  return {
    read: async ({ projectId }) => jsonAnswer({ defaults: rows(projectId) }),
    async save({ projectId, domain, scope, settings }) {
      const at = key(scope === 'all' ? 'all' : projectId, domain)
      if (settings === null) saved.delete(at)
      else if (isSettings(settings)) saved.set(at, settings)
      else return jsonAnswer({ error: 'Those route defaults are not settings this page can keep.' }, 400)
      return jsonAnswer({ defaults: rows(projectId) })
    },
  }
}

/** Where each 3D view was left and whether each view opens on its printed drawing, kept for this visit. */
function memoryViewPrefs(): EditorViewPrefsPort {
  const cameras = new Map<string, Map<string, unknown>>()
  const displays = new Map<string, Map<string, 'model' | 'drawing'>>()
  const of = <V>(byProject: Map<string, Map<string, V>>, projectId: string): Map<string, V> => {
    let m = byProject.get(projectId)
    if (!m) byProject.set(projectId, (m = new Map()))
    return m
  }
  return {
    cameras: async ({ projectId }) => jsonAnswer({ cameras: Object.fromEntries(of(cameras, projectId)) }),
    async saveCamera({ projectId, viewKey, camera }) {
      of(cameras, projectId).set(viewKey, camera)
      return jsonAnswer({ viewKey })
    },
    displays: async ({ projectId }) => jsonAnswer({ displays: Object.fromEntries(of(displays, projectId)) }),
    async saveDisplay({ projectId, viewId, display }) {
      of(displays, projectId).set(viewId, display)
      return jsonAnswer({ viewId, display })
    },
  }
}

/** The standalone app's server requests: what one computer and the local model server can answer. */
export function createLocalDataHost(): EditorDataHost {
  return {
    firmLibrary: localFirmLibrary(),
    titleBlocks: localTitleBlocks,
    layoutPrefs: memoryLayoutPrefs(),
    schedulePrefs: memorySchedulePrefs(),
    routeDefaults: memoryRouteDefaults(),
    viewPrefs: memoryViewPrefs(),
  }
}
