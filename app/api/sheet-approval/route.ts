import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  activeBooking,
  approveBooking,
  confirmBooking,
  markBookingsPaid,
  pendingReason,
  contractsForCountersign,
  countersignBooking,
  signingDeadline,
} from "@/lib/bookings";
import {
  date,
  dmfTemplate,
  today,
  venueSchema,
  type Workspace,
} from "@/lib/model";
import {
  admin,
  sameOrigin,
  readState,
  bookingSigningCredentials,
  bookingReceiptUrl,
  dispatchBookingMail,
  equals,
  fail,
  hash,
  json,
  RequestError,
  sheets,
  writeState,
} from "@/lib/server";

export const maxDuration = 60;
const attendanceOperation = z.object({
  id: z.string().uuid(),
  timestamp: z.number().int(),
});
const requestSchema = z.discriminatedUnion("action", [
  attendanceOperation.extend({ action: z.literal("attendanceReview") }),
  attendanceOperation.extend({ action: z.literal("paymentsReview") }),
  attendanceOperation.extend({
    action: z.literal("recordPayment"),
    signer: z.string().trim().min(2).max(300),
    review: z.string().regex(/^[a-f0-9]{64}$/),
    accepted: z.literal(true),
    paidOn: date,
    selection: z.string().regex(/^(all|[1-9]\d{0,2})$/),
  }),
  attendanceOperation.extend({
    action: z.literal("attendance"),
    signer: z.string().trim().min(2).max(300),
    review: z.string().regex(/^[a-f0-9]{64}$/),
    accepted: z.literal(true),
  }),
  z.object({
    action: z.literal("review"),
    id: z.string().uuid(),
    timestamp: z.number().int(),
  }),
  z.object({
    action: z.literal("sign"),
    id: z.string().uuid(),
    timestamp: z.number().int(),
    signer: z.string().trim().min(2).max(300),
    review: z.string().regex(/^[a-f0-9]{64}$/),
    accepted: z.literal(true),
  }),
]);

function reviewBooking(state: Workspace, id: string) {
  const booking = activeBooking(state, id);
  if (booking.sourceError) throw new RequestError(booking.sourceError, 409);
  if (booking.approvedVersion === booking.version)
    return { booking, data: null, review: "" };
  let contracts;
  if (booking.artistFirst) {
    try {
      contracts = contractsForCountersign(state, booking);
    } catch (error) {
      throw new RequestError((error as Error).message, 409);
    }
  }
  if (
    !booking.performance ||
    booking.members.length !== booking.expectedMembers
  )
    throw new RequestError(
      "Complete the schedule and all musician registrations before signing.",
      409,
    );
  if (!booking.fee)
    throw new RequestError(
      "Enter the fee per musician in the booking row or ask the band contact to provide it.",
      409,
    );
  const data = {
    id: booking.id,
    version: booking.version,
    sourceSignature: booking.sourceSignature,
    act: booking.act,
    date: booking.date,
    performance: booking.performance,
    fee: booking.fee,
    dueOn: booking.dueOn,
    returnBy: signingDeadline(booking.date),
    organizer: venueSchema.parse(state.venue),
    members: booking.members
      .filter(
        (member) => !booking.artistFirst || member.attendance === "played",
      )
      .map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
        method: member.paymentType || booking.paymentType,
      })),
    template: contracts?.[0]?.offer.template ?? dmfTemplate,
    countersign: Boolean(booking.artistFirst),
    terms: contracts?.map((contract) => ({
      offer: contract.offer,
      performer: contract.performer,
      performerSigner: contract.performerSigner,
      performerSignedAt: contract.performerSignedAt,
    })),
  };
  return { booking, data, review: hash(JSON.stringify(data)) };
}

