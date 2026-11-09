import {
  headlineKindValue,
  buildSheetScene,
  demoSheetDefinition,
  executeCommand,
  planWidth,
  sceneToSvg,
  slideLimit,
  sub,
  unit,
  type BimElement,
  type ModelState,
  type ReferencePlan,
  type SheetDefinition,
  type Vec2,
  elementValues, elementsOfKind,
} from "@permitzip/bim-kernel";
import type { ConnectionStatus, Presence, SyncClient, SyncClientEvents } from "@permitzip/bim-sync";

/** What a backend-specific page provides; the viewer itself is identical for every candidate. */
export interface ViewerHost {
  readonly name: string;
  /** Shown in the header so hands-on testers always know which backend they are on. */
  readonly backendLabel: string;
  createClient(events: SyncClientEvents): Promise<{ client: SyncClient; connect: () => Promise<void> }>;
  /** Preview export of the current head (vector PDF). */
  readonly exportPdfUrl: string;
  /** Issue from a pinned snapshot; resolves with where the immutable PDF lives. */
  issue?(): Promise<{ pdfUrl: string; revision: number }>;
  /** Drill: lose the next commit notification. Omit where the backend has no such fault. */
  dropNextNotification?(): Promise<void>;
  /** Extra header controls supplied by the hosting page (e.g. the simulated-distance switch). */
  readonly headerExtras?: readonly HTMLElement[];
  /** Linked, read-only references drawn under the plan (never editable or snapped to). */
  readonly references?: readonly ReferencePlan[];
  /** The live sheet; defaults to the demo sheet. */
  readonly sheet?: SheetDefinition;
  readonly planTitle?: string;
}

