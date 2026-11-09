# Area-based loading

## In plain language

A full building model can hold a million elements. Nobody's browser should
load all of that, and nobody needs to: people work on one floor, or one part
of a floor, usually in one discipline. So each person loads **their area**,
for example "level 3, zone 2, mechanical". They then receive only the changes
that touch it.

- **Opening the model** sends only your area: about 5,000 elements (2 MB) for
  one zone, instead of 1 million (390 MB).
- **Someone else's edit** reaches you only if it touches your area. A change
  that runs through the building, such as resizing a riser through every
  level, reaches everyone on every level it touches, each with just their
  piece.
- **Edits elsewhere** still reach you as a tiny "revision N happened" notice,
  so your copy always knows where the model is and nothing silently goes
  missing.
- **Moving to another area** loads only what you didn't already have. You
  keep working; nothing reloads.
- **Conflicts, retries and the commit rules are unchanged.** The server still
  decides every edit against the whole model.

## Partitions

Every element carries a partition: `level`, `zone` (a spatial block on that
level) and `discipline` (architecture, structure, mechanical, plumbing,
electrical, fire_protection). Its key form is `level|zone|discipline`.
Elements without one, which is every element of the original duct-only
models, belong to `L1|Z1|mechanical`.

An **interest** is a list of areas, each a level with an optional zone, plus
optionally some disciplines. An absent interest means the whole model, and
clients without one behave exactly as before.

A changeset carries its partitions through its elements: each changed element
record includes its partition, and `changesetPartitions(cs)` lists them. No
changeset field was added, so changesets from the original models are
byte-identical to before.

Commands never move an element to another partition.

## The contract every backend must meet

1. **Join.** `hello` may include an `interest`. Reply with `welcome`
   containing `sliceModel(head, interest)`: the elements in the interest, and
   the connections whose two ends are both inside it.
2. **Every revision reaches every member, in order.**
   - If the changeset touches the member's interest, send it sliced with
     `sliceChangeset(cs, interest)`.
   - Otherwise send `{ type: "advance", revision, idempotencyKey }`, about 80
     bytes.
   - Clients detect gaps exactly as before, using a contiguous revision count.
3. **Interest change.** On `{ type: "interest", interest }`, apply the new
   filter **before** reading the head. Then send
   `{ type: "area", revision, interest, elements, connections }` for
   `addedInterest(old, new)` only. If nothing is added (the area narrowed),
   send nothing; the client drops what it no longer needs.
4. **Catch-up.** `sync` and the heartbeat use the same filter as live
   delivery: a sliced changeset or an `advance` per revision.
5. **Commit decision.** Unchanged. Decide on the full head with `planCommit`,
   and keep the same idempotency, conflict and lease rules.

How the client merges a newly loaded area:
- **Area ahead of the client:** the client holds it, catches up, and merges
  when its revision reaches it.
- **Same revision:** the area's records are current, so they overwrite.
- **Area behind the client:** it fills in only records the client doesn't
  hold yet, because anything that changed since already arrived in a
  changeset.

`__tests__/area.test.ts` pins every one of these rules. Each fails if its
rule is broken.

## Per candidate

- **B (own authority):** done in `SyncHub`. It keeps an interest per
  connection, filters every broadcast and sync, and answers `interest`
  messages with `area`.
  - The only per-commit cost is checking each connection against the
    changeset's partitions.
  - Join and area loads slice the head in memory: 80 ms at 250k elements,
    500 ms at 1M, worth caching per partition if joins are frequent.
  - The heartbeat head stays global.
- **A (Supabase only):**
  - **Rows:** add `level`, `zone` and `discipline` columns (or one
    `partition_key`) to element and connection rows, indexed with the model
    id. Join and area loads become filtered reads under the same row-level
    security.
  - **Realtime:** use a private channel per partition
    (`bim:<model>:p:<level>|<zone>|<discipline>`) for sliced changesets, plus
    one per-model `bim:<model>:rev` channel carrying only
    `{ revision, idempotencyKey }`.
  - **Publishing:** the commit transaction publishes each touched
    partition's slice to its channel and one revision notice. Clients
    subscribe to their partitions' channels and the revision channel, and
    treat a revision notice with no matching changeset as an `advance`.
  - **Channel access:** allow `bim:<model>:p:*` topics for members only,
    through the same policy as now.
