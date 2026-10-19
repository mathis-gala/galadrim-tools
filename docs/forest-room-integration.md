# Forest room integration foundation

Tools remains the reservation authority. Shared room-lock transactions, additive
integration state and a separately guarded delegated API support the Forest preview.
Apply the reviewed additive migration before deploying code that uses the new columns.
Startup never applies it automatically. No production migration is performed here.

All known application writers (ordinary REST, MCP and phone-box sensor commands) pass
through the reservation service. Commands lock room IDs in ascending order, then read
and mutate the current booking inside the same transaction. A moved lock set is retried
at most once. Existing socket messages are emitted by callers only after the service
returns from COMMIT.

`integration_version` increments for updates, including legacy sensor extensions.
`allocation_at` changes on creation or room/start reallocation and is preserved by
end/title-only changes. Existing rows receive a conservative migration-time anchor.
The additive receipt and release-audit tables do not enable the integration by themselves.
Audit identities have no cascading booking/user/room foreign keys. Destructive rollback
is refused so that future release snapshots cannot be removed accidentally.

## Isolated real MySQL verification

```sh
node apps/backend/scripts/run_room_tests.mjs --target rooms-test
```

The launcher fixes the Compose project `tools-forest-rooms-test`, verifies its volume
ownership and uses no ambient Compose environment file. The runner also asserts the
MySQL host, database, account and seeded project marker before migration or tests.
Only the named disposable test database receives migrations. The ordinary Tools
`db` volume and Forest development projects are not used or reset. The existing
`test_seeder.ts` is never run. Dependencies and synthetic runtime values live in the
isolated image/container; no user `.env` or real credential is copied or edited.

The project has no published ports and an internal runtime network. A fixed runner
name rejects overlapping runs against its database. Fixtures own unique rooms/users,
clean their own rows and retain no archived-room noise. Keep failure logs before
any separately reviewed disposable-project recovery. Do not use the normal Tools
`db:setup`, `migrate-prod`, `deploy` or normal-volume cleanup to run these tests.

The test launcher does not deploy application code or migrate a production database.

## Scoped Forest bridge

The bridge is implemented under `/integrations/forest/rooms/v1/offices/:officeId`.
It is disabled unless `FOREST_ROOMS_INTEGRATION_ENABLED=true`. Writes additionally
require `FOREST_ROOMS_INTEGRATION_WRITE_ENABLED=true`; automatic releases have their
own `FOREST_ROOMS_INTEGRATION_RELEASE_ENABLED=true` switch. Every switch defaults to
false. `FOREST_ROOMS_OFFICE_IDS` is a comma-separated explicit office allowlist.
None of these switches changes ordinary Tools access or reservations.

An operator must provision a separate native `User.forestRoomTokens` token for an
existing integration principal. Its provider type is `forest_room_integration` and its
prefix is `frt_`. Grant only the needed explicit `rooms:read`, `rooms:write`,
`rooms:release` and `office:<id>` abilities; any wildcard is rejected. Global
`EVENT_ADMIN` is unnecessary for this principal. Ordinary API/MCP tokens and web
cookies cannot authenticate the bridge, and its tokens cannot authenticate ordinary
API/MCP guards. Provisioning/rotation and secret-manager storage are operator actions,
not application startup behavior. No real token is provisioned by these changes.

The Forest server must derive `actorEmail` from its authenticated active user, never
from browser form fields. Tools resolves exactly one existing trimmed/case-normalized
email match. Missing or ambiguous matches fail with `ACTOR_UNRESOLVED`; no account is
created. Commands run with that person's owner/`EVENT_ADMIN` rights, not the integration
principal's rights. No on-behalf owner field is exposed by this bridge.

