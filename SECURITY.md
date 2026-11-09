# Security policy

## Report a vulnerability privately

Please do **not** open a public issue, discussion or pull request for a
security problem.

Report it through GitHub's private vulnerability reporting:

1. Go to this repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do.

Only the maintainers can see the report. We will acknowledge it, keep you
updated, and credit you in the advisory if you want.

Please give us a reasonable time to fix the problem before you disclose it
anywhere else. Do not access, change or delete data that is not yours while
you test.

## Supported versions

MutinyBIM has no tagged releases yet. We fix security problems on `main`
only. Once releases start, this section will list which ones get fixes.

| Version | Supported |
| --- | --- |
| `main` | Yes |

## In scope

- The packages in this repository (`packages/bim-*`).
- The model server (`services/bim-authority`): sign-in and authorization,
  leases, commits, the WebSocket protocol and its messages.
- The scripting kit and runner contract: anything that lets a script reach the
  network, the file system, the host process or another model.
- The add-on and library package formats: signature checks, content hashes,
  and the trust rules for data and code add-ons.
- Anything that lets an agent act with more access than the person it acts
  for.

## Out of scope

- The dev server (`packages/bim-devserver`). It is a local demo with no
  sign-in and is not meant to be exposed to a network. Problems that need it
  to be public are not vulnerabilities.
- Applications that host MutinyBIM, and their deployments. Report those to
  their owners.
- Vulnerabilities in third-party dependencies with no MutinyBIM-specific
  impact. Report those upstream. We still want to hear about a dependency we
  should update.
- Denial of service that needs unrealistic load, and findings from automated
  scanners with no working proof.

## Secrets

This repository holds no secrets, and CI uses none. If you find something that
looks like a real key or password in the code or history, report it privately
as above.
