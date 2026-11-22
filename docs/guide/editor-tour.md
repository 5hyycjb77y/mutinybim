# A tour of the editor

The Building Model editor is where you draw and change a model. This page
says what you see and where the main tools are. Names in **bold** are the
words on the screen.

Open a model from **My models** to get here (see
[Getting started](getting-started.md)). Everyone with the model open sees
each other's changes live.

## The screen

<!-- screenshot: the editor with the ribbon, the left sidebar and a plan -->

- **The ribbon** across the top holds the tools, sorted into tabs.
- **The left sidebar** lists the model's views and sheets and what the open
  view shows. Drag its right edge to make it wider.
- **The view** in the middle: a plan, the 3D model, a drawing or a sheet.

When you open a model shared with you to view, the bar above the editor
shows **View only**, and tools that change the model are off. Hover a tool
that is off to read why.

## The ribbon

The tabs are **Model**, **Annotate**, **Modify**, **Views**, **Sheets** and
**Manage**, plus a tab for each trade add-on, such as **Architecture**,
**Mechanical**, **Electrical** and **Plumbing**.

- **Select** sits at the left of every tab.
- **Undo** and **Redo** sit at the right on every tab.
- **Find a tool** (or press `/`) searches every command on every tab, opens
  its tab and runs it. Use it when you know what you want but not where it
  lives.
- The arrows at the far right fold the ribbon to one row of icons, and back.
- A group with more than five tools puts the rest under **More**.
- When you select something, a tab for it appears and opens by itself:
  **Part** for a part, **Duct run** or **Pipe run** for a run, **Branch**
  for a branch, and **Selection** when you select several things.

Every trade tab has the same sections in the same order, after Select:
**Create**, **Connect**, **Analyze**, **Design** and **Documents**. A tab
leaves out a section it has nothing for. Learn one trade tab and you can find
your way around the next.

## Views: plan, 3D and sheets

The **Views and sheets** list in the left sidebar is how you move around.
At the top are two live views of the whole model:

- **3D model**: everything, live, in 3D.
- **Top-down plan**: all levels, looking down.

Below them are your saved views, grouped as **Floor plans**,
**Ceiling plans**, **Sections**, **Elevations**, **3D views**,
**Detail views** and **Schedules**, then **Sheets**. Click one to open it.
Each saved view and sheet has a menu with **Rename…**, **Duplicate** (views)
and **Delete…**.

To make a new view, press **+** beside **Views and sheets**, or use
**Views › New view**. The choices are:

- **Floor plan for a level**
- **Ceiling plan**
- **Section (draw a cut line)**
- **Elevation (draw view plane)**
- **3D view**
- **Detail view (drawing-only)**, for lines, text and dimensions only
- **New schedule…**
- Diagrams drawn from the model, such as **One-line diagram** and
  **Riser diagram**

The **Views** tab also has **Graphics** (**Lines and colours**,
**What this view shows**, **Linked model look**) and **Crop**, which works in
3D: **Crop view**, **Crop to selection**, **Reset crop** and
**Align crop box**. On the **Model** tab, **Display** has **Fit** (`F`),
**Lift the roof off** for the 3D model, and **Orthographic** (`5`) for a
parallel 3D view.

Model tools work in plans, sections and the 3D model. On a sheet,
double-click a plan or section to edit it there.

## Levels

Parts and runs sit on a level. A blank model starts with one.

To add one, use **Model › Datum › Add level**. The **Add a level** dialog
asks for a **Name** and a **Floor (ft)** height, and lists the levels you
already have. It can also take the height from the model:

- **Pick a surface**: click a roof or floor to take its height.
- **Use the architect's levels**, when a linked model has them.

Typing the name of a level you already have moves that level, with
everything on it. You can undo adding a level.

**Show levels** draws each level in the 3D model as a faint outline with its
name and height. In the sidebar, **Show** has a **Level (3D model)** choice
to show one level or **All levels**.

## Placing parts

Press **Place part** on the **Model** tab (key `P`). The left sidebar shows
**Place a part**:

1. Search parts, or pick a category.
2. Choose the **Level** and the **Height (ft)**.
3. Click a part, then click in the view to place it.

Press the **×** (**Stop placing**) or Esc when you are done. With a part
selected, the **Part** tab has **Rotate 90°**, **Rotate −90°**, **Move**
(`M`), **Edit type** (values every part of that type shares) and
**Delete…**.

## Routing duct and pipe

Press **Route duct** (key `D`) or **Route pipe** on the **Model** tab. The
left sidebar shows the route settings:

- **System**: an existing system in this model, or a new one with a name.
  Starting on an existing run continues its system.
- Size: for duct, **Rectangular** (**Width (in)**, **Height (in)**) or
  **Round** (**Diameter (in)**); for pipe, a **Pipe type**, or **Size (in)**
  and **Material**.
- **Level** and **Height (ft)**.
- For pipe, **Slope** and which way it **Falls**: **Toward the main**,
  **Down as drawn** or **Up as drawn**.
- **Inherit from a pipe or part** takes the height, size, system and slope
  of what you click.