All operations use POST with a JSON object (including reads), so actor emails do not
enter query strings or access-log URLs. The transport requires `Content-Length`, a body
of at most 8 KiB, no compression/chunked transfer, and no browser Origin/Cookie headers.
Unknown body fields are rejected. Use a fixed HTTPS origin with certificate verification
and no redirects in the caller. The isolated harness uses HTTP only inside its private
Docker network. Integration errors return only `{contractVersion:1,code}` even in debug
mode; server errors log a correlation ID and fixed error code, without SQL, tokens or
private bodies. Existing exception handling outside this prefix is preserved.

| Relative operation | Body beyond actor email | Result |
| --- | --- | --- |
| `/catalog` | optional `afterId`, `limit` (1–100) | Minimal room ID/name/floor/bookability page |
| `/planning` | `date` as Paris `YYYY-MM-DD` | Exclusive day bounds, actor, capabilities, bookings |
| `/reservations/:id/detail` | none | One office-scoped booking |
| `/commands/create` | command identity, room/title/start/end | Committed booking |
| `/commands/update` | create fields plus booking ID/version | Committed booking |
| `/commands/cancel` | command identity, booking ID/version | Cancelled booking ID |
| `/commands/release` | conditional decision described below; no actor email | Booking plus immutable release snapshot |
| `/commands/receipt` | request UUID and optional expected operation/input proof | Principal- and office-scoped committed result |
| `/history` | optional `afterId`, `limit` (1–100) | Release history page within 90 days |

Every successful result contains `contractVersion:1`, `officeId` and `serverNow` as
UTC Unix milliseconds. IDs for bookings/users are decimal strings; room IDs and versions
are positive integers. Booking fields are `id`, `officeRoomId`, `start`, `end`, nullable
`title`, `ownerUserId`, `ownerDisplayName`, `version`, `allocationAt`, `canEdit`, `isOwn`.
Permission fields are display hints: every mutation rechecks current Tools rights.
Planning includes `capabilities.canWrite` and `capabilities.canRelease` for the scoped
credential and current switches. It returns at most 10,000 bookings; overflow is an
explicit error, never a truncated or empty day. Paris day bounds use local next midnight,
including 23/25-hour DST days. Legacy titles up to the existing database limit remain
readable; new titles are limited to 160 characters. New allocation start/end values must
be whole-second UTC Unix milliseconds, matching existing SQL precision.

### Exact command retries

Commands include a UUIDv4 `requestId` and immutable UTC-millisecond `requestCreatedAt`.
Update/cancel/release require numeric `bookingId` and `expectedVersion`. Create/update
also require `officeRoomId`, `start`, `end`, nullable `title`, and the human `actorEmail`.
The first execution must be within five minutes of creation, allowing at most 30 seconds
of future clock skew. A principal/UUID receipt locks before sorted room/booking locks,
and receipt plus mutation commit on the same connection. An identical replay returns
the original result for 24 hours, including after cancellation/deletion; a different
payload returns 409. Owner/office/version/overlap checks occur under the actual locks.
A changed room lock set rolls back and retries the entire transaction at most once.
Legacy writers still own their transactions and share the same allocation locks.

A lost HTTP response is uncertain. Freeze and retry the same identity, time and payload,
or look up its receipt. A missing receipt alone is not proof of rollback. Never generate
a new UUID automatically for uncertain input. Expired commands remain expired after
receipt pruning. Definite conflicts require refreshing/reviewing the current booking.
Socket updates are sent after commit on first execution; planning refresh recovers a
missed socket notification.

### Conditional automatic release

The release command includes `officeRoomId`, `allocationAt`, `reason` (`no_show` or
`departure`), `vacantSince`, nullable `lastOccupiedEndAt`, `evidenceAt`, `decidedAt`, and
`delaySeconds` (0–86,400). These fields are UTC Unix milliseconds except the delay in
seconds. Forest owns sensor interpretation and policy; Tools accepts only the dedicated
release ability. It verifies the actual office, room, booking ID/version/anchor, ongoing
interval and bounded evidence: evidence is at most 60 seconds old, the decision at most
30 seconds old, and evidence/absence anchors cannot be after the decision. The first absence starts at
Forest reception, which may follow sensor capture by a few milliseconds; zero delay
therefore does not require a second heartbeat. Eligibility is:

