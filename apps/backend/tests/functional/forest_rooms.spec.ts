import { randomUUID } from "node:crypto";
import db from "@adonisjs/lucid/services/db";
import { RIGHTS } from "@galadrim-tools/shared";
import { test } from "@japa/runner";
import { DateTime } from "luxon";
import Office from "#models/office";
import OfficeFloor from "#models/office_floor";
import OfficeRoom from "#models/office_room";
import RoomReservation from "#models/room_reservation";
import User from "#models/user";
import {
    type ReleaseInput,
    forestRoomsService,
    resolveForestActor,
} from "#services/forest_rooms_service";
import { roomReservationService } from "#services/room_reservation_service";
import env from "#start/env";

const prefix = `forest-api-${randomUUID()}`;
const base = "/integrations/forest/rooms/v1/offices/1";
let principal: User;
let actor: User;
let other: User;
let manager: User;
let office: Office;
let room: OfficeRoom;
let roomB: OfficeRoom;
let token: string;
const identity = () => ({ requestId: randomUUID(), requestCreatedAt: Date.now() });
const allocation = () => ({
    ...identity(),
    actorEmail: actor.email,
    officeRoomId: room.id,
    start: Date.parse("2030-01-15T10:00:00Z"),
    end: Date.parse("2030-01-15T11:00:00Z"),
    title: null,
});
async function credential(abilities = ["rooms:read", "rooms:write", "rooms:release", "office:1"]) {
    const result = await User.forestRoomTokens.create(principal, abilities, {
        expiresIn: "10 minutes",
    });
    if (!result.value) throw new Error("Synthetic credential was not generated");
    return result.value.release();
}
async function releaseFixture(): Promise<ReleaseInput> {
    const now = Date.now();
    // A legacy ongoing booking, including across midnight, is valid provider read/release input.
    const booking = await RoomReservation.create({
        officeRoomId: room.id,
        userId: actor.id,
        start: DateTime.fromMillis(Math.floor((now - 3600000) / 1000) * 1000, { zone: "utc" }),
        end: DateTime.fromMillis(Math.floor((now + 1800000) / 1000) * 1000, { zone: "utc" }),
        title: "Original owner title",
        integrationVersion: 1,
        allocationAt: DateTime.fromMillis(Math.floor((now - 1800000) / 1000) * 1000, {
            zone: "utc",
        }),
    });
    return {
        ...identity(),
        bookingId: booking.id,
        expectedVersion: 1,
        officeRoomId: room.id,
        allocationAt: Math.floor((now - 1800000) / 1000) * 1000,
        reason: "no_show",
        vacantSince: now - 900000,
        lastOccupiedEndAt: null,
        evidenceAt: now,
        decidedAt: now,
        delaySeconds: 600,
    };
}

