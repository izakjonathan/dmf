import { z } from "zod";
import {
  artistPerformanceSchema,
  musicianSchema,
  type Workspace,
} from "@/lib/model";
import {
  bookingToken,
  dispatchBookingMail,
  equals,
  fail,
  hash,
  json,
  readState,
  RequestError,
  sameOrigin,
  token,
  writeState,
} from "@/lib/server";
import type { Booking } from "@/lib/bookings";
export const maxDuration = 60;
type Context = { params: Promise<{ token: string }> };
function findBooking(state: Workspace, raw: string) {
  if (!/^[a-f0-9]{64}$/.test(raw))
    throw new RequestError("Invalid booking link.", 404);
  const booking = state.bookings?.find((b) => equals(bookingToken(b.id), raw));
  if (!booking || booking.cancelled || booking.sourceError)
    throw new RequestError("This booking is unavailable or cancelled.", 404);
  return booking;
}
function verify(state: Workspace, booking: Booking, raw: string) {
  if (!/^[a-f0-9]{64}$/.test(raw))
    throw new RequestError("Open the verification link in your email.", 403);
  const proof = state.bookingVerifications?.find(
    (p) =>
      p.bookingId === booking.id &&
      p.hash === hash(raw) &&
      p.expiresAt > new Date().toISOString(),
  );
  if (!proof)
    throw new RequestError(
      "Verification expired. Request a new email link.",
      403,
    );
  return proof;
}
function publicDetails(state: Workspace, booking: Booking) {
  return {
    booking: {
      date: booking.date,
      act: booking.act,
      expectedMembers: booking.expectedMembers,
      registered: booking.members.length,
      performance: booking.performance,
      approved: booking.approvedVersion === booking.version,
      fee: booking.fee,
      paymentType: booking.paymentType,
      dueOn: booking.dueOn,
    },
    venue: {
      name: state.venue.name,
      email: state.venue.email,
      legalName: state.venue.legalName,
      collectCpr: state.venue.collectCpr,
    },
  };
}
export async function GET(req: Request, context: Context) {
  try {
    const state = await readState();
    const booking = findBooking(state, (await context.params).token);
    const proofToken = new URL(req.url).searchParams.get("verify");
    if (!proofToken) return json(publicDetails(state, booking));
    const proof = verify(state, booking, proofToken);
    const profile = state.musicians.find(
      (m) => m.email.toLowerCase() === proof.email,
    );
    const { cpr, ...safeProfile } = profile || {};
    return json({
      ...publicDetails(state, booking),
      email: proof.email,
      isContact: proof.email === booking.contactEmail,
      profile: profile ? safeProfile : null,
      registered: booking.members.some((m) => m.email === proof.email),
    });
  } catch (error) {
    return fail(error);
  }
}
const emailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
export async function POST(req: Request, context: Context) {
  try {
    sameOrigin(req);
    const state = await readState();
    const raw = (await context.params).token;
    const booking = findBooking(state, raw);
    const body = await req.json();
    if (body.action === "verify") {
      const email = emailSchema.parse(body.email);
      const now = Date.now();
      const recent = (state.bookingMail || []).filter(
        (m) =>
          m.kind === "verification" &&
          m.bookingId === booking.id &&
          Date.parse(m.createdAt) > now - 3600000,
      );
      if (
        recent.length >= 30 ||
        recent.filter((m) => m.to === email).length >= 3
      )
        throw new RequestError(
          "Please wait before requesting another verification email.",
          429,
        );
      const secret = token();
      state.bookingVerifications = (state.bookingVerifications || []).filter(
        (p) => Date.parse(p.expiresAt) > now,
      );
      state.bookingVerifications.push({
        id: crypto.randomUUID(),
        bookingId: booking.id,
        email,
        hash: hash(secret),
        expiresAt: new Date(now + 30 * 60000).toISOString(),
      });
      state.bookingMail ??= [];
      state.bookingMail.push({
        id: "verify:" + crypto.randomUUID(),
        bookingId: booking.id,
        kind: "verification",
        to: email,
        status: "pending",
        createdAt: new Date(now).toISOString(),
        subject: "Verify your email · " + booking.act,
        body:
          "Open this private link to enter or update your musician details for " +
          booking.act +
          " on " +
          booking.date +
          ".\n\nhttps://dmf-eta.vercel.app/b/" +
          raw +
          "?verify=" +
          secret +
          "\n\nThis link expires in 30 minutes. Please keep it private. Every musician must register before playing.",
      });
      await writeState(state);
      try {
        const result = await dispatchBookingMail();
        if (result.delivery?.failed)
          return json({
            message:
              "Your verification email is queued. If it does not arrive, contact the venue.",
          });
      } catch {
        return json({
          message:
            "Your verification email is queued. Contact the venue if it does not arrive.",
        });
      }
      return json({
        message:
          "Check your email and open the private verification link. It expires in 30 minutes.",
      });
    }
    const proof = verify(state, booking, String(body.verification || ""));
    if (booking.approvedVersion === booking.version || booking.confirmedAt)
      throw new RequestError(
        "The lineup and agreement are approved. Contact the venue to request a change.",
        409,
      );
    if (body.action === "act") {
      if (proof.email !== booking.contactEmail)
        throw new RequestError(
          "Only the booking contact can change the act details.",
          403,
        );
      const performance = artistPerformanceSchema.parse(body.performance);
      const expected = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(body.expectedMembers);
      if (expected < booking.members.length)
        throw new RequestError(
          "The member count is smaller than the registered lineup.",
        );
      const proposedFee = z
        .number()
        .int()
        .positive()
        .max(100000000)
        .parse(body.fee);
      Object.assign(booking, {
        performance,
        expectedMembers: expected,
        fee: proposedFee,
      });
    } else if (body.action === "register") {
      const input = musicianSchema.parse(body.profile);
      if (input.email !== proof.email)
        throw new RequestError("Use your verified email address.", 403);
      const existing = state.musicians.find(
        (m) => m.email.toLowerCase() === proof.email,
      );
      const member = booking.members.find((m) => m.email === proof.email);
      if (!member && booking.members.length >= booking.expectedMembers)
        throw new RequestError(
          "The lineup is full. Ask the band contact to update the member count.",
          409,
        );
      const at = new Date().toISOString();
      const profile = {
        ...existing,
        ...input,
        id: existing?.id || crypto.randomUUID(),
        cpr: state.venue.collectCpr
          ? input.cpr || existing?.cpr || ""
          : existing?.cpr || "",
        createdAt: existing?.createdAt || at,
        updatedAt: at,
      };
      if (existing)
        state.musicians[state.musicians.indexOf(existing)] = profile;
      else state.musicians.push(profile);
      if (member)
        Object.assign(member, { name: profile.name, musicianId: profile.id });
      else
        booking.members.push({
          id: crypto.randomUUID(),
          musicianId: profile.id,
          name: profile.name,
          email: profile.email,
        });
    } else throw new RequestError("Unknown booking action.");
    // Any material artist change invalidates a draft version before company approval.
    booking.version++;
    const complete =
      booking.performance && booking.members.length === booking.expectedMembers;
    if (
      complete &&
      !state.bookingMail?.some((m) => m.id === "approval:" + booking.id)
    ) {
      state.bookingMail ??= [];
      state.bookingMail.push({
        id: "approval:" + booking.id,
        bookingId: booking.id,
        kind: "approval",
        to: state.venue.email,
        status: "pending",
        createdAt: new Date().toISOString(),
        subject:
          "Booking ready for approval · " + booking.act + " · " + booking.date,
        body: "The musicians have completed the booking details. Review the lineup, schedule and fees, then approve and sign in Stagebook.\n\nhttps://dmf-eta.vercel.app",
      });
    }
    await writeState(state);
    try {
      await dispatchBookingMail();
    } catch {
      /* The saved outbox is retried by booking automation. */
    }
    return json({ ok: true, ...publicDetails(state, booking) });
  } catch (error) {
    return fail(error);
  }
}
