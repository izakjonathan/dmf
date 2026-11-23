import { z } from "zod";
import {
  admin,
  bookingSigningCredentials,
  bookingToken,
  bookingReceiptUrl,
  dispatchBookingMail,
  fail,
  equals,
  RequestError,
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
  activeBooking,
  bookingRegistrationClosed,
  issueBookingContracts,
  contactBookingId,
  reissueBookingContract,
  reopenBooking,
  bookingOverview,
  bookingStage,
  isCurrentBookingMail,
  confirmBooking,
  markBookingsPaid,
  resolveBookingException,
  paidSchema,
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
        attendanceLocked:
          b.members.length > 0 && b.members.every((m) => m.paymentId),
        workflowStatus: bookingStage(state, b).label,
        members: b.members.map((m) => ({
          id: m.id,
          name: m.name,
          attendance: m.attendance,
          attendanceLocked: Boolean(m.paymentId),
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
    "createBooking",
    "ticketSales",
    "issueContracts",
    "resolveException",
    "approve",
    "attendance",
    "attendanceDate",
    "paid",
    "link",
    "signingLink",
    "receiptLink",
    "retry",
    "resendInvitation",
    "reissue",
    "correctBooking",
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
      const saved = await writeState(
        state,
        booking.artistFirst ? { sheetBookingId: booking.id } : undefined,
      );
      return json(nightResponse(saved, access));
    }
    if (input.action === "createBooking") {
      const data = z
        .object({
          requestId: z.string().uuid(),
          date,
          act: z.string().trim().min(1).max(300).regex(/^[^=]/),
          contactName: z.string().trim().min(1).max(300).regex(/^[^=]/),
          contactEmail: z
            .string()
            .trim()
            .email()
            .max(254)
            .toLowerCase()
            .regex(/^[^=]/),
          contactPhone: z
            .string()
            .trim()
            .max(50)
            .regex(/^[+0-9 ()-]*$/)
            .optional(),
          booker: z.string().trim().min(1).max(300).regex(/^[^=]/),
          fee: z.number().int().positive().max(100000000),
          ticketPrice: z.number().int().min(0).max(100000000),
        })
        .parse(input.data);
      const result = await sheets("createBooking", { booking: data });
      return json({
        ...response(result.state),
        bookingDate: data.date,
        message: "Booking saved. The invitation is queued.",
      });
    }
    if (input.action === "ticketSales") {
      const { sold } = z
        .object({ sold: z.number().int().min(0).max(1000000) })
        .parse(input.data);
      if (!input.id) throw new RequestError("Choose a booking.");
      const result = await sheets("ticketSales", { id: input.id, sold });
      return json({
        ...response(result.state),
        message: "Ticket sales saved.",
      });
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
    if (input.action === "receiptLink") {
      const { mailId } = z.object({ mailId: z.string() }).parse(input.data);
      const mail = state.bookingMail?.find(
        (m) =>
          m.id === mailId && m.kind === "receipt" && m.bookingId === input.id,
      );
      const contract =
        mail &&
        state.contracts?.find(
          (c) =>
            c.id === mail.id.slice(8) &&
            c.bookingId === input.id &&
            c.offer.organizerSignedAt &&
            Date.parse(c.offer.organizerSignedAt) + 365 * 86400000 > Date.now(),
        );
      if (!contract)
        throw new RequestError(
          "No current copy is available for this email.",
          404,
        );
      return json({
        link: new URL(bookingReceiptUrl(contract.id)).pathname + "?receipt=1",
      });
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
          bookingRegistrationClosed(b),
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
    if (input.action === "issueContracts") {
      const booking = activeBooking(state, input.id || "");
      if (!booking.artistFirst)
        throw new RequestError(
          "This booking uses the existing venue-first approval.",
        );
      const checked = await sheets("sheetBookingReview", { id: booking.id });
      const current = activeBooking(checked.state, booking.id);
      issueBookingContracts(
        checked.state,
        current,
        current,
        bookingSigningCredentials,
      );
      const saved = await writeState(checked.state, {
        sheetBookingId: booking.id,
      });
      try {
        const result = await dispatchBookingMail();
        return json({ ...response(result.state), delivery: result.delivery });
      } catch {
        return json({
          ...response(saved),
          warning: "Contracts queued. Check email status for delivery.",
        });
      }
    }
    if (input.action === "approve") {
      if (!input.id) throw Error("Choose a booking.");
      approveBooking(state, input.id, input.data, bookingSigningCredentials);
    }
    if (input.action === "correctBooking") {
      if (!input.id) throw new RequestError("Choose a booking.");
      reopenBooking(state, input.id, input.data);
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
        bookingSigningCredentials,
      );
    }
    const rowChecks = new Set<string>();
    if (input.action === "resolveException") {
      if (!input.id) throw new RequestError("Choose a booking.");
      resolveBookingException(state, input.id, input.data);
      rowChecks.add(input.id);
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
      for (const booking of acts) {
        if (booking.artistFirst) rowChecks.add(booking.id);
        confirmBooking(state, booking.id, {
          by: value.by,
          note: "",
          members: booking.members.map((m) => ({ id: m.id, status: "played" })),
        });
      }
    }
    if (input.action === "attendance") {
      if (!input.id) throw Error("Choose a booking.");
      const booking = activeBooking(state, input.id);
      if (booking.artistFirst) rowChecks.add(booking.id);
      confirmBooking(state, input.id, input.data);
    }
    if (input.action === "paid") {
      const data = paidSchema.parse(input.data);
      for (const { bookingId } of data.members)
        if (activeBooking(state, bookingId).artistFirst)
          rowChecks.add(bookingId);
      markBookingsPaid(state, data);
    }
    if (input.action === "resendInvitation") {
      const booking = state.bookings?.find(
        (b) => b.id === input.id && !b.cancelled && !b.sourceError,
      );
      if (!booking || bookingRegistrationClosed(booking))
        throw new RequestError(
          "Choose an open booking with a current contact.",
          409,
        );
      const entries = (state.bookingMail ??= []);
      const previous = entries
        .filter(
          (m) =>
            m.bookingId === booking.id &&
            m.kind === "invitation" &&
            m.to === booking.contactEmail,
        )
        .at(-1);
      if (previous && Date.now() - Date.parse(previous.createdAt) < 60000)
        throw new RequestError(
          "Wait one minute before resending the invitation.",
          429,
        );
      for (const mail of entries)
        if (
          mail.bookingId === booking.id &&
          mail.kind === "invitation" &&
          mail.status === "pending"
        )
          mail.status = "superseded";
      const root = "https://dmf-eta.vercel.app/b/";
      entries.push({
        id: "invitation:" + crypto.randomUUID(),
        bookingId: booking.id,
        sourceVersion: booking.sourceVersion || 1,
        to: booking.contactEmail,
        kind: "invitation",
        status: "pending",
        createdAt: new Date().toISOString(),
        subject: "Booking invitation · " + booking.act + " · " + booking.date,
        body:
          "Complete the schedule using your private contact link:\n" +
          root +
          bookingToken(contactBookingId(booking)) +
          "\n\nForward this registration form to every musician:\n" +
          root +
          bookingToken(booking.id),
      });
    }
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
        mail.kind === "verification" ||
        !isCurrentBookingMail(mail, booking)
      )
        throw Error(
          "Only a confirmed failed email can be retried. Copy the link for an unconfirmed delivery.",
        );
      mail.status = "pending";
      mail.error = undefined;
    }
    const saved = await writeState(
      state,
      rowChecks.size ? { sheetBookingIds: [...rowChecks] } : undefined,
    );
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
