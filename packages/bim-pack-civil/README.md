# @permitzip/bim-pack-civil

The MutinyBIM civil proof pack (Apache-2.0). It exists to prove that a whole discipline can be
added through the add-on contract (`@permitzip/bim-pack`) with no edit to the kernel; CI holds
it to that (`packages/bim-kernel/__tests__/c5k-proof-pack-isolation.test.ts`).

## What it does

- **Classes** (`civil.*`, each with an IFC 4.3 hint): storm inlet, manhole, outfall, storm
  pipe, alignment, catchment.
- **Model.** Inlets, manholes and outfalls are parts of the pack's structure types (pipe
  connectors, rim and invert parameters); storm pipes are the kernel's run segments routed
  between them on a `civil.storm` system in reinforced concrete pipe (`civil.rcp`); catchments
  are outlined zones with C or a surface in `values`; the system carries the design storm and
  minimum slope. An alignment is a path placement with stations, arcs and a vertical profile.
- **Runoff.** The rational method Q = C·i·A, exact in SI (the US habit of reading ac·in/h as cfs
  is 0.83 % low; the calc shows both). C comes from the catchment, or from its surface type.
- **Network.** A network to total on the adapter point: the kernel's `serviceNetworkTotals`
  carries runoff inlet → pipe → manhole → outfall; pipe direction comes from the network, not
  the drawing; the fall check is the kernel's gravity regime; one catchment edit re-totals only
  its path to the outfall.
- **Checks and calcs.** Lint rules `civil.inlet_overloaded` and `civil.slope_below_minimum`;
  calcs `civil.rational_runoff`, `civil.manning_full_capacity` and `civil.surface_cut_fill`.
- **Stationing.** Station of a point, point at a station, `10+00.00` / `1+000.000` labels, on the
  kernel's published placement math.
- **Grading surfaces.** LandXML 1.2 TIN surfaces (`Pnts` + `Faces`) for existing and proposed
  ground, stored as `civil.grading_surface` elements. Cut, fill and net over the plan overlap.

## Grading surfaces and earthwork

`civil.import_landxml_surfaces` reads a LandXML 1.2 file and writes one element per TIN. A
point's text is **northing, easting, elevation** (LandXML order). Easting is plan x and northing
is plan y, the same frame as the rest of the model. The length unit comes from `<Units>`
(`foot` → `ft`, `meter` → `m`, and the other LandXML 1.2 length tokens bim-units knows).

**US survey feet** (`USSurveyFoot`) are not a bim-units length. They are converted to metres at
the defined ratio 1200/3937 and stored as metres. The international foot is a different length,
so a survey-foot file is not stored as `ft`. The import note says so.

A surface named like "Existing" or "EG" is marked existing; "Proposed", "FG", "finish" or
"design" is marked proposed. Pass `roles` to say so yourself. Anything else stays unassigned
until you do.

**Volume.** `civil.surface_cut_fill` (and `cutFillBetween`) reports cut, fill and net in cubic
yards and cubic metres, plus the overlap area. Net is fill minus cut: positive is material to
haul in, negative is material to haul off.

The method is the prismoidal volume on the composite TIN. Every triangle of one surface is
clipped, in plan, against every triangle of the other. Each piece of that overlay lies in one
triangle of each surface, so both are planes there. The signed volume of that prism is

```text
V = A · (Δz1 + Δz2 + Δz3) / 3
```

where A is the plan area and Δz is proposed elevation minus existing elevation at the three
corners. Where Δz changes sign inside a triangle, the triangle is split on the zero contour so
cut and fill are not netted in one prism. On planar facets this is exact: a fine grid approaches
the same quantity and adds a cell-size error this overlay does not. The code comment on
`cutFillBetween` says the same thing.

Only the ground **both** surfaces cover is in the volume. Ground only one of them covers is
reported as no overlap and adds nothing. A vertical face has no plan area and adds nothing.

**Licensed review is pending.** This calculation is not for a permit set or a bid until a
licensed civil engineer has reviewed it. Issue
[#44](https://github.com/permitzip/mutinybim/issues/44) carries the `needs licensed review`
label for that reason. The calc repeats the warning on every run.

**Not in this slice.** Spot elevations and slopes as their own objects, contours, corridors,
mass haul, a shrink or swell factor, and drawing the TIN in plan or 3D. A 2D uniform grid and
per-triangle AABB prefilter prune non-overlapping triangle pairs, and each surface stays under
8,000 triangles (`MAX_TIN_FACES`) and 16,000 vertices (`MAX_TIN_POINTS`). LandXML 1.2 invisible
faces (`i="1"`) are skipped with a note. That pass is on demand; it is not an edit of the
building model and it does not scan the other elements. Overlapping triangles inside one surface
are counted twice — a TIN shouldn't do that, and this slice doesn't check.

### Kernel gaps this slice did not paper over by editing the kernel

A civil change must not also modify `packages/bim-kernel` (the proof-pack rule). These are why
the mesh lives on the add-on's element instead of a kernel type:

- A pack parameter (`ParamValue`) is a number, a flag or a string of at most 400 characters
  (`set_element_values`). A TIN does not fit.
- Element-kind shape forms the kernel names are plan `point` and `points` (`Vec2`), not a 3D
  indexed mesh. The open forms `civil.tin_vertices` and `civil.tin_faces` are kept and not
  interpreted. Conflict detection of authored fields sees scalars and plan points, not the mesh.
- `kernel.surface_face` is a horizontal building face (a slab, a ceiling), not terrain.
- bim-units has the international foot and no US survey foot. Conversion at import is the
  workaround; adding `ftUS` would be a units change, not this slice.
- Merging the kind into `AddOnElementTypes` would put `civil.grading_surface` on
  `ElementKind`. The kernel's `ELEMENT_KINDS` list is exhaustive (`MissingKind extends never`
  in `registry/element-kinds.ts`), and a kernel test builds a `Record<ElementKind, …>`.
  Either change is a kernel edit, so this slice doesn't merge the kind. The record is stored
  as a kind the kernel keeps without naming, which is what `elementKindsInForce` already says
  to do.

There is no kernel command that writes an arbitrary add-on shape, so the pack command writes
the record itself through the published edit path (`draftElements` / `finish`). Creating one
still waits until every peer stores add-on shapes (`kinds:addon_shapes`).

## Limits

- One design intensity for the whole network; no time of concentration, so peaks add
  (conservative). Small catchments only (the rational method's usual limit, about 200 acres).
- The slope check uses the structures' inverts; a pipe's own end inverts, drops and a pumped
  flag are not read. Open contract items: the internal design note,
  "Foundation gaps found".
- Grading is TIN-to-TIN cut and fill over the overlap only. No corridors, mass haul, shrink or
  swell, spot-elevation objects, or a drawn surface. See "Grading surfaces and earthwork".
- Earthwork volumes need a licensed civil engineer's review before they are used. Pending.
- Synthetic test data only (`demo-site`).
