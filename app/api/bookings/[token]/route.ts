import { acknowledgePrivacy } from "@/lib/privacy";
import { z } from "zod";
import {
  artistPerformanceSchema,
  musicianSchema,
  venueSchema,
  type Workspace,
} from "@/lib/model";
import {
  bookingToken,
  bookingSigningCredentials,
  dispatchBookingMail,
  equals,
  fail,
  hash,
  json,
  readState,
  RequestError,
  sameOrigin,
  sheets,
  token,
  writeState,
} from "@/lib/server";
import {
  bookingRegistrationClosed,
  contactBookingId,
  issueBookingContracts,
  type Booking,
} from "@/lib/bookings";
export const maxDuration = 60;
type Context = { params: Promise<{ token: string }> };
function findBooking(state: Workspace, raw: string) {
  if (!/^[a-f0-9]{64}$/.test(raw))
    throw new RequestError("Invalid booking link.", 404);
  const booking = state.bookings?.find(
    (b) =>
      equals(bookingToken(b.id), raw) ||
      equals(bookingToken(contactBookingId(b)), raw),
  );
  if (
    !booking ||
    booking.cancelled ||
    booking.retentionArchived ||
    booking.sourceError
  )
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
      approved: bookingRegistrationClosed(booking),
      artistFirst: booking.artistFirst,
      venueFee: Boolean(booking.artistFirst && booking.fee),
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
    const raw = (await context.params).token;
    const booking = findBooking(state, raw);
    const isContact = equals(bookingToken(contactBookingId(booking)), raw);
    const sharedPath = "/b/" + bookingToken(booking.id);
    const proofToken = new URL(req.url).searchParams.get("verify");
    if (!proofToken)
      return json({
        ...publicDetails(state, booking),
        isContact,
        sharedPath,
        promotion: isContact ? booking.promotion : undefined,
      });
    const proof = verify(state, booking, proofToken);
    const profile =
      state.musicians.find(
        (m) =>
          m.id ===
          booking.members.find((member) => member.email === proof.email)
            ?.musicianId,
      ) ||
      state.musicians.find(
        (m) => !m.deletedAt && m.email.toLowerCase() === proof.email,
      );
    const { cpr, ...safeProfile } = profile || {};
    if (profile)
      await sheets("auditView", {
        viewer: "musician",
        bookingId: booking.id,
        musicianId: profile.id,
      });
    return json({
      ...publicDetails(state, booking),
      email: proof.email,
      isContact: isContact || proof.email === booking.contactEmail,
      sharedPath,
      profile: profile ? safeProfile : null,
      paymentType: booking.members.find((m) => m.email === proof.email)
        ?.paymentType,
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
      if (bookingRegistrationClosed(booking))
        throw new RequestError(
          "This booking is approved. Contact the venue for a correction.",
          409,
        );
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
      const verificationMailId = "verify:" + crypto.randomUUID();
      state.bookingMail.push({
        id: verificationMailId,
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
          bookingToken(booking.id) +
          "?verify=" +
          secret +
          "\n\nThis link expires in 30 minutes. Please keep it private. Every musician must register before playing.",
      });
      await writeState(state);
      try {
        const result = await dispatchBookingMail();
        const mail = result.state.bookingMail?.find(
          (m: { id: string }) => m.id === verificationMailId,
        );
        if (mail?.status === "failed" || mail?.status === "uncertain")
          return json({
            message:
              "Google could not confirm your verification email. Try again shortly or contact the venue.",
          });
        if (mail?.status !== "sent")
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
    const proof = body.verification
      ? verify(state, booking, String(body.verification))
      : null;
    if (bookingRegistrationClosed(booking))
      throw new RequestError(
        "The lineup and agreement are approved. Contact the venue to request a change.",
        409,
      );
    if (body.action === "act") {
      if (
        proof?.email !== booking.contactEmail &&
        !equals(bookingToken(contactBookingId(booking)), raw)
      )
        throw new RequestError(
          "Only the booking contact can change the act details.",
          403,
        );
      const contactPrivacyAcknowledgement = acknowledgePrivacy(
        body.privacyAcknowledged,
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
      const source = booking.sourceSignature
        ? JSON.parse(booking.sourceSignature)
        : null;
      Object.assign(booking, {
        contactPrivacyAcknowledgement,
        performance,
        expectedMembers: expected,
        fee: source?.fee > 0 ? source.fee : proposedFee,
        promotion: z
          .object({
            bio: z.string().trim().max(4000).default(""),
            photoUrl: z
              .string()
              .trim()
              .max(1000)
              .regex(/^(https?:\/\/[^\s]+)?$/)
              .default(""),
            website: z
              .string()
              .trim()
              .max(1000)
              .regex(/^(https?:\/\/[^\s]+)?$/)
              .default(""),
          })
          .parse(body.promotion ?? {}),
      });
    } else if (body.action === "register") {
      const privacyAcknowledgement = acknowledgePrivacy(
        body.privacyAcknowledged,
      );
      const input = musicianSchema.parse(body.profile);
      const paymentType = z
        .enum(["Cash", "Bank transfer", "Mobilepay"])
        .parse(input.preferredPaymentType);
      if (paymentType === "Mobilepay" && !input.phone.trim())
        throw new RequestError("Enter your Mobilepay phone number.");
      if (proof && input.email !== proof.email)
        throw new RequestError("Use your verified email address.", 403);
      // A shared booking link may create a profile, but never retrieve or
      // overwrite a previously saved musician's private/payment information.
      const member = booking.members.find((m) => m.email === input.email);
      const existing = proof
        ? state.musicians.find(
            (m) =>
              m.email.toLowerCase() === proof.email &&
              !m.deletedAt &&
              m.id !== member?.musicianId,
          ) || state.musicians.find((m) => m.id === member?.musicianId)
        : undefined;
      if (member && !proof)
        throw new RequestError(
          "Details have already been submitted for this email. Contact the venue for changes.",
          409,
        );
      if (
        !member &&
        booking.members.length >=
          (booking.performance ? booking.expectedMembers : 100)
      )
        throw new RequestError(
          "The lineup is full. Ask the band contact to update the member count.",
          409,
        );
      const at = new Date().toISOString();
      const profile = {
        ...existing,
        ...input,
        privacyAcknowledgement,
        deletedAt: undefined,
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
      const { registration, account, iban, phone, payee, cvr } = profile;
      const payout = { registration, account, iban, phone, payee, cvr };
      const { name, email, address, band } = profile;
      const performer = { name, email, address, phone, band, cvr, payee };
      if (member)
        Object.assign(member, {
          performer,
          payout,
          name: profile.name,
          musicianId: profile.id,
          privacyAcknowledgement,
          paymentType,
        });
      else
        booking.members.push({
          id: crypto.randomUUID(),
          musicianId: profile.id,
          privacyAcknowledgement,
          name: profile.name,
          email: profile.email,
          performer,
          payout,
          paymentType,
        });
    } else throw new RequestError("Unknown booking action.");
    // Any material artist change invalidates a draft version before company approval.
    booking.version++;
    const complete =
      booking.performance && booking.members.length === booking.expectedMembers;
    if (
      complete &&
      booking.artistFirst &&
      booking.fee &&
      venueSchema.safeParse(state.venue).success
    ) {
      issueBookingContracts(state, booking, booking, bookingSigningCredentials);
    } else if (
      complete &&
      !booking.artistFirst &&
      !state.bookingMail?.some(
        (m) =>
          m.id ===
          "approval:" + booking.id + ":" + (booking.sourceVersion || 1),
      )
    ) {
      state.bookingMail ??= [];
      state.bookingMail.push({
        id: "approval:" + booking.id + ":" + (booking.sourceVersion || 1),
        sourceVersion: booking.sourceVersion || 1,
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
    await writeState(
      state,
      booking.artistFirst ? { sheetBookingId: booking.id } : undefined,
    );
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
