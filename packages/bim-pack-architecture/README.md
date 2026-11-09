# @permitzip/bim-pack-architecture

The MutinyBIM Architecture add-on (namespace `architecture`, first-party). Apache-2.0, private.

It holds the building itself: grids and reference planes, walls, doors, windows and openings,
floors and slabs, ceilings, roofs, columns and stairs, with their types and parameters, how wall
ends meet, the voids doors and windows cut in their hosts, which elements bound rooms, the
fire-resistance and smoke-barrier ratings other trades read, and the IFC4 mapping. It is built only
through the add-on contract (contract 1.11.0): the kernel imports nothing from it, and an outside
add-on could do the same with no kernel edits.

With this add-on off, walls, doors and windows still draw and still bound rooms; a note says their
types and rules come from the Architecture add-on.

Round 13 wave 0 ships the manifest and an empty contribution list; lane A13a fills it.
