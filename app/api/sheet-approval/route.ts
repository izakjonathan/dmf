import { createHmac } from "node:crypto";
import { z } from "zod";
import { activeBooking, approveBooking, signingDeadline } from "@/lib/bookings";
import { dmfTemplate, venueSchema } from "@/lib/model";
import {
  bookingContractToken,
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
const requestSchema = z.discriminatedUnion("action", [
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

export async function POST(req: Request) {
  try {
    const secret = process.env.GOOGLE_SCRIPT_SECRET;
    const raw = await req.text();
    if (
      !secret ||
      raw.length > 4000 ||
      !equals(
        req.headers.get("x-stagebook-signature") || "",
        createHmac("sha256", secret)
          .update("stagebook-sheet-approval:" + raw)
          .digest("hex"),
      )
    )
      throw new RequestError("Open Stagebook from the booking workbook.", 403);
    const input = requestSchema.parse(JSON.parse(raw));
    if (Math.abs(Date.now() - input.timestamp) > 120000)
      throw new RequestError(
        "This request expired. Open the booking again.",
        403,
      );
    const { state } = await sheets("sheetBookingReview", { id: input.id });
    const booking = activeBooking(state, input.id);
    if (booking.approvedVersion === booking.version) {
      if (input.action === "sign")
        return json({
          message:
            "The company signature is already saved. Check email status before retrying.",
        });
      throw new RequestError(
        "The company has already signed this version.",
        409,
      );
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
    const organizer = venueSchema.parse(state.venue);
    const returnBy = signingDeadline(booking.date);
    const data = {
      id: booking.id,
      version: booking.version,
      sourceSignature: booking.sourceSignature,
      act: booking.act,
      date: booking.date,
      performance: booking.performance,
      fee: booking.fee,
      dueOn: booking.dueOn,
      returnBy,
      organizer,
      members: booking.members.map((m) => ({
        name: m.name,
        email: m.email,
        method: m.paymentType || booking.paymentType,
      })),
      template: dmfTemplate,
    };
    const review = hash(JSON.stringify(data));
    if (input.action === "review") return json({ ...data, review });
    if (!equals(input.review, review))
      throw new RequestError(
        "The booking changed while you were reviewing it. Open the review again.",
        409,
      );
    approveBooking(
      state,
      booking.id,
      { ...data, accepted: input.accepted, signer: input.signer },
      (id) => {
        const token = bookingContractToken(id);
        return {
          hash: hash(token),
          url: "https://dmf-eta.vercel.app/register/" + token,
        };
      },
    );
    const signed = await writeState(state, { sheetBookingId: booking.id });
    const ids = new Set(
      signed.invites
        .filter(
          (invite) =>
            invite.bookingId === booking.id &&
            invite.bookingVersion === booking.version &&
            !invite.revoked,
        )
        .map((invite) => "contract:" + invite.id),
    );
    try {
      const result = await dispatchBookingMail();
      const sent = (result.state.bookingMail || []).filter(
        (mail: { id: string; status: string }) =>
          ids.has(mail.id) && mail.status === "sent",
      ).length;
      return json({
        message: `Company signature saved. ${sent} of ${ids.size} requests sent by Google. Check Stagebook for individual email and signature status.`,
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
