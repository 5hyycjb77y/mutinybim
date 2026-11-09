# @permitzip/bim-pack-site

MutinyBIM's Site add-on (round 11). What is known about the land before anything is drawn:

- **Site constraint** (`site.constraint`): a setback, easement, flood zone, environmental
  finding, utility capacity or height limit, with its values (distance, elevation, capacity,
  the finding's reference) and the parcel it binds.
- **Parcel** (`site.parcel`): a piece of land inside the model's site, with its area, number
  and zoning district.

Both are intent records: values with no geometry. The add-on also registers the `parcel`
requirement anchor, so a rule tied to a parcel produces its requirement before a building
exists. It ships no rules.

Built only through the add-on contract (`@permitzip/bim-pack`); imports no kernel source.
Apache-2.0.
