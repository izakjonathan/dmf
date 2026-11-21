import { z } from "zod";
import {
  artistPerformanceSchema,
  date,
  dmfTemplate,
  money,
  paymentRecord,
  today,
  venueSchema,
  type ArtistPerformance,
  type Invite,
  type Musician,
  type Workspace,
} from "./model.ts";

export type BookingMember = {
  id: string;
  musicianId: string;
  email: string;
  name: string;
  contractId?: string;
  paymentType?: "Cash" | "Bank transfer" | "Mobilepay";
  performer?: Invite["performer"];
  payout?: Pick<
    Musician,
    "registration" | "account" | "iban" | "phone" | "payee" | "cvr"
  >;
  attendance?: "played" | "absent" | "issue";
  paymentId?: string;
};
export type Booking = {
  id: string;
  date: string;
  act: string;
  contactEmail: string;
  expectedMembers: number;
  fee: number;
  paymentType: "Cash" | "Bank transfer" | "Mobilepay";
  dueOn: string;
  cancelled?: boolean;
  version: number;
  approvedVersion?: number;
  approvedBy?: string;
  approvedAt?: string;
  performance?: ArtistPerformance;
  members: BookingMember[];
  confirmedAt?: string;
  confirmedBy?: string;
  attendanceNote?: string;
  inviteSentAt?: string;
  reminderAt?: string;
  sourceError?: string;
  sourceVersion?: number;
  sourceSignature?: string;
  operations?: {
    ticketPrice?: unknown;
    entranceIncome?: unknown;
    guestCount?: unknown;
    booker?: unknown;
    infoSent?: unknown;
    prReceived?: unknown;
    facebook?: unknown;
    website?: unknown;
    winterJazz?: unknown;
    instagram?: unknown;
  };
};
export type BookingMail = {
  id: string;
  bookingId: string;
  memberId?: string;
  sourceVersion?: number;
  to: string;
  subject: string;
  body: string;
  kind: "invitation" | "verification" | "contract" | "reminder" | "approval";
  status: "pending" | "sent" | "failed" | "uncertain" | "superseded";
  createdAt: string;
  sentAt?: string;
  error?: string;
};
export type BookingVerification = {
  id: string;
  bookingId: string;
  email: string;
  hash: string;
  expiresAt: string;
};
export function activeBooking(state: Workspace, id: string) {
  const booking = state.bookings?.find((item) => item.id === id);
  if (!booking || booking.cancelled)
    throw Error("This booking is unavailable or cancelled.");
  return booking;
}
export function contactBookingId(
  booking: Pick<Booking, "id" | "sourceVersion">,
) {
  return "contact:" + booking.id + ":" + (booking.sourceVersion || 1);
}
export function signingDeadline(performanceDate: string) {
  if (performanceDate > today()) return performanceDate;
  const next = new Date(today() + "T12:00:00Z");
  next.setUTCDate(next.getUTCDate() + 7);
  return next.toISOString().slice(0, 10);
}
export function pendingReason(
  state: Workspace,
  booking: Booking,
  member: BookingMember,
) {
  if (state.payments.some((p) => p.id === member.paymentId && !p.voidReason))
    return "Paid";
  if (booking.cancelled) return "Cancelled";
  if (booking.sourceError) return "Booking sheet needs attention";
  if (booking.confirmedAt && member.attendance === "absent")
    return "Artist absent";
  if (booking.approvedVersion !== booking.version)
    return "Company approval needed";
  const contract = state.contracts?.find(
    (item) =>
      item.id === member.contractId && item.bookingVersion === booking.version,
  );
  if (!contract) return "Artist signature needed";
  if (!booking.confirmedAt) return "Performance confirmation needed";
  if (!member.attendance) return "Attendance not recorded";
  if (member.attendance !== "played") return "Performance issue";
  return "Ready to pay";
}
export const approvalSchema = z.object({
  signer: z.string().trim().min(2).max(300),
  accepted: z.literal(true),
  fee: z.number().int().positive().max(100000000),
  dueOn: date,
  returnBy: date.optional(),
});
export function approveBooking(
  state: Workspace,
  id: string,
  input: unknown,
  signing: (id: string) => { hash: string; url: string },
) {
  const booking = activeBooking(state, id);
  if (booking.members.some((m) => m.paymentId))
    throw Error("A paid booking cannot be approved again.");
  if (booking.approvedVersion === booking.version)
    throw Error("This version is already approved.");
  if (booking.sourceError) throw Error(booking.sourceError);
  if (booking.members.length !== booking.expectedMembers)
    throw Error("Every expected musician must register before approval.");
  const performance = artistPerformanceSchema.parse(booking.performance);
  const inputValues = approvalSchema.parse(input);
  const returnBy = inputValues.returnBy || signingDeadline(booking.date);
  if (returnBy < today())
    throw Error("Choose a signing deadline of today or later.");
  const organizer = venueSchema.parse(state.venue);
  const at = new Date().toISOString();
  for (const old of state.invites)
    if (old.bookingId === id && !old.signedAt) old.revoked = true;
  const invites: Invite[] = [];
  for (const member of booking.members) {
    const musician = state.musicians.find((m) => m.id === member.musicianId);
    if (!musician) throw Error("A musician profile is missing.");
    const inviteId = crypto.randomUUID();
    const credentials = signing(inviteId);
    const { name, address, phone, band, cvr, payee } = musician;
    const invite: Invite = {
      id: inviteId,
      hash: credentials.hash,
      musicianId: musician.id,
      bookingId: id,
      bookingVersion: booking.version,
      memberId: member.id,
      expiresAt: returnBy + "T23:59:59.999Z",
      performer: member.performer || {
        name,
        email: member.email,
        address,
        phone,
        band,
        cvr,
        payee,
      },
      offer: {
        ...performance,
        getIn: "",
        specialTerms: "",
        artistPerformance: false,
        organizer: {
          name: organizer.name,
          legalName: organizer.legalName,
          address: organizer.address,
          cvr: organizer.cvr,
          email: organizer.email,
          phone: organizer.phone,
        },
        performanceDate: booking.date,
        fee: inputValues.fee,
        paymentType: member.paymentType || booking.paymentType,
        payOn: inputValues.dueOn,
        performerEmail: member.email,
        returnBy,
        organizerSigner: inputValues.signer,
        organizerSignedAt: at,
        template: dmfTemplate,
      },
    };
    member.contractId = inviteId;
    state.bookingMail ??= [];
    state.bookingMail.push({
      id: "contract:" + inviteId,
      bookingId: id,
      memberId: member.id,
      to: member.email,
      subject: "Contract to sign · " + booking.act + " · " + booking.date,
      body:
        "Please review and sign your contract for " +
        organizer.name +
        ".\n\n" +
        booking.act +
        " · " +
        booking.date +
        " · " +
        performance.start +
        "–" +
        performance.end +
        "\nFee: " +
        money(inputValues.fee) +
        "\nPayment due: " +
        inputValues.dueOn +
        "\n\n" +
        credentials.url +
        "\n\nSigning deadline: " +
        returnBy,
      kind: "contract",
      status: "pending",
      createdAt: at,
    });
    invites.push(invite);
  }
  state.invites.push(...invites);
  Object.assign(booking, {
    fee: inputValues.fee,
    dueOn: inputValues.dueOn,
    approvedVersion: booking.version,
    approvedBy: inputValues.signer,
    approvedAt: at,
  });
  return booking;
}
export function reissueBookingContract(
  state: Workspace,
  bookingId: string,
  memberId: string,
  returnBy: string,
  signing: (id: string) => { hash: string; url: string },
) {
  const booking = activeBooking(state, bookingId);
  if (booking.sourceError || booking.approvedVersion !== booking.version)
    throw Error("Approve the current booking before reissuing a contract.");
  const member = booking.members.find((m) => m.id === memberId);
  const previous = state.invites.find(
    (i) => i.id === member?.contractId && !i.revoked,
  );
  if (!member || !previous?.offer || previous.signedAt || member.paymentId)
    throw Error("Only unsigned contracts can be reissued.");
  if (date.parse(returnBy) < today())
    throw Error("Choose a signing deadline of today or later.");
  const id = crypto.randomUUID();
  const credentials = signing(id);
  const at = new Date().toISOString();
  previous.revoked = true;
  state.invites.push({
    ...previous,
    id,
    hash: credentials.hash,
    revoked: false,
    expiresAt: returnBy + "T23:59:59.999Z",
    emailSentAt: undefined,
    offer: { ...previous.offer, returnBy },
  });
  member.contractId = id;
  state.bookingMail ??= [];
  for (const mail of state.bookingMail) {
    if (
      mail.bookingId === booking.id &&
      mail.memberId === member.id &&
      (mail.kind === "contract" || mail.kind === "reminder")
    )
      mail.status = "superseded";
  }
  state.bookingMail.push({
    id: "contract:" + id,
    bookingId,
    memberId,
    to: member.email,
    subject: "Updated signing link · " + booking.act,
    body:
      "Please review and sign your agreement by " +
      returnBy +
      ".\n\n" +
      credentials.url,
    kind: "contract",
    status: "pending",
    createdAt: at,
  });
}
export const attendanceSchema = z.object({
  by: z.string().trim().min(2).max(300),
  note: z.string().trim().max(2000).default(""),
  members: z.array(
    z.object({
      id: z.string().uuid(),
      status: z.enum(["played", "absent", "issue"]),
    }),
  ),
});
export function confirmBooking(state: Workspace, id: string, input: unknown) {
  const booking = activeBooking(state, id);
  if (booking.date > today())
    throw Error("Confirm the performance on its date or afterwards.");
  if (booking.sourceError) throw Error(booking.sourceError);
  if (booking.members.some((member) => member.paymentId))
    throw Error("This booking already has processed payments.");
  const value = attendanceSchema.parse(input);
  const ids = new Set(value.members.map((m) => m.id));
  if (
    ids.size !== value.members.length ||
    ids.size !== booking.members.length ||
    !booking.members.every((m) => ids.has(m.id))
  )
    throw Error("The lineup changed. Refresh before confirming.");
  if (
    (value.members.some((m) => m.status !== "played") ||
      booking.members.length !== booking.expectedMembers) &&
    !value.note
  )
    throw Error(
      "Describe the exception or note who performed without registering.",
    );
  for (const member of booking.members)
    member.attendance = value.members.find((m) => m.id === member.id)!.status;
  booking.confirmedAt = new Date().toISOString();
  booking.confirmedBy = value.by;
  booking.attendanceNote = value.note;
}
export const paidSchema = z.object({
  members: z
    .array(
      z.object({ bookingId: z.string().uuid(), memberId: z.string().uuid() }),
    )
    .min(1)
    .max(100),
  paidOn: date,
  reference: z.string().trim().max(300).default(""),
  by: z.string().trim().min(2).max(300),
});
export function markBookingsPaid(state: Workspace, input: unknown) {
  const value = paidSchema.parse(input);
  if (value.paidOn > today())
    throw Error("The actual payment date cannot be in the future.");
  const seen = new Set<string>();
  const selected = value.members.map((item) => {
    const key = item.bookingId + ":" + item.memberId;
    if (seen.has(key)) throw Error("A musician was selected twice.");
    seen.add(key);
    const booking = activeBooking(state, item.bookingId);
    const member = booking.members.find((m) => m.id === item.memberId);
    if (!member || pendingReason(state, booking, member) !== "Ready to pay")
      throw Error("A selected payment is no longer ready. Refresh the list.");
    const contract = state.contracts!.find((c) => c.id === member.contractId)!;
    const payment = paymentRecord(state, {
      id: crypto.randomUUID(),
      musicianId: member.musicianId,
      paidOn: value.paidOn,
      performedOn: booking.date,
      band: booking.act,
      amount: contract.offer.fee,
      paymentType:
        contract.offer.paymentType || member.paymentType || booking.paymentType,
      kind: "Payment",
      reference: value.reference,
      notes: "Payment confirmed by " + value.by,
    });
    return { booking, member, payment };
  });
  for (const { booking, member, payment } of selected) {
    state.payments.push({
      ...payment,
      bookingId: booking.id,
      memberId: member.id,
    });
    member.paymentId = payment.id;
  }
}
export function isCurrentBookingMail(mail: BookingMail, booking: Booking) {
  return (
    mail.status !== "superseded" &&
    (!mail.sourceVersion ||
      mail.sourceVersion === (booking.sourceVersion || 1)) &&
    !/^(Booking changed\.|Signature no longer needed\.|Agreement is no longer awaiting signature\.)/.test(
      mail.error || "",
    )
  );
}