Click a connector, a run or a point to start, then click each point. While
you route, the **Route** tab has:

- **Rise 1 ft** (`]`) and **Drop 1 ft** (`[`).
- **Elbow type**, **Takeoff type**, and **Offset around** (`O`), which takes
  the leg over a beam, pipe or wall in the way and back down.
- **Finish here** (Enter) and **Cancel** (Esc). Cancel saves nothing.

## Sizing

Select a run and use **Resize** on its **Duct run** or **Pipe run** tab to
change its size or shape; the fittings follow, with transitions where it
meets another size. **Split** (`S`) cuts a straight run where you click, so
you can resize one stretch. Select several runs and **Resize** on the **Selection** tab gives
them all a new size in one edit.

The trade tabs size whole systems:

- **Mechanical › Analyze › Size ducts** sizes every duct run of the air
  systems you pick from the airflow it carries. You see each change first,
  and it is one undo.
- **Plumbing › Analyze › Auto-size**. Off, every pipe is checked and sizes
  are suggested; nothing changes until you accept. On, suggested sizes apply
  as you model.

## Spaces and rooms

Spaces are the rooms and zones you design for. Open them from the **Plan**
group on the **Model** tab or a trade tab: **Spaces**,
**Room from walls** (hover inside a room's walls, then click) and
**Find rooms from walls** (you accept or reject each room before anything is
saved). **Split space** draws a line wall to wall across a room to give it
sub-rooms.

The **Spaces** panel in the sidebar has **Draw space**, **Add drawing** (an
architect's PDF or picture to trace over; set its scale first),
**Make from rooms** and a **Rooms from walls** menu. Spaces are drawn on the
level of the open floor plan.

## Schedules

A schedule lists items from the model as a spreadsheet. It reads the model
live, and changes you type in it go back into the model.

- **New schedule…** (on most tabs, and in the **+** menu) asks
  **What it lists**, a **Name** and the columns, and can place it on a
  sheet.
- **Open a schedule** opens one you have.
- **Manage › Library** holds the firm's shared calculations, fields and
  schedule templates.

## Notes, tags and dimensions

The **Annotate** tab works on an open sheet, plan, section or detail view.
It has **Dimension**, **Detail line**, **Revision cloud**, **Text** (a note;
drag its grips to re-wrap), **Tag**, **Keynote**, **Callout**, **Tag all**
and **Tag styles**.

- **Tag** labels an element with its size, mark or CFM.
- **Tag all** tags every untagged duct, pipe, terminal, fixture and piece of
  equipment in the view. Undo removes them all.
- **Keynote** gives elements a key and a keynote tag. A sheet's keynote list
  (**Sheets › Live table › Keynote list**) shows the words.

## Sheets

Make a sheet with **Sheets › New sheet** or **+ › New sheet**, then drag
views onto it. The **Sheets** tab has:

- **Title block**: the sheet number, name and title block fields.
- **Arrange views**: rows or a grid inside the border.
- **Revisions**: the sheet's revision table.
- **Project info**: name, number, address, people, issue date and status,
  filled in once and printed on every sheet.
- **Print set**: the whole set to one PDF, a page per sheet, at scale.
- **Issue set**: checks the set against its last print, adds the revision
  row and issues it.
- **Export IFC**: the saved model as an IFC 4.3 file for other BIM and
  coordination software.

**Print set…** and **Issue set…** are also under **Sheets** in the sidebar.

## Branches and versions

Main is the model everyone shares. A branch is a copy you can try changes in
without touching Main. A version is a saved point you can come back to.

<!-- screenshot: the Branch: Main button and the Versions dialog -->

**Branches.** The **Branch: Main** button above the model lists the
branches. **New branch…** asks for a **Name** and what to **Start from**
(now, or a saved version). On a branch, a banner shows it at all times with
**Back to Main** and **Close branch…**. Closing a branch stops anyone
editing it; Main is not changed. **Show Main beside** compares the branch
with Main.

To bring a branch's changes into Main, use **Propose merge to Main**.
Main changes only when the approved parts land. If the model server does
not merge branches yet, the editor says so.

**Versions.** **Manage › Versions & sign-off › Versions** lists saved
versions and issued sets. Type a name (for example "Before VE") and press
**Save version**. **New branch from this version** starts a branch there.

You need **Can edit** access to start branches and save versions.

## Keys

These are the keys the tooltips name.

| Key | What it does |
| --- | --- |
| `/` | Find a tool |
| `P` | Place part |
| `D` | Route |
| `M` | Move |
| `B` | Box select |
| `S` | Split a run |
| `F` | Fit everything in view |
| `5` | Orthographic on or off (3D) |
| `]` / `[` | Rise / drop 1 ft while routing |
| `O` | Offset around, while routing |
| Enter | Finish the route here |
| Esc | Stop the tool, or deselect |
| Del | Delete the selection (asks first) |
| Ctrl+Z / Cmd+Z | Undo |
| Shift+Ctrl+Z / Shift+Cmd+Z | Redo |

Next: [Connect Claude or another assistant](connect-claude.md) to have an
assistant build and change the model by script.
