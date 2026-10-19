import { createHash } from "node:crypto";
import db from "@adonisjs/lucid/services/db";
import type { TransactionClientContract } from "@adonisjs/lucid/types/database";
import { DateTime } from "luxon";
import OfficeRoom from "#models/office_room";
import RoomReservation from "#models/room_reservation";
import User from "#models/user";
import { ForestRoomsError } from "./forest_rooms_errors.js";
import {
    ReservationLockSetChanged,
    assertReservationOffice,
    withExistingReservation,
} from "./reservation_transactions.js";
import { roomReservationService } from "./room_reservation_service.js";

export const RECEIPT_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const RELEASE_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
const metadata = (officeId: number) => ({
    contractVersion: 1 as const,
    officeId,
    serverNow: Date.now(),
});

type CommandIdentity = { requestId: string; requestCreatedAt: number };
type Human = CommandIdentity & { actorEmail: string };
type Allocation = { officeRoomId: number; start: number; end: number; title: string | null };
type Expected = { bookingId: number; expectedVersion: number };
export type ReleaseInput = CommandIdentity &
    Expected & {
        officeRoomId: number;
        allocationAt: number;
        reason: "no_show" | "departure";
        vacantSince: number;
        lastOccupiedEndAt: number | null;
        evidenceAt: number;
        decidedAt: number;
        delaySeconds: number;
    };
export type ForestRoomCommand =
    | { operation: "create"; input: Human & Allocation }
    | { operation: "update"; input: Human & Allocation & Expected }
    | { operation: "cancel"; input: Human & Expected }
    | { operation: "release"; input: ReleaseInput };
export type BridgeBooking = ReturnType<typeof bookingDto>;
type ReleaseRecord = {
    commandId: string;
    bookingId: string;
    officeRoomId: number;
    original: BridgeBooking;
    reason: ReleaseInput["reason"];
    decision: ReleaseInput & { eligibleAt: number };
    effectiveEnd: number;
    recordedAt: number;
};
export type CommandResult = ReturnType<typeof metadata> & {
    requestId: string;
    operation: ForestRoomCommand["operation"];
    booking?: BridgeBooking;
    cancelledId?: string;
    release?: ReleaseRecord;
};
function bookingDto(row: RoomReservation, actor?: User) {
    return {
        id: String(row.id),
        officeRoomId: row.officeRoomId,
        start: row.start.toMillis(),
        end: row.end.toMillis(),
        title: row.title,
        ownerUserId: String(row.userId),
        ownerDisplayName: row.user?.username ?? "Anonyme",
        version: row.integrationVersion,
        allocationAt: row.allocationAt.toMillis(),
        isOwn: Boolean(actor && actor.id === row.userId),
        canEdit: Boolean(actor && (actor.id === row.userId || actor.hasRights(["EVENT_ADMIN"]))),
    };
}
function storedObject(value: unknown): Record<string, unknown> {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new ForestRoomsError("INVALID_STORED_RESULT", 503);
    return parsed as Record<string, unknown>;
}
function storedResult(value: unknown, officeId: number) {
    const result = storedObject(value);
    if (result.officeId !== officeId) throw new ForestRoomsError("NOT_FOUND", 404);
    if (
        result.contractVersion !== 1 ||
        typeof result.requestId !== "string" ||
        typeof result.operation !== "string"
    )
        throw new ForestRoomsError("INVALID_STORED_RESULT", 503);
    return result as CommandResult;
}
export async function resolveForestActor(email: string, trx?: TransactionClientContract) {
    const query = User.query(trx ? { client: trx } : {})
        .select("id", "username", "email", "rights")
        .whereRaw("LOWER(TRIM(email)) = ?", [email.trim().toLowerCase()])
        .limit(2);
    if (trx) query.forShare();
    const matches = await query;
    if (matches.length !== 1) throw new ForestRoomsError("ACTOR_UNRESOLVED", 403);
    return matches[0];
}
function officeBookingQuery(officeId: number) {
    return RoomReservation.query()
        .whereHas("room", (room) =>
            room.whereHas("officeFloor", (floor) => floor.where("officeId", officeId)),
        )
        .preload("user", (user) => user.select("id", "username"));
}
function commandHash(officeId: number, command: ForestRoomCommand) {
    return createHash("sha256")
        .update(JSON.stringify({ officeId, ...command }))
        .digest("hex");
}
class ForestRoomsService {
    async catalog(
        officeId: number,
        email: string | undefined,
        afterId = 0,
        limit = 100,
        includeAllocationStatus = false,
    ) {
        if (email !== undefined) await resolveForestActor(email);
        const rows = await OfficeRoom.query()
            .whereHas("officeFloor", (q) => q.where("officeId", officeId))
            .where("id", ">", afterId)
            .orderBy("id")
            .limit(limit + 1)
            .preload("officeFloor");
        const page = rows.slice(0, limit);
        const allocated = new Set<number>();
        if (includeAllocationStatus && page.length) {
            const allocations = await RoomReservation.query()
                .select("officeRoomId")
                .distinct("officeRoomId")
                .whereIn(
                    "officeRoomId",
                    page.map((room) => room.id),
                )
                .where("end", ">", new Date());
            for (const allocation of allocations) allocated.add(allocation.officeRoomId);
        }
        return {
            ...metadata(officeId),
            rooms: page.map((room) => ({
                id: room.id,
                name: room.name,
                floor: room.officeFloor.floor,
                isBookable: Boolean(room.isBookable),
                isPhonebox: Boolean(room.isPhonebox),
                ...(includeAllocationStatus
                    ? { hasCurrentOrFutureAllocation: allocated.has(room.id) }
                    : {}),
            })),
            nextAfterId: rows.length > limit ? page[page.length - 1].id : null,
        };
    }