`max(start, allocationAt, vacantSince, lastOccupiedEndAt or 0) + delaySeconds*1000 <= min(decidedAt, ToolsNow)`

The actual closure is `ceil(now/1000)*1000`, never backdated; closure at/after the old
end is rejected without an audit or false success. In one transaction Tools shortens the
booking, increments its version, records the original owner/name/room/title/interval,
decision/evidence/effective/recorded times, server-computed `decision.eligibleAt` threshold, and command ID, and commits the receipt.
Audit insertion failure rolls back everything. A stale booking or successor is never
closed by the predecessor's command. Original snapshots survive later booking deletion.
No compensation reopens a released interval. Forest must reconcile the receipt before
claiming a successful local release; an in-flight request cannot be atomically revoked
by a later presence report in the other service.

### Retention and activation prerequisites

`node ace.js forest:rooms:prune` removes only integration receipts older than 24 hours
and automatic-release audits older than 90 days. It never deletes ordinary booking
history. An operator should schedule it daily in the intended deployment; no scheduler
or production command is installed or executed here. Reads already hide expired rows.
Existing Forest technical logs retain their own 30-day policy.

Before any activation: deploy the additive schema first; verify deployed Tools version,
all reservation writers, UTC/whole-second SQL serialization, the dedicated principal,
scoped credential and office list; review explicit Forest room links and identity matches;
then enable read/admin preview, human writes and automatic release separately. These
are production prerequisites, not verified production facts. Local checks use only
short-lived synthetic credentials in the positively verified disposable database.

### Forest adapter integration details

The read-only catalog/planning/detail operations also accept an omitted `actorEmail`
for the scoped background reader. Such a planning response has `actor: null` and no
booking edit rights. Human mutations always require the verified delegated email and
retain the exact unique-person/ownership checks above. No service account becomes the
human owner. Catalog boolean fields are JSON booleans regardless of MySQL's numeric
column representation.

Catalog supports optional `includeAllocationStatus: true`; only then each scoped room
adds `hasCurrentOrFutureAllocation` (any allocation ending after ToolsNow). This bounded
query lets Forest guard explicit link/archive changes without copying bookings or
assuming that today's snapshot describes all future dates. It is advisory across
services and cannot revoke a concurrently committed booking.

Receipt lookup optionally includes `expected: { operation, input }`, where input is the
complete original command. It passes through the same exact validators as execution;
the nested UUID must equal the lookup UUID. Tools compares the stored operation/payload
hash, including office and delegated email, before returning a result. A mismatch is
409. Forest browser retries always use this verified form; raw UUID lookup remains for
its trusted operational dispatcher. A missing receipt does not prove rollback.

For update only, an unchanged legacy title up to 255 characters may be retained during
move/resize. A changed title still has the 160-character limit, checked under the
existing locked transaction. Ordinary Tools route limits are unchanged.


## Two-application fixture

Forest's `server/dev/roomToolsPreviewHarness.js` supports explicit `verify`, `browser`
and bounded interactive `serve` scenarios. See its `docs/room-reservations/preview-verification.md`
for exact commands and pending human acceptance. The companion
`tests/functional/forest_rooms_fixture.spec.ts` is skipped by default; only the guarded
launcher sets `TOOLS_ROOMS_LIVE_FIXTURE=1`. It verifies the dedicated SQL server/account/
marker and refuses a pre-existing office1 before creating a synthetic office, scoped
expiring integration token, owner/second-owner/manager identities and reviewable room
catalog. It does not run the destructive application test seeder or load a real env file.

The private handoff is written mode0600; no token is logged or returned to a browser.
Forest consumes it only inside the internal test network. A bounded15-minute handshake
keeps the actual Tools HTTP server available. Forest stops its own writers before ending
that handshake; Tools then removes only the owned office/users/receipts/audits and
asserts their absence. Fixture failures and cleanup failures remain visible. Ordinary
Tools development data and volumes are never reset by this fixture.