export function bookingOverview(state: Workspace) {
  return (state.bookings || []).map((booking) => ({
    ...booking,
    members: booking.members.map(
      ({ payout: _payout, performer: _performer, ...member }) => {
        const payment = state.payments.find(
          (p) => p.id === member.paymentId && !p.voidReason,
        );
        const contract = state.contracts?.find(
          (c) =>
            c.id === member.contractId && c.bookingVersion === booking.version,
        );
        const invite = state.invites.find(
          (i) => i.id === member.contractId && !i.revoked,
        );
        return {
          ...member,
          status: pendingReason(state, booking, member),
          paymentType:
            payment?.paymentType ||
            contract?.offer.paymentType ||
            member.paymentType ||
            booking.paymentType,
          amount: payment?.amount ?? contract?.offer.fee ?? booking.fee,
          signed: Boolean(contract),
          signingDeadline: invite?.offer?.returnBy,
        };
      },
    ),
    mail: (state.bookingMail || [])
      .filter(
        (mail) => mail.bookingId === booking.id && mail.kind !== "verification",
      )
      .map((mail) => ({
        id: mail.id,
        to: mail.to,
        kind: mail.kind,
        status: isCurrentBookingMail(mail, booking)
          ? mail.status
          : "superseded",
        error: mail.error,
        sentAt: mail.sentAt,
      })),
  }));
}