test.group("Forest integration guard and commands", (group) => {
    group.setup(async () => {
        if (
            process.env.TOOLS_ROOMS_TEST !== "1" ||
            process.env.DB_DATABASE !== "tools_forest_rooms_test"
        )
            throw new Error("Isolated room fixture target required");
        const rows = await db.rawQuery("SELECT @@hostname AS host, DATABASE() AS db");
        if (
            rows[0][0].host !== "tools-forest-rooms-test-mysql" ||
            rows[0][0].db !== "tools_forest_rooms_test"
        )
            throw new Error("Wrong DB target");
        if (await Office.find(1))
            throw new Error("Reserved isolated fixture office 1 is unexpectedly occupied");
        const person = async (suffix: string, rights = 0) =>
            User.create({
                username: `${prefix}-${suffix}`,
                email: `${prefix}-${suffix}@example.test`,
                password: "synthetic-not-a-login",
                rights,
            });
        principal = await person("principal");
        actor = await person("owner");
        other = await person("other");
        manager = await person("manager", RIGHTS.EVENT_ADMIN);
        office = await Office.create({ id: 1, name: prefix, address: "Synthetic", lat: 0, lng: 0 });
        const floor = await OfficeFloor.create({ officeId: office.id, floor: 2, config: {} });
        const createRoom = (name: string) =>
            OfficeRoom.create({
                officeFloorId: floor.id,
                name: `${prefix}-${name}`,
                config: { points: [] },
                isBookable: true,
                isPhonebox: false,
            });
        room = await createRoom("A");
        roomB = await createRoom("B");
        token = await credential();
    });
    group.each.teardown(async () => {
        if (room && roomB)
            await db
                .from("room_reservations")
                .whereIn("office_room_id", [room.id, roomB.id])
                .delete();
        if (principal)
            await db.from("forest_room_requests").where("principal_id", principal.id).delete();
        if (office) await db.from("forest_room_releases").where("office_id", office.id).delete();
    });
    group.teardown(async () => {
        if (office) await office.delete();
        for (const user of [principal, actor, other, manager]) if (user) await user.delete();
    });
    test("requires the isolated integration credential even for reads", async ({ client }) => {
        (
            await client
                .post(`${base}/planning`)
                .json({ date: "2030-01-15", actorEmail: actor.email })
        ).assertStatus(401);
    });
    test("installed native guards reject ordinary tokens, cookies and cross-guard integration tokens", async ({
        client,
        assert,
    }) => {
        const ordinary = await User.accessTokens.create(principal);
        if (!ordinary.value) throw new Error("Missing synthetic ordinary credential");
        (
            await client
                .post(`${base}/planning`)
                .header("Authorization", `Bearer ${ordinary.value.release()}`)
                .json({ date: "2030-01-15", actorEmail: actor.email })
        ).assertStatus(401);
        (
            await client
                .post(`${base}/planning`)
                .header("Cookie", "adonis-session=synthetic")
                .json({ date: "2030-01-15", actorEmail: actor.email })
        ).assertStatus(401);
        (
            await client.get("/availableRooms").header("Authorization", `Bearer ${token}`)
        ).assertStatus(401);
        (
            await client.post("/mcp").header("Authorization", `Bearer ${token}`).json({})
        ).assertStatus(401);
        const result = await client
            .post(`${base}/planning`)
            .header("Authorization", `Bearer ${token}`)
            .json({ date: "2030-01-15", actorEmail: actor.email });
        result.assertStatus(200);
        assert.isTrue(token.startsWith("frt_"));
        assert.deepEqual(result.body().bookings, []);
        assert.equal(result.header("cache-control"), "no-store");
    });
    test("checks explicit abilities, office scope, wildcard refusal and native expiry", async ({
        client,
    }) => {
        for (const abilities of [
            ["*", "office:1", "rooms:read"],
            ["rooms:write", "office:1"],
            ["rooms:read", "office:2"],
        ]) {
            const scoped = await credential(abilities);
            (
                await client
                    .post(`${base}/planning`)
                    .header("Authorization", `Bearer ${scoped}`)
                    .json({ date: "2030-01-15", actorEmail: actor.email })
            ).assertStatus(403);
        }
        (
            await client
                .post(`${base.replace("offices/1", "offices/2")}/planning`)
                .header("Authorization", `Bearer ${token}`)
                .json({ date: "2030-01-15", actorEmail: actor.email })
        ).assertStatus(403);
        const expired = await credential();
        await db
            .from("auth_access_tokens")
            .where("tokenable_id", principal.id)
            .where("type", "forest_room_integration")
            .update({ expires_at: new Date(Date.now() - 60000) });
        (
            await client
                .post(`${base}/planning`)
                .header("Authorization", `Bearer ${expired}`)
                .json({ date: "2030-01-15", actorEmail: actor.email })
        ).assertStatus(401);
        token = await credential();
    });
    test("default-off boundary and independent write/release flags do not affect read access", async ({
        client,
    }) => {
        env.set("FOREST_ROOMS_INTEGRATION_ENABLED", false);
        try {
            (await client.post(`${base}/planning`).json({})).assertStatus(404);
        } finally {
            env.set("FOREST_ROOMS_INTEGRATION_ENABLED", true);
        }
        env.set("FOREST_ROOMS_INTEGRATION_WRITE_ENABLED", false);
        env.set("FOREST_ROOMS_INTEGRATION_RELEASE_ENABLED", false);
        try {
            (
                await client
                    .post(`${base}/commands/create`)
                    .header("Authorization", `Bearer ${token}`)
                    .json(allocation())
                    .setup(({ request }) => {
                        request.ok(() => true);
                    })
            ).assertStatus(503);
            (
                await client
                    .post(`${base}/commands/release`)
                    .header("Authorization", `Bearer ${token}`)
                    .json({})
                    .setup(({ request }) => {
                        request.ok(() => true);
                    })
            ).assertStatus(503);
            (
                await client
                    .post(`${base}/planning`)
                    .header("Authorization", `Bearer ${token}`)
                    .json({ date: "2030-01-15", actorEmail: actor.email })
            ).assertStatus(200);
        } finally {
            env.set("FOREST_ROOMS_INTEGRATION_WRITE_ENABLED", true);
            env.set("FOREST_ROOMS_INTEGRATION_RELEASE_ENABLED", true);
        }
    });
    test("uses the real unique normalized person, never principal ownership or account creation", async ({
        client,
        assert,
    }) => {
        const input = { ...allocation(), actorEmail: `  ${actor.email.toUpperCase()}  ` };
        const response = await client
            .post(`${base}/commands/create`)
            .header("Authorization", `Bearer ${token}`)
            .json(input);
        response.assertStatus(200);
        assert.equal(response.body().booking.ownerUserId, String(actor.id));
        assert.equal(response.body().booking.title, null);
        assert.equal(response.body().booking.ownerDisplayName, actor.username);
        assert.notInclude(JSON.stringify(response.body()), actor.email);
        const before = await db.from("users").count("id as count").first();
        (
            await client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json({
                    ...allocation(),
                    actorEmail: "missing@example.test",
                    officeRoomId: roomB.id,
                })
        ).assertStatus(403);
        const after = await db.from("users").count("id as count").first();
        assert.equal(after.count, before.count);
        const duplicate = await User.create({
            username: `${prefix}-duplicate`,
            email: ` ${actor.email}`,
            password: "synthetic",
            rights: 0,
        });
        try {
            await assert.rejects(async () => {
                await resolveForestActor(actor.email);
            }, /ACTOR_UNRESOLVED/);
        } finally {
            await duplicate.delete();
        }
    });
    test("parallel identical commands and a lost acknowledgement commit only one booking and receipt", async ({
        client,
        assert,
    }) => {
        const input = allocation();
        const send = () =>
            client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json(input);
        const [first, second] = await Promise.all([send(), send()]);
        first.assertStatus(200);
        second.assertStatus(200);
        assert.deepEqual(first.body(), second.body());
        const replay = await send();
        replay.assertStatus(200);
        assert.deepEqual(replay.body(), first.body());
        const rows = await db.from("room_reservations").where("office_room_id", room.id);
        assert.lengthOf(rows, 1);
        const receipt = await client
            .post(`${base}/commands/receipt`)
            .header("Authorization", `Bearer ${token}`)
            .json({ requestId: input.requestId });
        receipt.assertStatus(200);
        assert.deepEqual(receipt.body(), first.body());
        (
            await client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json({ ...input, officeRoomId: roomB.id })
        ).assertStatus(409);
    });
    test("owner and Tools event-admin rights plus expected versions govern update and cancel", async ({
        client,
        assert,
    }) => {
        const created = await client
            .post(`${base}/commands/create`)
            .header("Authorization", `Bearer ${token}`)
            .json(allocation());
        created.assertStatus(200);
        const bookingId = Number(created.body().booking.id);
        const update = { ...allocation(), bookingId, expectedVersion: 1, title: "Edited" };
        (
            await client
                .post(`${base}/commands/update`)
                .header("Authorization", `Bearer ${token}`)
                .json({ ...update, actorEmail: other.email })
        ).assertStatus(403);
        const good = await client
            .post(`${base}/commands/update`)
            .header("Authorization", `Bearer ${token}`)
            .json(update);
        good.assertStatus(200);
        assert.equal(good.body().booking.version, 2);
        assert.equal(good.body().booking.allocationAt, created.body().booking.allocationAt);
        (
            await client
                .post(`${base}/commands/cancel`)
                .header("Authorization", `Bearer ${token}`)
                .json({ ...identity(), actorEmail: actor.email, bookingId, expectedVersion: 1 })
        ).assertStatus(409);
        const cancel = { ...identity(), actorEmail: manager.email, bookingId, expectedVersion: 2 };
        const deleted = await client
            .post(`${base}/commands/cancel`)
            .header("Authorization", `Bearer ${token}`)
            .json(cancel);
        deleted.assertStatus(200);
        const replay = await client
            .post(`${base}/commands/cancel`)
            .header("Authorization", `Bearer ${token}`)
            .json(cancel);
        replay.assertStatus(200);
        assert.deepEqual(replay.body(), deleted.body());
        assert.isNull(await db.from("room_reservations").where("id", bookingId).first());
    });
    test("expired first execution and purged old requests cannot create a delayed duplicate", async ({
        client,
        assert,
    }) => {
        const input = { ...allocation(), requestCreatedAt: Date.now() - 300001 };
        (
            await client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json(input)
        ).assertStatus(409);
        const good = allocation();
        (
            await client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json(good)
        ).assertStatus(200);
        await db
            .from("forest_room_requests")
            .where("principal_id", principal.id)
            .where("request_id", good.requestId)
            .update({ created_at: new Date(Date.now() - 86400001) });
        (
            await client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json(good)
        ).assertStatus(409);
        await forestRoomsService.prune();
        (
            await client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json(input)
        ).assertStatus(409);
        assert.lengthOf(await db.from("room_reservations").where("office_room_id", room.id), 1);
    });
    test("rejects spoofed/oversized input and returns bounded catalog with private-free DTOs", async ({
        client,
        assert,
    }) => {
        (
            await client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json({ ...allocation(), userId: principal.id, isAdmin: true })
        ).assertStatus(400);
        (
            await client
                .post(`${base}/planning`)
                .header("Authorization", `Bearer ${token}`)
                .json({ date: "2030-01-15", actorEmail: actor.email, padding: "x".repeat(9000) })
        ).assertStatus(413);
        const catalog = await client
            .post(`${base}/catalog`)
            .header("Authorization", `Bearer ${token}`)
            .json({ actorEmail: actor.email, limit: 1 });
        catalog.assertStatus(200);
        assert.lengthOf(catalog.body().rooms, 1);
        assert.isNumber(catalog.body().nextAfterId);
        assert.sameMembers(Object.keys(catalog.body().rooms[0]), [
            "id",
            "name",
            "floor",
            "isBookable",
            "isPhonebox",
        ]);
        const next = await client
            .post(`${base}/catalog`)
            .header("Authorization", `Bearer ${token}`)
            .json({ actorEmail: actor.email, limit: 1, afterId: catalog.body().nextAfterId });
        next.assertStatus(200);
        assert.lengthOf(next.body().rooms, 1);
        assert.isNull(next.body().nextAfterId);
        (
            await client
                .post(`${base}/planning`)
                .header("Authorization", `Bearer ${token}`)
                .json({ date: "2030-02-31", actorEmail: actor.email })
        ).assertStatus(400);
    });
    test("different concurrent commands use the same overlap authority", async ({
        client,
        assert,
    }) => {
        const send = () =>
            client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json(allocation());
        const responses = await Promise.all([send(), send()]);
        assert.sameMembers(
            responses.map((response) => response.status()),
            [200, 409],
        );
        assert.lengthOf(await db.from("room_reservations").where("office_room_id", room.id), 1);
        assert.lengthOf(
            await db.from("forest_room_requests").where("principal_id", principal.id),
            1,
        );
    });
    test("current office membership scopes reads and mutations even for an actual owner", async ({
        client,
        assert,
    }) => {
        const foreign = await Office.create({
            name: `${prefix}-foreign`,
            address: "Synthetic",
            lat: 0,
            lng: 0,
        });
        const floor = await OfficeFloor.create({ officeId: foreign.id, floor: 6, config: {} });
        const originalFloorId = roomB.officeFloorId;
        await db.from("office_rooms").where("id", roomB.id).update({ office_floor_id: floor.id });
        try {
            const booking = await roomReservationService.create(actor, {
                officeRoomId: roomB.id,
                start: "2030-01-15T10:00:00Z",
                end: "2030-01-15T11:00:00Z",
            });
            (
                await client
                    .post(`${base}/reservations/${booking.id}/detail`)
                    .header("Authorization", `Bearer ${token}`)
                    .json({ actorEmail: actor.email })
            ).assertStatus(404);
            (
                await client
                    .post(`${base}/commands/cancel`)
                    .header("Authorization", `Bearer ${token}`)
                    .json({
                        ...identity(),
                        actorEmail: actor.email,
                        bookingId: booking.id,
                        expectedVersion: 1,
                    })
            ).assertStatus(404);
            (
                await client
                    .post(`${base}/commands/create`)
                    .header("Authorization", `Bearer ${token}`)
                    .json({ ...allocation(), officeRoomId: roomB.id })
            ).assertStatus(404);
            const current = await db.from("room_reservations").where("id", booking.id).first();
            assert.equal(current.integration_version, 1);
        } finally {
            await db
                .from("office_rooms")
                .where("id", roomB.id)
                .update({ office_floor_id: originalFloorId });
            await foreign.delete();
        }
    });
    test("HTTP day snapshots preserve legacy titles and the exclusive Paris DST midnight", async ({
        client,
        assert,
    }) => {
        const first = await roomReservationService.create(actor, {
            officeRoomId: room.id,
            start: "2026-10-25T22:30:00Z",
            end: "2026-10-25T23:00:00Z",
            title: "T".repeat(200),
        });
        await roomReservationService.create(other, {
            officeRoomId: roomB.id,
            start: "2026-10-25T23:00:00Z",
            end: "2026-10-25T23:30:00Z",
        });
        const snapshot = await client
            .post(`${base}/planning`)
            .header("Authorization", `Bearer ${token}`)
            .json({ date: "2026-10-25", actorEmail: actor.email });
        snapshot.assertStatus(200);
        const body = snapshot.body();
        assert.equal(body.day.to - body.day.from, 25 * 3600000);
        assert.deepEqual(
            body.bookings.map((row: { id: string }) => row.id),
            [String(first.id)],
        );
        assert.equal(body.bookings[0].title.length, 200);
        assert.sameMembers(Object.keys(body.bookings[0]), [
            "id",
            "officeRoomId",
            "start",
            "end",
            "title",
            "ownerUserId",
            "ownerDisplayName",
            "version",
            "allocationAt",
            "isOwn",
            "canEdit",
        ]);
        assert.isTrue(body.capabilities.canWrite);
        (
            await client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json({ ...allocation(), start: allocation().start + 1 })
        ).assertStatus(400);
    });
    test("day overflow is explicit instead of truncating or inventing an empty day", async ({
        client,
        assert,
    }) => {
        const seed = {
            office_room_id: room.id,
            user_id: actor.id,
            title: null,
            start: new Date("2030-01-15T10:00:00Z"),
            end: new Date("2030-01-15T11:00:00Z"),
        };
        for (let offset = 0; offset < 10001; offset += 500)
            await db
                .table("room_reservations")
                .multiInsert(
                    Array.from({ length: Math.min(500, 10001 - offset) }, () => ({ ...seed })),
                );
        const response = await client
            .post(`${base}/planning`)
            .header("Authorization", `Bearer ${token}`)
            .json({ date: "2030-01-15", actorEmail: actor.email })
            .setup(({ request }) => {
                request.ok(() => true);
            });
        response.assertStatus(503);
        assert.deepEqual(response.body(), { contractVersion: 1, code: "DAY_LIMIT_EXCEEDED" });
    });
    test("a receipt is invisible to another scoped integration principal", async ({ client }) => {
        const input = allocation();
        (
            await client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json(input)
        ).assertStatus(200);
        const result = await User.forestRoomTokens.create(other, ["rooms:read", "office:1"], {
            expiresIn: "10 minutes",
        });
        if (!result.value) throw new Error("Synthetic credential missing");
        (
            await client
                .post(`${base}/commands/receipt`)
                .header("Authorization", `Bearer ${result.value.release()}`)
                .json({ requestId: input.requestId })
        ).assertStatus(404);
    });
    test("future clock skew cannot make a release threshold eligible early", async ({ assert }) => {
        const input = await releaseFixture();
        const now = Date.now();
        const originalNow = Date.now;
        Date.now = () => now;
        try {
            await assert.rejects(async () => {
                await forestRoomsService.command(principal.id, 1, {
                    operation: "release",
                    input: {
                        ...input,
                        delaySeconds: 0,
                        vacantSince: now + 500,
                        evidenceAt: now + 500,
                        decidedAt: now + 800,
                    },
                });
            }, /RELEASE_NOT_ELIGIBLE/);
        } finally {
            Date.now = originalNow;
        }
    });
    test("conditional release preserves original owner and interval, then replays after booking deletion", async ({
        client,
        assert,
    }) => {
        const input = await releaseFixture();
        const before = Date.now();
        const response = await client
            .post(`${base}/commands/release`)
            .header("Authorization", `Bearer ${token}`)
            .json(input);
        response.assertStatus(200);
        const result = response.body();
        assert.equal(result.release.original.ownerUserId, String(actor.id));
        assert.equal(result.release.original.title, "Original owner title");
        assert.equal(result.booking.version, 2);
        assert.equal(
            result.release.decision.eligibleAt,
            Math.max(
                result.release.original.start,
                input.allocationAt,
                input.vacantSince,
                input.lastOccupiedEndAt ?? 0,
            ) +
                input.delaySeconds * 1000,
        );
        assert.isAtLeast(result.release.effectiveEnd, before);
        assert.equal(result.release.effectiveEnd % 1000, 0);
        assert.isAbove(result.release.original.end, result.release.effectiveEnd);
        await roomReservationService.delete(actor, input.bookingId);
        const replay = await client
            .post(`${base}/commands/release`)
            .header("Authorization", `Bearer ${token}`)
            .json(input);
        replay.assertStatus(200);
        assert.deepEqual(replay.body(), result);
        const history = await client
            .post(`${base}/history`)
            .header("Authorization", `Bearer ${token}`)
            .json({ actorEmail: actor.email });
        history.assertStatus(200);
        assert.lengthOf(history.body().releases, 1);
        assert.equal(history.body().releases[0].original.ownerDisplayName, actor.username);
        assert.equal(
            history.body().releases[0].decision.eligibleAt,
            result.release.decision.eligibleAt,
        );
    });
    test("stale evidence, fresh allocation and changed versions cannot shorten a booking or its successor", async ({
        client,
        assert,
    }) => {
        const input = await releaseFixture();
        for (const invalid of [
            { ...input, evidenceAt: Date.now() - 61000 },
            { ...input, expectedVersion: 2 },
            { ...input, allocationAt: input.allocationAt + 1000 },
            { ...input, vacantSince: Date.now(), decidedAt: Date.now() },
        ])
            (
                await client
                    .post(`${base}/commands/release`)
                    .header("Authorization", `Bearer ${token}`)
                    .json(invalid)
            ).assertStatus(409);
        await roomReservationService.delete(actor, input.bookingId);
        const successor = await roomReservationService.create(other, {
            officeRoomId: room.id,
            start: new Date(Date.now() - 600000),
            end: new Date(Date.now() + 1800000),
        });
        (
            await client
                .post(`${base}/commands/release`)
                .header("Authorization", `Bearer ${token}`)
                .json(input)
        ).assertStatus(404);
        const current = await db.from("room_reservations").where("id", successor.id).first();
        assert.equal(current.integration_version, 1);
        assert.isAbove(new Date(current.end).getTime(), Date.now() + 1000000);
        assert.lengthOf(await db.from("forest_room_releases").where("office_id", 1), 0);
    });
    test("audit insert failure rolls back booking and receipt, without leaking SQL details", async ({
        client,
        assert,
    }) => {
        const input = await releaseFixture();
        await db.table("forest_room_releases").insert({
            booking_id: input.bookingId,
            office_id: 1,
            office_room_id: room.id,
            command_id: input.requestId,
            original_snapshot: "{}",
            decision: "{}",
            effective_end: new Date(),
            recorded_at: new Date(),
        });
        const response = await client
            .post(`${base}/commands/release`)
            .header("Authorization", `Bearer ${token}`)
            .json(input)
            .setup(({ request }) => {
                request.ok(() => true);
            });
        response.assertStatus(503);
        assert.deepEqual(response.body(), { contractVersion: 1, code: "PROVIDER_FAILURE" });
        const current = await db.from("room_reservations").where("id", input.bookingId).first();
        assert.equal(current.integration_version, 1);
        assert.isAbove(new Date(current.end).getTime(), Date.now() + 1000000);
        assert.lengthOf(
            await db.from("forest_room_requests").where("principal_id", principal.id),
            0,
        );
    });
    test("release history expires after 90 days independently from 24-hour command receipts", async ({
        client,
        assert,
    }) => {
        const input = await releaseFixture();
        (
            await client
                .post(`${base}/commands/release`)
                .header("Authorization", `Bearer ${token}`)
                .json(input)
        ).assertStatus(200);
        await db
            .from("forest_room_requests")
            .where("principal_id", principal.id)
            .update({ created_at: new Date(Date.now() - 86400001) });
        const old = randomUUID();
        await db.table("forest_room_releases").insert({
            booking_id: input.bookingId,
            office_id: 1,
            office_room_id: room.id,
            command_id: old,
            original_snapshot: "{}",
            decision: "{}",
            effective_end: new Date(),
            recorded_at: new Date(Date.now() - 90 * 86400000 - 1000),
        });
        const pruned = await forestRoomsService.prune();
        assert.equal(pruned.receipts, 1);
        assert.equal(pruned.releases, 1);
        assert.lengthOf(
            await db.from("forest_room_releases").where("command_id", input.requestId),
            1,
        );
        assert.lengthOf(
            await db.from("forest_room_requests").where("principal_id", principal.id),
            0,
        );
    });
    test("machine reads retain office scope and catalog reports future allocations on demand", async ({
        client,
        assert,
    }) => {
        const planning = await client
            .post(`${base}/planning`)
            .header("Authorization", `Bearer ${token}`)
            .json({ date: "2030-01-15" });
        planning.assertStatus(200);
        assert.isNull(planning.body().actor);
        assert.isTrue(
            planning.body().bookings.every((booking: { canEdit: boolean }) => !booking.canEdit),
        );
        const input = {
            ...allocation(),
            start: Date.parse("2031-01-15T10:00:00Z"),
            end: Date.parse("2031-01-15T11:00:00Z"),
        };
        (
            await client
                .post(`${base}/commands/create`)
                .header("Authorization", `Bearer ${token}`)
                .json(input)
        ).assertStatus(200);
        const catalog = await client
            .post(`${base}/catalog`)
            .header("Authorization", `Bearer ${token}`)
            .json({ includeAllocationStatus: true });
        catalog.assertStatus(200);
        assert.isTrue(
            catalog.body().rooms.find((item: { id: number }) => item.id === room.id)
                .hasCurrentOrFutureAllocation,
        );
        const ordinary = await client
            .post(`${base}/catalog`)
            .header("Authorization", `Bearer ${token}`)
            .json({ actorEmail: actor.email });
        ordinary.assertStatus(200);
        assert.notProperty(ordinary.body().rooms[0], "hasCurrentOrFutureAllocation");
    });
    test("receipt lookup verifies the original operation, payload and delegated actor", async ({
        client,
        assert,
    }) => {
        const input = {
            ...allocation(),
            start: Date.parse("2032-01-15T10:00:00Z"),
            end: Date.parse("2032-01-15T11:00:00Z"),
        };
        const created = await client
            .post(`${base}/commands/create`)
            .header("Authorization", `Bearer ${token}`)
            .json(input);
        created.assertStatus(200);
        const lookup = (expected: unknown) =>
            client
                .post(`${base}/commands/receipt`)
                .header("Authorization", `Bearer ${token}`)
                .json({ requestId: input.requestId, expected });
        const replay = await lookup({ operation: "create", input });
        replay.assertStatus(200);
        assert.equal(replay.body().booking.id, created.body().booking.id);
        assert.isTrue(replay.body().booking.isOwn);
        (
            await lookup({ operation: "create", input: { ...input, actorEmail: other.email } })
        ).assertStatus(409);
        (
            await lookup({ operation: "create", input: { ...input, title: "different" } })
        ).assertStatus(409);
        (
            await lookup({ operation: "create", input: { ...input, requestId: randomUUID() } })
        ).assertStatus(400);
        (await lookup({ operation: "create", input: { ...input, isAdmin: true } })).assertStatus(
            400,
        );
    });
    test("unchanged legacy titles survive resize while new long titles are rejected", async ({
        client,
        assert,
    }) => {
        const original = await roomReservationService.create(actor, {
            officeRoomId: room.id,
            start: "2033-01-15T10:00:00Z",
            end: "2033-01-15T11:00:00Z",
            title: "x".repeat(220),
        });
        const input = {
            ...identity(),
            actorEmail: actor.email,
            bookingId: original.id,
            expectedVersion: 1,
            officeRoomId: room.id,
            start: original.start.toMillis(),
            end: original.end.toMillis() + 300000,
            title: original.title,
        };
        const resized = await client
            .post(`${base}/commands/update`)
            .header("Authorization", `Bearer ${token}`)
            .json(input);
        resized.assertStatus(200);
        assert.equal(resized.body().booking.title, original.title);
        (
            await client
                .post(`${base}/commands/update`)
                .header("Authorization", `Bearer ${token}`)
                .json({ ...input, ...identity(), expectedVersion: 2, title: "y".repeat(161) })
        ).assertStatus(400);
    });
    test("zero delay accepts a first absence anchored at reception after its capture", async ({
        client,
        assert,
    }) => {
        const input = await releaseFixture();
        const decidedAt = Date.now();
        input.delaySeconds = 0;
        input.evidenceAt = decidedAt - 10;
        input.vacantSince = decidedAt - 5;
        input.decidedAt = decidedAt;
        const result = await client
            .post(`${base}/commands/release`)
            .header("Authorization", `Bearer ${token}`)
            .json(input);
        result.assertStatus(200);
        assert.equal(result.body().release.decision.eligibleAt, input.vacantSince);
    });
});
