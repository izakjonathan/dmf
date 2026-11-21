import { z } from "zod";
import {
  admin,
  bookingContractToken,
  bookingToken,
  dispatchBookingMail,
  fail,
  equals,
  RequestError,
  hash,
  json,
  paymentSigningPath,
  readState,
  sameOrigin,
  sheets,
  spreadsheet,
  writeState,
} from "@/lib/server";
import {
  approveBooking,
  contactBookingId,
  reissueBookingContract,
  bookingOverview,
  isCurrentBookingMail,
  confirmBooking,
  markBookingsPaid,
} from "@/lib/bookings";
import { date, today, type Workspace } from "@/lib/model";
export const maxDuration = 60;
function response(state: Awaited<ReturnType<typeof readState>>) {
  return {
    bookings: bookingOverview(state).map((booking) => ({
      ...booking,
      link: "/b/" + bookingToken(booking.id),
      contactLink: "/b/" + bookingToken(contactBookingId(booking)),
    })),
    sheet: spreadsheet(),
  };
}
function signing(id: string) {
  const raw = bookingContractToken(id);
  return { hash: hash(raw), url: "https://dmf-eta.vercel.app/register/" + raw };
}
function nightAccess(state: Workspace, req: Request) {
  const raw = new URL(req.url).searchParams.get("night");
  if (!raw) throw new RequestError("Open your staff link again.", 403);
  const day = raw.slice(0, 10);
  const access = state.nightAccess?.[day];
  if (
    !access ||
    access.until < today() ||
    !equals(raw, day + "." + bookingToken("night:" + access.id))
  )
    throw new RequestError(
      "This staff link has expired or was replaced. Ask the venue for a new link.",
      403,
    );
  return { day, name: access.name };
}
function nightResponse(
  state: Workspace,
  access: { day: string; name: string },
) {
  return {
    staff: access,
    bookings: (state.bookings || [])
      .filter((b) => b.date === access.day)
      .map((b) => ({
        id: b.id,
        date: b.date,
        act: b.act,
        expectedMembers: b.expectedMembers,
        performance: b.performance,
        cancelled: b.cancelled,
        sourceError: b.sourceError ? "Check with the manager." : undefined,
        confirmedAt: b.confirmedAt,
        confirmedBy: b.confirmedBy,
        attendanceNote: b.attendanceNote,
        attendanceLocked: b.members.some((m) => m.paymentId),
        members: b.members.map((m) => ({
          id: m.id,
          name: m.name,
          attendance: m.attendance,
        })),
      })),
  };
}
export async function GET(req: Request) {
  try {
    const staff = new URL(req.url).searchParams.has("night");
    if (!staff) await admin();
    const state = await readState();
    if (staff) return json(nightResponse(state, nightAccess(state, req)!));
    const bookingId = new URL(req.url).searchParams.get("accounts");
    if (bookingId) {
      const booking = state.bookings?.find((b) => b.id === bookingId);
      if (!booking) throw Error("Booking not found.");
      return json({
        accounts: booking.members.map((member) => {
          const musician = state.musicians.find(
            (m) => m.id === member.musicianId,
          );
          const payout = member.payout || musician;
          return {
            memberId: member.id,
            name: member.name,
            email: member.email,
            registration: payout?.registration,
            account: payout?.account,
            iban: payout?.iban,
            phone: payout?.phone,
            payee: payout?.payee,
            cvr: payout?.cvr,
          };
        }),
      });
    }
    return json(response(state));
  } catch (error) {
    return fail(error);
  }
}
const actionSchema = z.object({
  action: z.enum([
    "sync",
    "approve",
    "attendance",
    "attendanceDate",
    "paid",
    "link",
    "signingLink",
    "retry",
    "reissue",
    "staffLink",
    "revokeStaff",
  ]),
  id: z.string().uuid().optional(),
  data: z.unknown(),
});
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    const staff = new URL(req.url).searchParams.has("night");
    if (!staff) await admin();
    const input = actionSchema.parse(await req.json());
    if (staff) {
      if (input.action !== "attendance")
        throw new RequestError("This link only records performances.", 403);
      const state = await readState();
      const access = nightAccess(state, req)!;
      const booking = state.bookings?.find(
        (b) => b.id === input.id && b.date === access.day,
      );
      if (!booking) throw new RequestError("Choose an act on this date.", 404);
      confirmBooking(state, booking.id, {
        ...z
          .object({
            note: z.string().optional(),
            members: z.array(z.unknown()),
          })
          .parse(input.data),
        by: access.name,
      });
      return json(nightResponse(await writeState(state), access));
    }
    if (input.action === "sync") {
      const result = await sheets("syncBookings");
      return json({ ...response(result.state), delivery: result.delivery });
    }
    const state = await readState();
    if (input.action === "staffLink" || input.action === "revokeStaff") {
      const value = z
        .object({
          day: date,
          name: z.string().trim().min(2).max(100).optional(),
        })
        .parse(input.data);
      state.nightAccess ??= {};
      if (input.action === "revokeStaff") {
        delete state.nightAccess[value.day];
        await writeState(state);
        return json({ message: "Staff link revoked." });
      }
      if (!value.name) throw new RequestError("Enter the staff member’s name.");
      if (!state.bookings?.some((b) => !b.cancelled && b.date === value.day))
        throw new RequestError("Choose a date with an active booking.");
      const until = new Date([value.day, today()].sort().at(-1) + "T12:00:00Z");
      until.setUTCDate(until.getUTCDate() + 1);
      const id = crypto.randomUUID();
      state.nightAccess[value.day] = {
        id,
        name: value.name,
        until: until.toISOString().slice(0, 10),
      };
      await writeState(state);
      return json({
        link: "/night/" + value.day + "." + bookingToken("night:" + id),
      });
    }
    if (input.action === "link") {
      const booking = state.bookings?.find(
        (b) => b.id === input.id && !b.cancelled,
      );
      if (!booking) throw Error("Booking not found.");
      return json({ link: "/b/" + bookingToken(booking.id) });
    }
    if (input.action === "signingLink") {
      const memberId = z
        .object({ memberId: z.string().uuid() })
        .parse(input.data).memberId;
      const booking = state.bookings?.find(
        (b) =>
          b.id === input.id &&
          !b.cancelled &&
          !b.sourceError &&
          b.approvedVersion === b.version,
      );
      const member = booking?.members.find((m) => m.id === memberId);
      const invite =
        member &&
        state.invites.find(
          (i) =>
            i.id === member.contractId &&
            !i.revoked &&
            !i.signedAt &&
            i.bookingVersion === booking?.version,
        );
      if (!invite || (invite.offer && invite.offer.returnBy < today()))
        throw Error("Reissue the contract to create an active signing link.");
      return json({ link: paymentSigningPath(invite) });
    }
    if (input.action === "approve") {
      if (!input.id) throw Error("Choose a booking.");
      approveBooking(state, input.id, input.data, signing);
    }
    if (input.action === "reissue") {
      const value = z
        .object({ memberId: z.string().uuid(), returnBy: date })
        .parse(input.data);
      if (!input.id) throw new RequestError("Choose a booking.");
      reissueBookingContract(
        state,
        input.id,
        value.memberId,
        value.returnBy,
        signing,
      );
    }
    if (input.action === "attendanceDate") {
      const value = z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          by: z.string().trim().min(2).max(300),
        })
        .parse(input.data);
      const acts = (state.bookings || []).filter(
        (b) => b.date === value.date && !b.cancelled && !b.confirmedAt,
      );
      if (!acts.length)
        throw Error("This date is already confirmed or has no active acts.");
      if (acts.some((b) => b.members.length !== b.expectedMembers))
        throw new RequestError(
          "Record any incomplete lineup in the act’s performance checklist.",
        );
      for (const booking of acts)
        confirmBooking(state, booking.id, {
          by: value.by,
          note: "",
          members: booking.members.map((m) => ({ id: m.id, status: "played" })),
        });
    }
    if (input.action === "attendance") {
      if (!input.id) throw Error("Choose a booking.");
      confirmBooking(state, input.id, input.data);
    }
    if (input.action === "paid") markBookingsPaid(state, input.data);
    if (input.action === "retry") {
      const mailId = z.object({ mailId: z.string() }).parse(input.data).mailId;
      const mail = state.bookingMail?.find(
        (m) => m.id === mailId && m.bookingId === input.id,
      );
      const booking = state.bookings?.find((b) => b.id === input.id);
      if (
        !mail ||
        mail.status !== "failed" ||
        !booking ||
        !isCurrentBookingMail(mail, booking)
      )
        throw Error(
          "Only a confirmed failed email can be retried. Copy the link for an unconfirmed delivery.",
        );
      mail.status = "pending";
      mail.error = undefined;
    }
    const saved = await writeState(state);
    if (["approve", "retry", "reissue"].includes(input.action)) {
      try {
        const result = await dispatchBookingMail();
        return json({ ...response(result.state), delivery: result.delivery });
      } catch {
        return json({
          ...response(saved),
          warning:
            "Saved. Email delivery is unconfirmed. Check the email status or copy the link.",
        });
      }
    }
    return json(response(saved));
  } catch (error) {
    if (error instanceof Error && !("status" in error) && !("issues" in error))
      return json({ error: error.message }, 400);
    return fail(error);
  }
}
