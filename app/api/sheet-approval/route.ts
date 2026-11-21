import { createHmac } from "node:crypto";
import { z } from "zod";
import { activeBooking, approveBooking, signingDeadline } from "@/lib/bookings";
import { dmfTemplate, venueSchema, type Workspace } from "@/lib/model";
import {
  admin,
  sameOrigin,
  readState,
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

function reviewBooking(state: Workspace, id: string) {
  const booking = activeBooking(state, id);
  if (booking.sourceError) throw new RequestError(booking.sourceError, 409);
  if (booking.approvedVersion === booking.version)
    return { booking, data: null, review: "" };
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
    members: booking.members.map((member) => ({
      id: member.id,
      name: member.name,
      email: member.email,
      method: member.paymentType || booking.paymentType,
    })),
    template: dmfTemplate,
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
    const signed = await writeState(
      state,
      legacy ? undefined : { sheetBookingId: booking.id },
    );
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
