// Keeps the Approvals count, the tab title and the waiting notices current without a reload.
const nav = document.querySelector("[data-approvals-nav]");
const count = document.querySelector("[data-approvals-count]");
const notices = document.querySelector("[data-approvals-shown]");
const fresh = document.querySelector("[data-approvals-new]");
const problem = document.querySelector("[data-approvals-problem]");
const shown = new Set((notices?.getAttribute("data-approvals-shown") ?? "").split(",").filter(Boolean));
const title = document.title.replace(/^\(\d+\) /, "");
const EVERY_MS = 8000;
let failures = 0;
let timer = 0;

function show(ids) {
  if (count) {
    count.textContent = String(ids.length);
    count.hidden = ids.length === 0;
  }
  if (nav) nav.setAttribute("aria-label", ids.length > 0 ? `Approvals, ${ids.length} waiting for you` : "Approvals");
  document.title = `${ids.length > 0 ? `(${ids.length}) ` : ""}${title}`;
  for (const notice of document.querySelectorAll("[data-approval-notice]")) notice.hidden = !ids.includes(notice.getAttribute("data-approval-notice"));
  const more = document.querySelector("[data-approval-more]");
  if (more) more.hidden = ids.length <= document.querySelectorAll("[data-approval-notice]").length;
  if (fresh) fresh.hidden = !ids.some((id) => !shown.has(id));
}

function failed(why) {
  failures += 1;
  console.error("[mutinybim-web] checking for approval requests failed", why);
  if (problem && failures >= 3) problem.hidden = false;
}

async function check() {
  if (document.visibilityState !== "visible") return;
  try {
    const response = await fetch("/api/hosted/approvals/waiting", { credentials: "same-origin", headers: { accept: "application/json" } });
    if (response.status === 401) {
      // Signed out in another tab: the next click asks to log in again.
      window.clearInterval(timer);
      return;
    }
    if (!response.ok) return failed({ status: response.status });
    const body = await response.json();
    const ids = Array.isArray(body?.waiting) ? body.waiting.map((w) => String(w.id)) : null;
    if (!ids) return failed({ body });
    failures = 0;
    if (problem) problem.hidden = true;
    show(ids);
  } catch (err) {
    failed(err);
  }
}

if (nav) {
  timer = window.setInterval(check, EVERY_MS);
  document.addEventListener("visibilitychange", check);
}