    async planning(officeId: number, email: string | undefined, date: string) {
        const actor = email === undefined ? undefined : await resolveForestActor(email);
        const from = DateTime.fromISO(date, { zone: "Europe/Paris" }).startOf("day");
        if (!from.isValid || from.toISODate() !== date)
            throw new ForestRoomsError("INVALID_DATE", 400);
        const to = from.plus({ days: 1 });
        const rows = await officeBookingQuery(officeId)
            .where("end", ">", from.toUTC().toJSDate())
            .where("start", "<", to.toUTC().toJSDate())
            .orderBy("id")
            .limit(10001);
        if (rows.length > 10000) throw new ForestRoomsError("DAY_LIMIT_EXCEEDED", 503);
        return {
            ...metadata(officeId),
            day: { date, from: from.toMillis(), to: to.toMillis() },
            actor: actor
                ? {
                      id: String(actor.id),
                      displayName: actor.username,
                      canManageAll: actor.hasRights(["EVENT_ADMIN"]),
                  }
                : null,
            bookings: rows.map((row) => bookingDto(row, actor)),
        };
    }

    async detail(officeId: number, email: string | undefined, id: number) {
        const actor = email === undefined ? undefined : await resolveForestActor(email);
        const booking = await officeBookingQuery(officeId).where("id", id).firstOrFail();
        return { ...metadata(officeId), booking: bookingDto(booking, actor) };
    }

    async receipt(
        principalId: number,
        officeId: number,
        requestId: string,
        expected?: ForestRoomCommand,
    ) {
        const row = await db
            .from("forest_room_requests")
            .where("principal_id", principalId)
            .where("request_id", requestId)
            .where("created_at", ">", new Date(Date.now() - RECEIPT_LIFETIME_MS))
            .first();
        if (!row) throw new ForestRoomsError("NOT_FOUND", 404);
        if (expected && row.payload_hash !== commandHash(officeId, expected))
            throw new ForestRoomsError("REQUEST_CONFLICT", 409);
        return storedResult(row.result, officeId);
    }

