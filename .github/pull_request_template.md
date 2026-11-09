## What this changes

<!-- What a person using MutinyBIM will notice, in a few plain sentences. Link the issue: "Closes #123". -->

## How it works

<!-- The approach, for reviewers. Name the packages it touches. -->

## Kernel-first check

<!-- Which shared kernel concept does this build on (element, type, parameter, space, network, service, schedule, calc, lint rule, add-on point…)?
     If the kernel could not express it, say how this pull request generalises the kernel. -->

## Performance

<!-- The hot path this touches, if any, and its budget at 250k and 1M elements. Before and after numbers when it matters. "None" is a fine answer. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`), per the DCO.
- [ ] Tests added or updated, and they fail without this change.
- [ ] `npm run typecheck`, `npm test` and `npm run lint` pass locally.
- [ ] Built on the shared kernel: trade logic is in an add-on, not in the kernel, and no kernel gap is worked around.
- [ ] Quantities carry units from `@permitzip/bim-units`; no bare numbers cross a package boundary.
- [ ] No ratchet went up (trade words in the kernel, import cycles, layer violations). Baselines lowered if they went down.
- [ ] No performance budget was raised.
- [ ] No client, project, building or personal data, and no secrets.
- [ ] No new dependency on closed-source or copyleft code; any new third-party notice is in `NOTICE`.
- [ ] Messages and labels are in plain words that tell a person what to do next.
- [ ] If this adds or changes an engineering calculation, code rule or design default: labelled `needs licensed review`, the method or clause is cited, and a worked example is in the tests.