export async function GET(req: Request) {
  try {
    await admin();
    const id = z.string().uuid().parse(new URL(req.url).searchParams.get("id"));
    const { data, review } = reviewBooking(await readState(), id);
    if (!data) return json({ signed: true });
    return json({ ...data, review });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request) {
  try {
    const secret = process.env.GOOGLE_SCRIPT_SECRET;
    const raw = await req.text();
    const fromScript = req.headers.has("x-stagebook-signature");
    let legacy = false;
    if (!fromScript) {
      sameOrigin(req);
      await admin();
    }
    if (
      raw.length > 4000 ||
      (fromScript &&
        (!secret ||
          !equals(
            req.headers.get("x-stagebook-signature") || "",
            createHmac("sha256", secret)
              .update("stagebook-sheet-approval:" + raw)
              .digest("hex"),
          )))
    )
      throw new RequestError("Open Stagebook from the booking workbook.", 403);
    const input = requestSchema.parse(JSON.parse(raw));
    if (Math.abs(Date.now() - input.timestamp) > 120000)
      throw new RequestError(
        "This request expired. Open the booking again.",
        403,
      );
    let state: Workspace;
    if (fromScript || input.action === "review") {
      ({ state } = await sheets("sheetBookingReview", { id: input.id }));
    } else {
      // Prefer the adapter's row-level check. Older deployments expose the established sync action.
      try {
        ({ state } = await sheets("sheetBookingReview", { id: input.id }));
      } catch (error) {
        if (
          !(error instanceof RequestError) ||
          error.status !== 503 ||
          !error.message.startsWith(
            "Update the existing Apps Script deployment",
          )
        )
          throw error;
        ({ state } = await sheets("syncBookings"));
        legacy = true;
      }
    }
    if (input.action === "paymentsReview" || input.action === "recordPayment") {
      if (!fromScript)
        throw new RequestError(
          "Open the payment action from the booking sheet.",
          403,
        );
      const booking = activeBooking(state, input.id);
      const ready = booking.members
        .filter(
          (member) => pendingReason(state, booking, member) === "Ready to pay",
        )
        .map((member) => ({
          id: member.id,
          name: member.name,
          contractId: member.contractId,
          fee: state.contracts!.find(
            (contract) => contract.id === member.contractId,
          )!.offer.fee,
          method: member.paymentType || booking.paymentType,
        }));
      if (!ready.length)
        throw new RequestError(
          "No payments are ready to record for this booking.",
          409,
        );
      const review = hash(JSON.stringify([booking.id, booking.version, ready]));
      if (input.action === "paymentsReview")
        return json({
          act: booking.act,
          date: booking.date,
          ready,
          review,
          today: today(),
        });
      if (!equals(review, input.review))
        throw new RequestError(
          "The payment queue changed. Review it again.",
          409,
        );
      const selected =
        input.selection === "all"
          ? ready
          : [ready[Number(input.selection) - 1]];
      if (selected.some((member) => !member))
        throw new RequestError(
          "Choose a number shown in the review or enter all.",
        );
      markBookingsPaid(state, {
        by: input.signer,
        paidOn: input.paidOn,
        members: selected.map((member) => ({
          bookingId: booking.id,
          memberId: member.id,
        })),
      });
      await writeState(state, { sheetBookingId: booking.id });
      return json({
        message: "Recorded " + selected.length + " processed payment(s).",
      });
    }
    if (input.action === "attendanceReview" || input.action === "attendance") {
      if (!fromScript)
        throw new RequestError(
          "Open the attendance action from the booking sheet.",
          403,
        );
      const booking = activeBooking(state, input.id);
      if (
        booking.confirmedAt ||
        booking.date > today() ||
        !booking.performance ||
        booking.members.length !== booking.expectedMembers
      )
        throw new RequestError(
          "Choose a completed show with a full, unconfirmed lineup. For exceptions, open the booking in Stagebook.",
          409,
        );
      const roster = booking.members.map(({ id, name }) => ({ id, name }));
      const review = hash(
        JSON.stringify([booking.id, booking.version, booking.date, roster]),
      );
      if (input.action === "attendanceReview")
        return json({
          act: booking.act,
          date: booking.date,
          members: roster.map((member) => member.name),
          review,
        });
      if (!equals(review, input.review))
        throw new RequestError(
          "The lineup changed. Review the booking again.",
          409,
        );
      confirmBooking(state, booking.id, {
        by: input.signer,
        note: "",
        members: roster.map(({ id }) => ({ id, status: "played" })),
      });
      await writeState(state, { sheetBookingId: booking.id });
      return json({ message: "Performance confirmed." });
    }
    const { booking, data, review } = reviewBooking(state, input.id);
    if (!data) {
      if (input.action === "sign")
        return json({
          message:
            "The company signature is already saved. Check the contract status in Stagebook.",
        });
      throw new RequestError(
        "The company has already signed this version.",
        409,
      );
    }
    if (input.action === "review") return json({ ...data, review });
    if (!equals(input.review, review))
      throw new RequestError(
        "The booking changed while you were reviewing it. Open the review again.",
        409,
      );
    if (booking.artistFirst)
      countersignBooking(state, booking, input.signer, bookingReceiptUrl);
    else
      approveBooking(
        state,
        booking.id,
        { ...data, accepted: input.accepted, signer: input.signer },
        bookingSigningCredentials,
      );
    await writeState(
      state,
      legacy ? undefined : { sheetBookingId: booking.id },
    );
    const ids = new Set(
      booking.members
        .filter(
          (member) => !booking.artistFirst || member.attendance === "played",
        )
        .map(
          (member) =>
            (booking.artistFirst ? "receipt:" : "contract:") +
            member.contractId,
        ),
    );
    try {
      const result = await dispatchBookingMail();
      const sent = (result.state.bookingMail || []).filter(
        (mail: { id: string; status: string }) =>
          ids.has(mail.id) && mail.status === "sent",
      ).length;
      return json({
        message: `Company signature saved. ${sent} of ${ids.size} ${booking.artistFirst ? "signed copies" : "requests"} sent by Google. Check Stagebook for individual email and signature status.`,
      });
    } catch {
      return json({
        message:
          "Company signature saved. Email status is unconfirmed. Check Stagebook before retrying.",
      });
    }
  } catch (error) {
    return fail(error);
  }
}
