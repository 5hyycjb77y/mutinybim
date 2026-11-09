# Regional session results

Date: ____________  Facilitator: ____________  Model: site-7301 (7301 Demo Site)
Servers: Ohio = `mutinybim-example` (iad, database us-east-2) · Singapore = `mutinybim-example-sin` (sin, database ap-southeast-1)
Server commits (from `/health`): Ohio ________ · Singapore ________

## People and conditions

| | India | US |
| --- | --- | --- |
| Name | | |
| City | | |
| Network (office Wi-Fi / home Wi-Fi / mobile) | | |
| Browser and version | | |
| Laptop (work / personal; rough age) | | |
| Anything else running (call, VPN, downloads) | | |

## Measured (from `/metrics` → `sessions`, milliseconds, p50 / p95, count)

Cold = first visit (Parts A and B, labels `-1`). Warm = Part C (labels `-2`).

| Label | Who | Server | Cache | Local preview | Durable commit | Remote visibility | Join | Clock RTT | Reconnects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IN-ohio-1 | India | Ohio | cold | / (n=) | / (n=) | / (n=) | / (n=) | | |
| IN-sin-1 | India | Singapore | cold | / (n=) | / (n=) | / (n=) | / (n=) | | |
| US-ohio-1 | US | Ohio | cold | / (n=) | / (n=) | / (n=) | / (n=) | | |
| US-sin-1 | US | Singapore | cold | / (n=) | / (n=) | / (n=) | / (n=) | | |
| IN-ohio-2 | India | Ohio | warm | / (n=) | / (n=) | / (n=) | / (n=) | | |
| IN-sin-2 | India | Singapore | warm | / (n=) | / (n=) | / (n=) | / (n=) | | |
| US-ohio-2 | US | Ohio | warm | / (n=) | / (n=) | / (n=) | / (n=) | | |
| US-sin-2 | US | Singapore | warm | / (n=) | / (n=) | / (n=) | / (n=) | | |

`environment` as reported (browser string, time zone, effective network type,
page cache cold/warm) for each label:

```
(paste)
```

Server side at the same time (`/metrics` → `join.cold`, `join.warm`,
`models.site-7301-b.serverCommitMs`):

| Server | Join cold p50 / p95 | Join warm p50 / p95 | Server commit p50 / p95 |
| --- | --- | --- | --- |
| Ohio | | | |
| Singapore | | | |

## How it felt (1 = poor, 5 = excellent)

| | Followed my mouse | Saved quickly | Saw the other person quickly | Notes / exact error words |
| --- | --- | --- | --- | --- |
| India, Ohio | | | | |
| India, Singapore | | | | |
| US, Ohio | | | | |
| US, Singapore | | | | |

## Step-by-step observations

| Step | Ohio | Singapore |
| --- | --- | --- |
| 1. Time to "Live" | | |
| 2. US drag → India says "now" | | |
| 3. India drag → US says "now" | | |
| 4. SD-2 400 CFM: Saving → Saved | | |
| 5. Both drag different branches: both kept? | | |
| 6. Five quick drags: followed the mouse? | | |
| Any "Reconnecting" / "Not saved yet" (time, how long) | | |

## Reading it

- The earlier **9 ms** was Singapore-local and server-side (client and server
  both in Singapore). It is not comparable to anything on this sheet.
- Decision (region **and** its database): ____________________________
- Why: ______________________________________________________________