const DEMO_SHEET = demoSheetDefinition();
const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Mount the shared editor + live sheet for one participant on one backend. */
export async function startViewer(host: ViewerHost): Promise<void> {
  const SHEET = host.sheet ?? DEMO_SHEET;
  // ---------- Layout ----------
  const app = document.getElementById("app");
  if (!app) throw new Error("#app missing");
  const header = el("header", { class: "bar" });
  const brand = el("div", { class: "brand" });
  brand.append(el("img", { src: "/brand/mutinybim-mark-48.png", alt: "", width: "22", height: "22" }), document.createTextNode("MutinyBIM"));
  const statusPill = el("span", { class: "pill pill-connecting", role: "status", "aria-live": "polite" }, "Connecting…");
  const revLabel = el("span", { class: "muted" }, "");
  // "Saved" is shown only after the server confirms the edit is in its database.
  const saveLabel = el("span", { class: "save save-idle", role: "status", "aria-live": "polite" }, "All changes saved");
  const peopleList = el("div", { class: "people", "aria-label": "People in this model" });
  header.append(brand, el("span", { class: "backend" }, host.backendLabel), el("span", { class: "who" }, `You: ${host.name}`), statusPill, saveLabel, revLabel, ...(host.headerExtras ?? []), peopleList);

  const main = el("main", { class: "panes" });
  const editorPane = el("section", { class: "pane", "aria-label": "Plan editor" });
  const editorHead = el("div", { class: "pane-head" });
  editorHead.append(el("h2", {}, host.planTitle ?? "Level 1 plan — supply"), el("span", { class: "hint" }, "Drag a round handle to slide a branch along the trunk. Esc cancels."));
  const editorSvg = svgEl("svg", { class: "editor", role: "img", "aria-label": "Duct plan" });
  const constraintNote = el("div", { class: "constraint", role: "status", "aria-live": "polite" });
  editorPane.append(editorHead, editorSvg, constraintNote);

  const sheetPane = el("section", { class: "pane", "aria-label": "Sheet M-101" });
  const sheetHead = el("div", { class: "pane-head" });
  const sheetLabel = el("span", { class: "sheet-rev" }, "");
  const exportLink = el("a", { class: "button secondary", href: host.exportPdfUrl, target: "_blank", rel: "noopener" }, "Export PDF");
  const issueBtn = el("button", { type: "button", class: "button" }, "Issue M-101");
  const sheetActions = el("div", { class: "actions" });
  sheetActions.append(exportLink);
  if (host.issue) sheetActions.append(issueBtn);
  sheetHead.append(el("h2", {}, "Sheet M-101"), sheetLabel, sheetActions);
  const sheetBox = el("div", { class: "sheet" });
  sheetPane.append(sheetHead, sheetBox);

  const side = el("aside", { class: "side" });
  const airflow = el("div", { class: "card" });
  const drills = el("details", { class: "card" });
  drills.append(el("summary", {}, "Feasibility drills"));
  const dropBtn = el("button", { type: "button" }, "Lose the next broadcast");
  drills.append(el("p", { class: "muted" }, "Simulates a dropped update; every browser must still catch up within one heartbeat (10 s)."), dropBtn);
  if (!host.dropNextNotification) {
    dropBtn.disabled = true;
    dropBtn.title = "This backend has no skip-delivery fault; disconnect a browser instead";
  }
  const log = el("ol", { class: "log", "aria-label": "Activity" });
  side.append(airflow, drills, el("h3", {}, "Activity"), log);
  main.append(editorPane, sheetPane, side);
  app.append(header, main);

  function note(text: string, kind: "info" | "ok" | "warn" | "error" = "info") {
    const item = el("li", { class: `log-${kind}` }, `${new Date().toLocaleTimeString()}  ${text}`);
    log.prepend(item);
    while (log.childElementCount > 40) log.lastElementChild?.remove();
  }

  // ---------- Sync ----------
  const remote = new Map<string, Presence>();

  const { client, connect } = await host.createClient({
    onView: () => scheduleRender(),
    onStatus: (s) => setStatus(s),
    onOutcome: (_req, outcome) => {
      if (outcome.status === "committed") {
        note(outcome.rebased ? `Saved as Rev ${outcome.revision} (updated on latest)` : `Saved as Rev ${outcome.revision}`, "ok");
      } else if (outcome.error.code === "stale_base") {
        // The model was reset under us; the client reloads and onModelReset explains it.
        return;
      } else if (outcome.error.code === "conflict") {
        note(`Not saved: ${outcome.error.message}. Your change was rolled back; the model shows their version.`, "warn");
      } else {
        note(`Not saved: ${outcome.error.message}`, "error");
      }
    },
    onPresence: (id, presence) => {
      if (presence) remote.set(id, presence);
      else remote.delete(id);
      scheduleRender();
    },
    onRemoteChange: (revision, who) => note(`${who.name} saved Rev ${revision}`),
    onDenied: (reason) => note(reason, "error"),
    onSaveState: ({ pending, retrying, message }) => {
      if (retrying > 0) {
        saveLabel.textContent = `Not saved yet (${retrying}) — retrying`;
        saveLabel.title = message ?? "";
        saveLabel.className = "save save-retrying";
        if (message) note(message, "warn");
      } else if (pending > 0) {
        saveLabel.textContent = pending === 1 ? "Saving 1 change…" : `Saving ${pending} changes…`;
        saveLabel.title = "";
        saveLabel.className = "save save-pending";
      } else {
        saveLabel.textContent = "All changes saved";
        saveLabel.title = "Every edit you made is stored in the database";
        saveLabel.className = "save save-idle";
      }
    },
    onModelReset: ({ fromRevision, toRevision, droppedEdits }) => {
      const lost = droppedEdits > 0 ? ` Your last ${droppedEdits === 1 ? "edit was" : `${droppedEdits} edits were`} not saved.` : "";
      note(`The model was reset (for example by a test run): it went from Rev ${fromRevision} back to Rev ${toRevision}. You're now on Rev ${toRevision}.${lost} You can keep editing.`, "warn");
    },
  });

  const STATUS_TEXT: Record<ConnectionStatus, string> = {
    connecting: "Connecting…",
    live: "Live",
    catching_up: "Catching up…",
    offline: "Offline — reconnecting; your unsaved edits will be sent when back",
    denied: "No access — you are not a member of this project",
    degraded: "Connected, but the server can't reach the database — edits wait and retry",
  };
  function setStatus(s: ConnectionStatus) {
    statusPill.textContent = STATUS_TEXT[s];
    statusPill.className = `pill pill-${s}`;
  }

  dropBtn.addEventListener("click", () => {
    if (!host.dropNextNotification) return;
    host
      .dropNextNotification()
      .then(() => note("Next update will be lost (drill)", "warn"))
      .catch((err) => {
        console.error("[mutinybim] drill request failed", err);
        note("Could not arm the drill: server unreachable", "error");
      });
  });

  issueBtn.addEventListener("click", () => {
    if (!host.issue) return;
    issueBtn.disabled = true;
    issueBtn.textContent = "Issuing…";
    host
      .issue()
      .then(({ pdfUrl, revision }) => {
        const link = el("a", { href: pdfUrl, target: "_blank", rel: "noopener" }, `Issued M-101 at Rev ${revision} (open PDF)`);
        const item = el("li", { class: "log-ok" });
        item.append(document.createTextNode(`${new Date().toLocaleTimeString()}  `), link);
        log.prepend(item);
      })
      .catch((err) => {
        console.error("[mutinybim] issue failed", err);
        note(`Could not issue: ${err instanceof Error ? err.message : "server error"}`, "error");
      })
      .finally(() => {
        issueBtn.disabled = false;
        issueBtn.textContent = "Issue M-101";
      });
  });

  // ---------- Editor ----------
  interface Drag {
    tapId: string;
    startS: number;
    hostStart: Vec2;
    axis: Vec2;
    requested: number;
    accepted: number;
    binding: string | null;
  }
  let drag: Drag | null = null;
  let lastPresence = 0;

  function bounds(model: ModelState) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const take = (p: Vec2) => {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    };
    for (const e of elementValues(model.elements)) {
      if (e.kind === "duct_segment") { take(e.start); take(e.end); }
      else if (e.kind === "equipment") { take({ x: e.position.x - e.size.x / 2, y: e.position.y - e.size.y / 2 }); take({ x: e.position.x + e.size.x / 2, y: e.position.y + e.size.y / 2 }); }
      else if ("position" in e) take(e.position);
    }
    // Linked references: show the surrounding building for context, not just the new system.
    const pad = host.references?.length ? 4500 : 1200;
    return { x: minX - pad, y: -(maxY + pad), w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
  }

  const v = (p: Vec2) => ({ x: p.x, y: -p.y });

  // Built once: references never change during a session, and redrawing tens of
  // thousands of segments on every edit would cost more than the edit itself.
  const referenceLayer = svgEl("g", { class: "references", "aria-hidden": "true" });
  for (const plan of host.references ?? []) {
    for (const layer of plan.layers) {
      const s = layer.segments;
      const parts: string[] = [];
      for (let i = 0; i + 3 < s.length; i += 4) {
        parts.push(`M${s[i] ?? 0} ${-(s[i + 1] ?? 0)}L${s[i + 2] ?? 0} ${-(s[i + 3] ?? 0)}`);
      }
      referenceLayer.append(svgEl("path", { d: parts.join(""), class: `ref ref-${layer.discipline}` }));
    }
  }

  function drawModel(group: SVGElement, model: ModelState, cls: string) {
    for (const e of elementValues(model.elements)) drawElement(group, e, cls);
  }

  function drawElement(group: SVGElement, e: BimElement, cls: string) {
    if (e.kind === "duct_segment") {
      const a = v(e.start), b = v(e.end);
      const w = planWidth(e.profile);
      const dir = unit(sub(b, a));
      const n = { x: -dir.y * (w / 2), y: dir.x * (w / 2) };
      const pts = [
        [a.x + n.x, a.y + n.y], [b.x + n.x, b.y + n.y], [b.x - n.x, b.y - n.y], [a.x - n.x, a.y - n.y],
      ].map((p) => p.join(",")).join(" ");
      group.append(svgEl("polygon", { points: pts, class: `duct ${cls}` }));
    } else if (e.kind === "elbow") {
      const p = v(e.position), w = planWidth(e.profile);
      group.append(svgEl("rect", { x: p.x - w / 2, y: p.y - w / 2, width: w, height: w, class: `duct ${cls}` }));
    } else if (e.kind === "terminal") {
      const p = v(e.position), h = 305;
      group.append(svgEl("rect", { x: p.x - h, y: p.y - h, width: 2 * h, height: 2 * h, class: `terminal ${cls}` }));
      if (!cls) {
        const t = svgEl("text", { x: p.x + h + 120, y: p.y - 60, class: "label" });
        t.textContent = `${e.mark} · ${Math.round(headlineKindValue(e)?.value ?? 0)} CFM`;
        group.append(t);
      }
    } else if (e.kind === "equipment") {
      const p = v(e.position);
      group.append(svgEl("rect", { x: p.x - e.size.x / 2, y: p.y - e.size.y / 2, width: e.size.x, height: e.size.y, class: `equipment ${cls}` }));
      if (!cls) {
        const t = svgEl("text", { x: p.x, y: p.y + 100, class: "label center" });
        t.textContent = `${e.mark} · ${Math.round(headlineKindValue(e)?.value ?? 0)} CFM`;
        group.append(t);
      }
    }
  }

  function renderEditor(view: ModelState) {
    const b = bounds(view);
    editorSvg.setAttribute("viewBox", `${b.x} ${b.y} ${b.w} ${b.h}`);
    editorSvg.replaceChildren(referenceLayer);
    const base = svgEl("g", {});
    drawModel(base, view, "");
    editorSvg.append(base);

    // Other people's drags: ephemeral, shown faint with their name.
    for (const p of remote.values()) {
      if (p.activity.kind !== "dragging_tap") continue;
      const res = executeCommand(view, { type: "slide_branch", tapId: p.activity.tapId, s: p.activity.s });
      if (!res.ok) continue;
      const g = svgEl("g", { class: "ghost-remote" });
      drawModel(g, res.model, "ghost");
      const tap = res.model.elements[p.activity.tapId];
      if (tap && tap.kind === "tap") {
        const pos = v(tap.position);
        const t = svgEl("text", { x: pos.x + 200, y: pos.y - 500, class: "label remote" });
        t.textContent = `${p.actor.name} is moving this branch`;
        g.append(t);
      }
      editorSvg.append(g);
    }

    // My drag preview.
    if (drag) {
      const res = executeCommand(view, { type: "slide_branch", tapId: drag.tapId, s: drag.accepted });
      if (res.ok) {
        const g = svgEl("g", { class: "ghost-mine" });
        drawModel(g, res.model, "ghost");
        editorSvg.append(g);
      }
    }

    // Tap handles.
    for (const e of elementsOfKind(view.elements, "tap")) {
      const pos = v(e.position);
      const handle = svgEl("circle", { cx: pos.x, cy: pos.y, r: 260, class: "handle", tabindex: 0, role: "button", "aria-label": `Slide branch ${e.id}`, "data-tap-id": e.id });
      editorSvg.append(handle);
    }
  }

  // Delegated: handles are re-rendered on every update (including other people's
  // presence), so listen on the stable <svg> and resolve the tap at pointer-down.
  editorSvg.addEventListener("pointerdown", (ev) => {
    if (!(ev instanceof PointerEvent) || !(ev.target instanceof Element)) return;
    const tapId = ev.target.closest("[data-tap-id]")?.getAttribute("data-tap-id");
    if (tapId) startDrag(ev, tapId);
  });

  function toModel(ev: PointerEvent): Vec2 | null {
    const svg = editorSvg;
    if (!(svg instanceof SVGSVGElement)) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: -pt.y };
  }

  function startDrag(ev: PointerEvent, tapId: string) {
    const view = client.view();
    const tap = view?.elements[tapId];
    if (!view || !tap || tap.kind !== "tap") return;
    const hostSeg = view.elements[tap.hostId];
    if (!hostSeg || hostSeg.kind !== "duct_segment") return;
    ev.preventDefault();
    drag = { tapId, startS: tap.s, hostStart: hostSeg.start, axis: unit(sub(hostSeg.end, hostSeg.start)), requested: tap.s, accepted: tap.s, binding: null };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function onMove(ev: PointerEvent) {
    const view = client.view();
    const p = toModel(ev);
    if (!drag || !view || !p) return;
    const rel = sub(p, drag.hostStart);
    drag.requested = Math.round(rel.x * drag.axis.x + rel.y * drag.axis.y);
    const limit = slideLimit(view, drag.tapId, drag.requested);
    drag.accepted = limit.accepted;
    drag.binding = limit.binding ? limit.binding.message : null;
    constraintNote.textContent = drag.binding ? `Stops here: ${drag.binding}` : "";
    const now = performance.now();
    if (now - lastPresence > 100) {
      lastPresence = now;
      client.publishPresence({ kind: "dragging_tap", tapId: drag.tapId, s: drag.accepted, limited: drag.binding !== null, binding: drag.binding });
    }
    scheduleRender();
  }

  function endDrag() {
    window.removeEventListener("pointermove", onMove);
    drag = null;
    constraintNote.textContent = "";
    client.publishPresence({ kind: "idle" });
    scheduleRender();
  }

  function onUp(ev: PointerEvent) {
    if (!drag) return;
    onMove(ev); // the release position is the final position
    if (!drag) return;
    const { tapId, accepted, requested, binding, startS } = drag;
    endDrag();
    if (Math.abs(accepted - startS) < 0.5) {
      if (binding) note(`Not moved: ${binding}`, "warn");
      return; // nothing changed; no revision
    }
    const res = client.submit({ type: "slide_branch", tapId, s: accepted });
    if (!res.ok) note(`Not moved: ${res.error.message}`, "error");
    else if (binding && Math.abs(requested - accepted) > 1) note(`Branch stopped short of where you dragged: ${binding}`, "warn");
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drag) {
      endDrag();
      note("Move cancelled");
    }
  });

  // ---------- Airflow panel ----------
  const airflowTotal = el("p", { class: "total" });
  const airflowRows = new Map<string, HTMLInputElement>();
  airflow.append(el("h3", {}, "Airflow"), airflowTotal);

  /** Updates in place so a remote change never wipes what someone is typing. */
  function renderAirflow(view: ModelState) {
    const ahu = elementsOfKind(view.elements, "equipment")[0];
    airflowTotal.textContent = ahu && ahu.kind === "equipment" ? `${ahu.mark} total: ${Math.round(headlineKindValue(ahu)?.value ?? 0)} CFM` : "";
    for (const e of elementsOfKind(view.elements, "terminal")) {
      const existing = airflowRows.get(e.id);
      if (existing) {
        if (document.activeElement !== existing) existing.value = String(headlineKindValue(e)?.value ?? 0);
        continue;
      }
      const row = el("form", { class: "cfm-row" });
      const label = el("label", { for: `cfm-${e.id}` }, e.mark);
      const input = el("input", { id: `cfm-${e.id}`, type: "number", min: "0", max: "5000", step: "5", value: String(headlineKindValue(e)?.value ?? 0), "aria-label": `${e.mark} airflow (CFM)` });
      const btn = el("button", { type: "submit" }, "Set");
      row.append(label, input, el("span", { class: "muted" }, "CFM"), btn);
      row.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const cfm = Number(input.value);
        if (!Number.isFinite(cfm)) return note("Enter a number of CFM", "error");
        const res = client.submit({ type: "set_terminal_cfm", terminalId: e.id, cfm });
        if (!res.ok) note(`Not changed: ${res.error.message}`, "error");
        input.blur();
      });
      airflowRows.set(e.id, input);
      airflow.append(row);
    }
  }

  // ---------- Sheet (its own display revision, never mixed) ----------
  let sheetRevision = -1;
  let sheetBusy = false;
  function renderSheet() {
    const confirmed = client.confirmedModel();
    if (!confirmed) return;
    const head = confirmed.revision;
    sheetLabel.textContent = sheetRevision === head ? `Showing Rev ${sheetRevision}` : `Showing Rev ${sheetRevision} · model is at Rev ${head} · updating`;
    if (sheetRevision === head || sheetBusy) return;
    sheetBusy = true;
    const snapshot = confirmed; // one coherent revision for every sheet element
    setTimeout(() => {
      sheetBox.innerHTML = sceneToSvg(buildSheetScene(snapshot, SHEET));
      sheetRevision = snapshot.revision;
      sheetBusy = false;
      renderSheet(); // jump straight to the newest revision if more arrived meanwhile
    }, 0);
  }

  // ---------- Render loop ----------
  let frame = 0;
  function scheduleRender() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const view = client.view();
      if (!view) return;
      renderEditor(view);
      renderAirflow(view);
      renderSheet();
      revLabel.textContent = `Model Rev ${client.confirmedRevision()}${client.pendingCount() ? ` · ${client.pendingCount()} saving…` : ""}`;
      peopleList.replaceChildren(...[...remote.values()].map((p) => el("span", { class: `person ${p.actor.kind}` }, p.actor.kind === "agent" ? `${p.actor.name} (agent)` : p.actor.name)));
    });
  }

  connect().catch((err) => {
    console.error("[mutinybim] could not connect", err);
    note(`Could not connect: ${err instanceof Error ? err.message : "unknown error"}`, "error");
  });
}
