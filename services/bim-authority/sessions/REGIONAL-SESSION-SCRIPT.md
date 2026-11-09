# Regional session: how editing feels from India and from the US

**For:** one engineer in India and one person in the US, on a call together.
**Time:** about 15 minutes. **You need:** a laptop with Chrome or Edge, your
normal internet, and the two links the facilitator sends you.

We are deciding where the editing server should live. Today there is one in
**Ohio, USA** and one in **Singapore**. You will make the same few edits on
each. The page measures the timings itself; you only follow the steps and tell
us how it felt.

## Before you start (2 minutes)

1. Close other video calls and big downloads if you can (keep this call).
2. Write down, in the results sheet:
   - the city you are in,
   - your network: office Wi-Fi, home Wi-Fi, or mobile hotspot,
   - your browser (Chrome / Edge / other) and whether it is a work or personal laptop.
3. Open link **1 (Ohio)** in a new window. Sign in when asked.

## Part A: Ohio (5 minutes)

Do these in order. Say "done" on the call after each step.

1. **Wait for the green "Live" badge** at the top right and the other
   person's name. Say how long it took: "instant", "a second or two", or "longer".
2. **US person:** drag branch 1 along the main duct and let go.
   **India:** say "now" the moment you see it move on your screen.
3. **India:** drag branch 1 back a little and let go.
   **US:** say "now" when you see it move.
4. **India:** click supply diffuser SD-2 and set it to 400 CFM.
   Watch the save message: note whether it showed **"Saving…"** and how fast it turned into **"Saved"**.
5. **Both, at the same time:** each drag a different branch. Both moves should stay.
6. **India:** do five quick small drags of any branch, one after another.
   Does the duct follow your mouse right away while you drag, or does it lag?
7. **Rate Ohio** in the sheet (1 = poor, 5 = excellent):
   - "When I dragged, it followed my mouse immediately"
   - "My change said Saved quickly"
   - "I saw the other person's change quickly"

**Leave the page open for 30 more seconds after the last step**, then close it.
(The page sends its timings every 30 seconds and again when it closes.)

## Part B: Singapore (5 minutes)

Open link **2 (Singapore)**. Repeat steps 1–7 exactly as in Part A, and rate
Singapore. Then leave it open 30 seconds and close it.

## Part C: one more time, warm (3 minutes)

Open link **1 (Ohio)** again and do only steps 1, 4 and 6, then link **2
(Singapore)** and do steps 1, 4 and 6. This second visit is "warm": the page is
already in your browser's cache. Leave each open 30 seconds before closing.

## If something goes wrong

- **"Reconnecting…" or "Not saved yet"** for more than a few seconds: say so
  on the call and write down the time. Don't reload unless the facilitator asks; the page
  recovers by itself and we want to see that.
- **"You don't have access to this model"**: tell the facilitator; they will fix access.
- **A plain error message**: copy the exact words into the notes column.

That's it. Thank you.

---

## For the facilitator

**Links.** One label per person per run, so each report can be matched:

- India, Ohio: `https://mutinybim-example-web.fly.dev/?backend=B&model=site-7301&name=Priya&bimSession=IN-ohio-1`
- India, Singapore: `https://mutinybim-example-web.fly.dev/?backend=B-sin&model=site-7301&name=Priya&bimSession=IN-sin-1`
- US, Ohio: `…?backend=B&model=site-7301&name=Avery&bimSession=US-ohio-1`
- US, Singapore: `…?backend=B-sin&model=site-7301&name=Avery&bimSession=US-sin-1`

Use `-2` on the Part C (warm) links. Testers also need the page login.

**Before the session.** The hands-on page must be rebuilt with this branch's
`packages/` so its client reports timings (the meter turns on when the address
has `bimSession=`). Pull the private 7301 layers first so the backdrop stays:

```bash
# 1. Pull the private 7301 fixture (signed links from the bim_fixture_download_urls MCP tool first).
cd <repo> && npm run fixtures:pull -- 7301

# 2. Build the plan layers (feasibility branch, experiments/mutinybim-backends/deploy/README.md "7301 session").
cd <feasibility-branch checkout>/experiments/mutinybim-backends && \
  npx tsx --tsconfig tsconfig.json src/references/build-references.ts \
    --manifest <repo>/fixtures/mutinybim/7301.json \
    --cache <repo>/.fixtures-cache

# 3. Deploy the page from a tree with this branch's packages and the feasibility experiments.
rm -rf /tmp/mutinybim-web-src && mkdir -p /tmp/mutinybim-web-src/packages && \
  cp -R <repo>/packages/{bim-kernel,bim-sync,bim-sheets,bim-viewer} /tmp/mutinybim-web-src/packages/ && \
  cp -R <feasibility-branch checkout>/experiments /tmp/mutinybim-web-src/experiments
cd <feasibility-branch checkout>/experiments/mutinybim-backends && \
  MUTINYBIM_DEPLOY_SOURCE=/tmp/mutinybim-web-src \
  MUTINYBIM_DEPLOY_REFERENCE_DIR=<repo>/.fixtures-cache/7301/<export>/derived \
  deploy/deploy-node-app.sh web
```

Reset `site-7301` on both servers to a clean revision if earlier tests left
edits you don't want people to see (deploy/README.md "7301 session").

**After the session.** Pull the numbers from each server (no login needed;
no personal data beyond browser and time zone):

```bash
curl -s https://mutinybim-example.fly.dev/metrics     | jq '.sessions'
curl -s https://mutinybim-example-sin.fly.dev/metrics | jq '.sessions'
```

Each entry has `label`, `localPreview`, `commit`, `remoteVisibility`, `join`
(each `count / p50 / p95` in ms), `clockRttMs`, `reconnects` and
`environment` (browser, time zone, network type, page cold/warm). The same
lines are in `fly logs` as `[bim-authority][session-report]` if a server
restarted. Copy them into [RESULTS-TEMPLATE.md](RESULTS-TEMPLATE.md).

**What the numbers mean.**

- **Local preview:** submit → next painted frame on that laptop. It should not
  depend on the server at all. If it does, that's a client problem, not a region problem.
- **Durable commit:** edit sent → "Saved" (the edit is in Postgres). This is
  where distance to the server and its database shows.
- **Remote visibility:** the server committed someone else's edit → this
  browser received it (server clock, corrected by the best heartbeat round
  trip; error at most half of `clockRttMs`).
- **The old "9 ms".** That figure was measured on the Singapore server with the
  test client also in Singapore (a Fly machine in `sin`), and it is server-side
  time. It contains no India-to-Singapore network hop, so it is a
  Singapore-local, server-side number and not what an engineer in India feels.
  Do not compare it with these sessions.

**Choosing.** Pick the region and its database together (each server here has
its own database next to it). Ohio is not the default: compare the India
engineer's durable-commit p95 on both, and what the US person loses on Singapore.
