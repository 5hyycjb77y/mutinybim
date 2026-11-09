# Governance

MutinyBIM is maintained by PermitZIP with its contributors. This page says who
decides what, and how that changes.

## Roles

**Contributors.** Anyone who opens an issue, reviews a pull request, writes
docs or sends code. Every commit carries a DCO sign-off.

**Maintainers.** The core team. Maintainers:

- review and merge pull requests;
- approve every change to the shared kernel (`packages/bim-kernel`), the sync
  layer (`packages/bim-sync`), the model server (`services/bim-authority`), CI
  workflows and lint configuration;
- keep the add-on contract stable and versioned;
- triage issues and security reports;
- close, lock or remove issues, discussions and pull requests at their discretion.

At launch the maintainers are PermitZIP's MutinyBIM team. The current list is
in [`.github/CODEOWNERS`](.github/CODEOWNERS).

**Discipline leads.** Licensed or experienced professionals who co-own an
add-on with the maintainers, for example a structural lead for
`packages/bim-pack-structural`. Leads will be named from the founding
contributors and listed in CODEOWNERS. A discipline lead:

- approves changes to their add-on, together with a maintainer for anything
  that touches the shared contract;
- reviews pull requests labelled `needs licensed review` in their discipline,
  or names a licensed reviewer who will;
- helps decide what their trade needs from the shared kernel.

## How decisions are made

- **In public.** Decisions are made in GitHub issues and pull requests, so
  anyone can read the reasoning later.
- **By consensus first.** Most changes are settled in review. Reviewers
  explain objections and suggest a way forward.
- **When consensus fails,** the maintainers decide. For an add-on, the
  maintainers decide together with that add-on's discipline lead.
- **Kernel-first.** A change that adds trade logic to the kernel, or works
  around a kernel gap in an add-on, is sent back. The fix is to generalize the
  kernel (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- **Breaking changes** to the add-on contract, the stored model format or the
  sync protocol need a written proposal in an issue and maintainer approval
  before code.

## Becoming a maintainer or discipline lead

There is no fixed quota. We look for people who have, over several months:

- landed good pull requests and reviewed others' work with care;
- followed the bedrock rule and the boundary rules;
- helped other contributors;
- for a discipline lead, shown professional judgment in that trade.

Any maintainer may nominate someone in a private maintainer discussion. The
existing maintainers decide. New maintainers and leads are added to
CODEOWNERS in a pull request.

Maintainers who step away move to emeritus status. They can return by asking.

## Changes to this document

Changes to governance are made by pull request and approved by the
maintainers.
