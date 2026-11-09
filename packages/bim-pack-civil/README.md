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
  calcs `civil.rational_runoff` and `civil.manning_full_capacity`.
- **Stationing.** Station of a point, point at a station, `10+00.00` / `1+000.000` labels, on the
  kernel's published placement math.

## Limits

- One design intensity for the whole network; no time of concentration, so peaks add
  (conservative). Small catchments only (the rational method's usual limit, about 200 acres).
- The slope check uses the structures' inverts; a pipe's own end inverts, drops and a pumped
  flag are not read. Open contract items: the internal design note,
  "Foundation gaps found".
- No terrain surfaces, grading, corridors or earthwork.
- Synthetic test data only.
