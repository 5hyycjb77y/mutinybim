import {
  SYSTEM_LINE_PATTERNS,
  categoryLook,
  isViewCategory,
  type CategoryId,
  type CategoryLook,
  type CategoryOverride,
  type CategoryOverrides,
  type CategoryRegistry,
  type LineWeight,
  type ViewElement,
  type ViewPropsPatch,
} from '@permitzip/bim-kernel'

/**
 * What one change in Visibility/Graphics writes. View categories (Duct,
 * Electrical devices…) keep writing the older fields for show/hide and pens,
 * which every model server stores; halftone, pattern, and every class,
 * system and firm category write `categoryOverrides`, which the model server
 * stores once it advertises per-category graphics.
 */
export type GraphicsEdit =
  | { readonly field: 'visible'; readonly value: boolean }
  | { readonly field: 'halftone'; readonly value: boolean }
  | { readonly field: 'cut' | 'projection'; readonly value: LineWeight | null }
  | { readonly field: 'pattern'; readonly value: string | null }

function withoutField(o: CategoryOverride | undefined, field: keyof CategoryOverride): CategoryOverride {
  if (!o) return {}
  const { [field]: _dropped, ...rest } = o
  return rest
}

function normalized(o: CategoryOverride): CategoryOverride | null {
  const lw = o.lineWeights
  const cleaned: CategoryOverride = lw && !lw.cut && !lw.projection ? withoutField(o, 'lineWeights') : o
  return Object.keys(cleaned).length === 0 ? null : cleaned
}

type PatchOverrides = NonNullable<ViewPropsPatch['categoryOverrides']>

/** The stored overrides with `id` replaced, as a patch the view schema accepts: a pattern outside the system patterns is dropped, since the schema would refuse it. */
function withOverride(all: CategoryOverrides | undefined, id: CategoryId, next: CategoryOverride | null): PatchOverrides {
  const out: PatchOverrides = {}
  for (const [key, o] of Object.entries({ ...(all ?? {}), ...(next ? { [id]: next } : {}) })) {
    if (key === id && !next) continue
    const { pattern, ...rest } = o
    const known = SYSTEM_LINE_PATTERNS.find((p) => p === pattern)
    out[key] = known ? { ...rest, pattern: known } : rest
  }
  return out
}

/** The look a category would have with its own override field removed: what "Default" shows. */
export function inheritedLook(view: Pick<ViewElement, 'props'>, id: CategoryId, field: keyof CategoryOverride, categories: CategoryRegistry): CategoryLook {
  const props = view.props ?? {}
  const own = props.categoryOverrides?.[id]
  if (!own || own[field] === undefined) return categoryLook(view, id, categories)
  const cleared = normalized(withoutField(own, field))
  return categoryLook({ props: { ...props, categoryOverrides: withOverride(props.categoryOverrides, id, cleared) } }, id, categories)
}

/** The `set_view_properties` patch for one change to one category's row. */
export function graphicsPatch(view: Pick<ViewElement, 'props'>, id: CategoryId, edit: GraphicsEdit, categories: CategoryRegistry): ViewPropsPatch {
  const props = view.props ?? {}
  const overrides = props.categoryOverrides
  const own = overrides?.[id]
  if (isViewCategory(id) && edit.field === 'visible' && own?.visible === undefined) {
    const hidden = new Set(props.hiddenCategories ?? [])
    if (edit.value) hidden.delete(id)
    else hidden.add(id)
    return { hiddenCategories: [...hidden] }
  }
  if (isViewCategory(id) && (edit.field === 'cut' || edit.field === 'projection') && own?.lineWeights?.[edit.field] === undefined) {
    const current = props.lineWeights?.[id] ?? {}
    const cut = edit.field === 'cut' ? (edit.value ?? undefined) : current.cut
    const projection = edit.field === 'projection' ? (edit.value ?? undefined) : current.projection
    const { [id]: _old, ...others } = props.lineWeights ?? {}
    return { lineWeights: cut || projection ? { ...others, [id]: { ...(cut ? { cut } : {}), ...(projection ? { projection } : {}) } } : others }
  }
  let next: CategoryOverride
  switch (edit.field) {
    case 'visible': {
      const base = withoutField(own, 'visible')
      next = edit.value === inheritedLook(view, id, 'visible', categories).visible ? base : { ...base, visible: edit.value }
      break
    }
    case 'halftone': {
      const base = withoutField(own, 'halftone')
      next = edit.value === (inheritedLook(view, id, 'halftone', categories).halftone === true) ? base : { ...base, halftone: edit.value }
      break
    }
    case 'cut':
    case 'projection': {
      const lw = own?.lineWeights ?? {}
      const cut = edit.field === 'cut' ? (edit.value ?? undefined) : lw.cut
      const projection = edit.field === 'projection' ? (edit.value ?? undefined) : lw.projection
      next = { ...withoutField(own, 'lineWeights'), lineWeights: { ...(cut ? { cut } : {}), ...(projection ? { projection } : {}) } }
      break
    }
    case 'pattern':
      next = edit.value ? { ...withoutField(own, 'pattern'), pattern: edit.value } : withoutField(own, 'pattern')
      break
  }
  return { categoryOverrides: withOverride(overrides, id, normalized(next)) }
}