- **C (SpacetimeDB):** follow Clockwork's guidance: subscribe to filtered
  queries of regions instead of a per-user view of everything.
  - **Rows:** give element, connection and changeset-event rows the same
    partition columns, and give the event rows the list of partitions they
    touch.
  - **Join:** a one-off subscription filtered by `model_id` and partition.
  - **Live:** the commit event table broadcasts per transaction.
    - Clients subscribe to it filtered by model and partition, receiving
      one event row per touched partition carrying that slice.
    - Plus a small revision-only event row per commit for `advance`.
  - **Access control:** anonymous views that take a region (Clockwork: "views
    that return entities in region X"), or row-level security on the event
    table.
  - **Interest change:** unsubscribe from the old partitions and subscribe to
    the new ones, then build `area` from the new subscription's first
    result.

## The test building (`createFullBimModel`)

Each zone is 100 ft × 100 ft (10,000 sq ft). At default density one zone
holds **5,086 elements**:

| Discipline | Elements | What |
|---|---|---|
| Architecture | 684 | slab, 93 walls, 40 rooms, 40 doors, 26 windows, ceilings, floor finishes, 6 furniture/casework per room, curtain wall panels + mullions, tags, room dimensions, views, sheet |
| Structure | 110 | 10 grids, 25 columns + footings, 40 beams, bay dimensions, view, sheet |
| Mechanical (air) | 1,191 | 9 VAV trunks × 10 segments, 180 diffusers (tap, riser, elbow, run each), air riser, tags, view, sheet |
| Plumbing (water) | 1,191 | same shape: 180 fixtures, water riser |
| Fire protection | 479 | 4 mains × 9 segments, 72 heads, standpipe riser |
| Electrical | 1,431 | power (8 × 9, 144 receptacles) + lighting (4 × 9, 72 troffers), riser |

That is about **510 elements per 1,000 sq ft**. Of those:
- **MEP networks:** 46% are the network pieces of the four systems.
- **Tags:** 15%.
- **Architecture:** 13%.
- **Structure:** 2%.

Where the densities come from (research in this thread, 2026-10-17):
- **Ductwork:** about 99 connected elements per 1,000 sq ft. That is inside
  the 60–120 hospital band derived from diffuser spacing of one per
  150–200 sq ft ([ASHRAE Houston, AMCA](https://ashraehouston.org/images/meeting/101019/amca_inmotion_air_distribution_design_for_comfort_in_high_performance_air_systems.pdf)).
- **Piping ≈ duct pieces.** The Zambrano Hellion hospital, Monterrey, had
  12,000 duct pieces and 11,000+ piping components
  ([Autodesk/TTQ](http://images.autodesk.com/apac_anz/files/1259792862-ttq_final.pdf)).
- **Sprinklers, power and lighting:** estimates.
  - Sprinklers at about one head per 140 sq ft.
  - Receptacles and lights at about 22 devices per 1,000 sq ft.
- **Calibration:** whole buildings land between the coarse 2009 Monterrey
  model (about 22 HVAC items per 1,000 sq ft) and Inselspital's ~1M elements
  for 880k sq ft across all disciplines (about 1,100 per 1,000 sq ft;
  [Graphisoft](https://www.casestudies.com/company/graphisoft/case-study/inselspital-delivers-an-82000-sqm-hospital-hub-with-graphisoft)).

Tiers (`FULL_BIM_TIERS`):

| Tier | Floors × zones | Elements | Building | JSON | Generate | Full validate |
|---|---|---|---|---|---|---|
| XS | 2 × 2, reduced | 2,104 | — | 0.7 MB | 10 ms | 2 ms |
| 250k | 7 × 7 | 249,214 | 490k sq ft | 97 MB | 1.1 s | 0.24 s |
| 500k | 14 × 7 | 498,428 | 980k sq ft | 193 MB | 2.7 s | 0.66 s |
| 1M | 14 × 14 | 996,856 | 1.96M sq ft | 388 MB | 6.4 s | 1.4 s |

Every zone slice is a valid model on its own: 5,086 elements, 2 MB.

### Kernel cost, from `scripts/bench-full-bim.ts` on one laptop

| Tier | Warm commit on the whole model | Same edit on one zone's slice |
|---|---|---|
| 250k | ~71–80 ms | 0.7–3 ms |
| 500k | ~185–205 ms | ~6 ms |
| 1M | ~430–445 ms | ~12 ms |

These timings cover every category: move a wall, slide a branch, change a
load, resize a riser through every level, and retag.

- **Changesets stay small:** 0.8–8 KB.
- **Riser edits touch one partition per level:** 7 at 250k, 14 at 500k and
  1M.
- **First commit on a freshly loaded whole model:** 0.7 s at 250k, 1.6 s at
  500k, 3.6 s at 1M. It pays one-off full validation and consistency checks.
- **First load-change commit:** pays the flow-ordering pass once, 1.6 s at
  1M.

**Finding for the backend step.** Commit time on the whole model is
dominated by copying the element record, which grows with model size. A
server that keeps the whole 1M-element model in one process pays about
0.4 s per commit. Area loading keeps browsers fast, but before the 1M
comparison means anything on the server side, the kernel needs structural
sharing of the element record, such as a persistent map, or the server must
shard per partition.

## Simplifications in the test building

- **Systems stay inside one zone; risers link levels.** Each system is a
  tree inside one zone, and risers are separate per-level pieces linked by
  `riserId`. A network crossing zones would need its slice to include the
  crossing connection's far end. That isn't modelled yet.
- **Rooms don't follow their walls.** Doors, windows, tags and dimensions do
  follow a moved wall.
- **Pipes, conduit and sprinklers reuse the duct network kinds** with a
  `service` field. Their "airflow" totals stand in for flow and load.