    async history(officeId: number, email: string, afterId = 0, limit = 100) {
        await resolveForestActor(email);
        const rows = await db
            .from("forest_room_releases")
            .where("office_id", officeId)
            .where("id", ">", afterId)
            .where("recorded_at", ">", new Date(Date.now() - RELEASE_HISTORY_MS))
            .orderBy("id")
            .limit(limit + 1);
        const page = rows.slice(0, limit);
        return {
            ...metadata(officeId),
            releases: page.map((row) => ({
                id: row.id,
                commandId: row.command_id,
                bookingId: String(row.booking_id),
                officeRoomId: row.office_room_id,
                original: storedObject(row.original_snapshot),
                decision: storedObject(row.decision),
                effectiveEnd: new Date(row.effective_end).getTime(),
                recordedAt: new Date(row.recorded_at).getTime(),
            })),
            nextAfterId: rows.length > limit ? page[page.length - 1].id : null,
        };
    }

    async command(principalId: number, officeId: number, command: ForestRoomCommand) {
        const { input, operation } = command;
        // Validated objects have deterministic key ordering and include actor, office and operation.
        const payloadHash = commandHash(officeId, command);
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                return await db.transaction(async (trx) => {
                    const now = Date.now();
                    await trx.rawQuery(
                        `INSERT INTO forest_room_requests
                        (principal_id, request_id, operation, payload_hash, result, issued_at, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE request_id = request_id`,
                        [
                            principalId,
                            input.requestId,
                            operation,
                            payloadHash,
                            JSON.stringify({ officeId, pending: true }),
                            new Date(input.requestCreatedAt),
                            new Date(now),
                        ],
                    );
                    const receipt = await trx
                        .from("forest_room_requests")
                        .where("principal_id", principalId)
                        .where("request_id", input.requestId)
                        .forUpdate()
                        .first();
                    if (receipt.payload_hash !== payloadHash)
                        throw new ForestRoomsError("REQUEST_CONFLICT", 409);
                    if (now - new Date(receipt.created_at).getTime() >= RECEIPT_LIFETIME_MS)
                        throw new ForestRoomsError("REQUEST_EXPIRED", 409);
                    const stored = storedObject(receipt.result);
                    if (stored.pending !== true)
                        return { result: storedResult(stored, officeId), event: null };
                    if (
                        input.requestCreatedAt < now - 300000 ||
                        input.requestCreatedAt > now + 30000
                    )
                        throw new ForestRoomsError("REQUEST_EXPIRED", 409);
                    let booking: RoomReservation | undefined;
                    let release: ReleaseRecord | undefined;
                    let cancelledId: string | undefined;
                    let actor: User | undefined;
                    if (command.operation === "release") {
                        const released = await this.release(officeId, command.input, trx);
                        booking = released.booking;
                        release = released.release;
                    } else {
                        actor = await resolveForestActor(command.input.actorEmail, trx);
                        const context = {
                            transaction: trx,
                            officeId,
                            maxChangedTitleLength: 160,
                            expectedVersion:
                                command.operation === "create"
                                    ? undefined
                                    : command.input.expectedVersion,
                        };
                        if (command.operation === "cancel") {
                            cancelledId = String(
                                await roomReservationService.delete(
                                    actor,
                                    command.input.bookingId,
                                    context,
                                ),
                            );
                        } else {
                            const allocation = {
                                officeRoomId: command.input.officeRoomId,
                                title: command.input.title,
                                start: new Date(command.input.start),
                                end: new Date(command.input.end),
                            };
                            booking =
                                command.operation === "create"
                                    ? await roomReservationService.create(
                                          actor,
                                          allocation,
                                          context,
                                      )
                                    : await roomReservationService.update(
                                          actor,
                                          command.input.bookingId,
                                          allocation,
                                          context,
                                      );
                        }
                    }
                    const result: CommandResult = {
                        ...metadata(officeId),
                        requestId: input.requestId,
                        operation,
                        ...(booking ? { booking: bookingDto(booking, actor) } : {}),
                        ...(cancelledId ? { cancelledId } : {}),
                        ...(release ? { release } : {}),
                    };
                    await trx
                        .from("forest_room_requests")
                        .where("principal_id", principalId)
                        .where("request_id", input.requestId)
                        .update({ result: JSON.stringify(result) });
                    return { result, event: { booking, cancelledId, operation } };
                });
            } catch (error) {
                if (!(error instanceof ReservationLockSetChanged)) throw error;
            }
        }
        throw new ForestRoomsError("RESERVATION_CHANGED", 409);
    }

    private async release(officeId: number, input: ReleaseInput, trx: TransactionClientContract) {
        return withExistingReservation(
            input.bookingId,
            null,
            async (lockedTrx, booking) => {
                const room = await assertReservationOffice(
                    booking.officeRoomId,
                    officeId,
                    lockedTrx,
                );
                if (
                    !room.isBookable ||
                    room.isPhonebox ||
                    booking.officeRoomId !== input.officeRoomId
                )
                    throw new ForestRoomsError("INVALID_ROOM", 404);
                if (
                    booking.integrationVersion !== input.expectedVersion ||
                    booking.allocationAt.toMillis() !== input.allocationAt
                )
                    throw new ForestRoomsError("RESERVATION_CHANGED", 409);
                const now = Date.now();
                const effectiveEnd = Math.ceil(now / 1000) * 1000;
                const anchor = Math.max(
                    booking.start.toMillis(),
                    input.allocationAt,
                    input.vacantSince,
                    input.lastOccupiedEndAt ?? 0,
                );
                const threshold = anchor + input.delaySeconds * 1000;
                if (
                    // Forest starts absence at server reception, which can follow capture.
                    input.vacantSince > input.decidedAt ||
                    input.evidenceAt > input.decidedAt ||
                    input.decidedAt > now + 1000 ||
                    now - input.evidenceAt > 60000 ||
                    now - input.decidedAt > 30000 ||
                    (input.lastOccupiedEndAt !== null &&
                        input.lastOccupiedEndAt > input.evidenceAt) ||
                    threshold > input.decidedAt ||
                    threshold > now ||
                    booking.start.toMillis() >= effectiveEnd ||
                    effectiveEnd >= booking.end.toMillis()
                )
                    throw new ForestRoomsError("RELEASE_NOT_ELIGIBLE", 409);
                await booking.load("user", (user) => user.select("id", "username"));
                const original = bookingDto(booking);
                const release: ReleaseRecord = {
                    commandId: input.requestId,
                    bookingId: String(booking.id),
                    officeRoomId: booking.officeRoomId,
                    original,
                    reason: input.reason,
                    decision: { ...input, eligibleAt: threshold },
                    effectiveEnd,
                    recordedAt: now,
                };
                await lockedTrx.table("forest_room_releases").insert({
                    booking_id: booking.id,
                    office_id: officeId,
                    office_room_id: booking.officeRoomId,
                    command_id: input.requestId,
                    original_snapshot: JSON.stringify(original),
                    decision: JSON.stringify(release.decision),
                    effective_end: new Date(effectiveEnd),
                    recorded_at: new Date(now),
                });
                booking.end = DateTime.fromMillis(effectiveEnd, { zone: "utc" });
                booking.integrationVersion++;
                await booking.save();
                return { booking, release };
            },
            trx,
        );
    }

    async prune() {
        return db.transaction(async (trx) => {
            const receipts = await trx
                .from("forest_room_requests")
                .where("created_at", "<=", new Date(Date.now() - RECEIPT_LIFETIME_MS))
                .delete();
            const releases = await trx
                .from("forest_room_releases")
                .where("recorded_at", "<=", new Date(Date.now() - RELEASE_HISTORY_MS))
                .delete();
            return { receipts, releases };
        });
    }
}
export const forestRoomsService = new ForestRoomsService();
