# apps/mobile — placeholder

Nothing is built here yet. This directory exists to record a decision made
before Month 3 starts.

## Why `apps/mobile` and not `packages/app`

`packages/*` is the glob for the four libraries published to npm. An Expo app
is not published to npm, and putting it there means every `npm publish -w` loop
and every version check has to special-case it.

It also fights Metro: this repo hoists dependencies to the root
`node_modules`, and Metro resolves modules differently from Node, which is the
usual cause of "unable to resolve module" in an Expo monorepo. Keeping the app
outside the published glob makes the Metro config explicit rather than
accidental.

When the app is built it will join the workspaces list as `apps/*`, so it can
import protocol types from `@vigylx/daemon` — `ServerEvent`, `ClientMessage`
and `AuthorizedDevice` are already exported, and a second copy of them in the
app is how the two ends drift apart.

## Read before writing any of it

[`docs/MOBILE-ARCHITECTURE.md`](../../docs/MOBILE-ARCHITECTURE.md) — four places
the Month 3 build guide is wrong, including that its WebSocket client signs
requests with the device id and would be refused by the daemon on every
connection, and that the Digital Twin screen subscribes to an event the daemon
does not send.
