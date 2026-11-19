import { z } from "zod";
import {
  admin,
  bookingContractToken,
  bookingToken,
  dispatchBookingMail,
  fail,
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
  bookingOverview,
  confirmBooking,
  markBookingsPaid,
} from "@/lib/bookings";
export const maxDuration = 60;
function response(state: Awaited<ReturnType<typeof readState>>) {
  return {
    bookings: bookingOverview(state).map((booking) => ({
      ...booking,
      link: "/b/" + bookingToken(booking.id),
    })),
    sheet: spreadsheet(),
  };
}
export async function GET(req: Request) {
  try {
    await admin();
    const state = await readState();
    const bookingId = new URL(req.url).searchParams.get("accounts");
    if (bookingId) {
      const booking = state.bookings?.find((b) => b.id === bookingId);
      if (!booking) throw Error("Booking not found.");
      return json({
        accounts: booking.members.map((member) => {
          const musician = state.musicians.find(
            (m) => m.id === member.musicianId,
          );
          return {
            memberId: member.id,
            name: member.name,
            email: member.email,
            registration: musician?.registration,
            account: musician?.account,
            iban: musician?.iban,
            phone: musician?.phone,
            payee: musician?.payee,
            cvr: musician?.cvr,
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
  ]),
  id: z.string().uuid().optional(),
  data: z.unknown(),
});
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    await admin();
    const input = actionSchema.parse(await req.json());
    if (input.action === "sync") {
      const result = await sheets("syncBookings");
      return json({ ...response(result.state), delivery: result.delivery });
    }
    const state = await readState();
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
      if (!invite) throw Error("No active signing request for this musician.");
      return json({ link: paymentSigningPath(invite) });
    }
    if (input.action === "approve") {
      if (!input.id) throw Error("Choose a booking.");
      approveBooking(state, input.id, input.data, (id) => {
        const raw = bookingContractToken(id);
        return {
          hash: hash(raw),
          url: "https://dmf-eta.vercel.app/register/" + raw,
        };
      });
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
      if (!mail || mail.status !== "failed")
        throw Error(
          "Only a confirmed failed email can be retried. Copy the link for an unconfirmed delivery.",
        );
      mail.status = "pending";
      mail.error = undefined;
    }
    const saved = await writeState(state);
    if (input.action === "approve" || input.action === "retry") {
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
