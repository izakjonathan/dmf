import { z } from "zod";

const text = z.string().trim().max(300);
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const day = new Date(value + "T12:00:00Z");
    return !isNaN(day.valueOf()) && day.toISOString().slice(0, 10) === value;
  }, "Choose a valid date.");
export const venueSchema = z.object({
  name: text.min(1),
  legalName: text.min(1),
  address: text.min(5),
  cvr: z.string().regex(/^\d{8}$/, "Enter an eight-digit CVR."),
  email,
  phone: text,
  reference: text,
  collectCpr: z.boolean(),
});
export const musicianSchema = z
  .object({
    name: text.min(2),
    email,
    phone: text,
    address: text.min(5),
    band: text,
    payee: z.enum(["Individual", "Business"]),
    cvr: z.string().regex(/^(\d{8})?$/),
    cpr: z.string().regex(/^(\d{6}-?\d{4})?$/),
    registration: z
      .string()
      .regex(/^\d{4}$/, "Enter the four-digit bank registration number."),
    account: z
      .string()
      .regex(/^\d{6,10}$/, "Enter a bank account number with 6–10 digits."),
  })
  .refine(
    (value) => value.payee !== "Business" || value.cvr,
    "Enter the business CVR.",
  );
export const paymentSchema = z.object({
  id: z.string().uuid(),
  musicianId: z.string().uuid(),
  paidOn: date,
  performedOn: date,
  band: text,
  reference: text,
  amount: z.number().int().positive().max(100000000),
  kind: z.enum(["Payment", "Refund"]),
  notes: z.string().trim().max(2000),
});
export type Venue = z.infer<typeof venueSchema>;
export type Musician = z.infer<typeof musicianSchema> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
export type Payment = z.infer<typeof paymentSchema> & {
  name: string;
  venue: string;
  recordedAt: string;
  voidReason?: string;
  batchId?: string;
};
export type Invite = {
  id: string;
  hash: string;
  musicianId?: string;
  expiresAt: string;
  revoked?: boolean;
};
export type Workspace = {
  revision: number;
  venue: Venue;
  musicians: Musician[];
  payments: Payment[];
  invites: Invite[];
  auth?: { email: string; passwordHash: string };
  attempts?: { key: string; at: number }[];
};
export const empty = (): Workspace => ({
  revision: 0,
  venue: {
    name: "",
    legalName: "",
    address: "",
    cvr: "",
    email: "",
    phone: "",
    reference: "Live music fee",
    collectCpr: false,
  },
  musicians: [],
  payments: [],
  invites: [],
});
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Copenhagen",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const money = (øre: number) =>
  new Intl.NumberFormat("da-DK", {
    style: "currency",
    currency: "DKK",
    minimumFractionDigits: øre % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(øre / 100);
export const net = (p: Payment) =>
  p.voidReason ? 0 : p.kind === "Refund" ? -p.amount : p.amount;
export function isoWeek(date: string) {
  const day = new Date(date + "T12:00:00Z");
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const week = Math.ceil(
    ((day.valueOf() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7,
  );
  return year + "-W" + String(week).padStart(2, "0");
}
export function tariff(date: string) {
  if (date < "2026-04-01") return 0;
  return date >= "2027-04-01" ? 320000 : 315000;
}
export function paymentRecord(state: Workspace, input: unknown) {
  const payment = paymentSchema.parse(input);
  const musician = state.musicians.find(
    (item) => item.id === payment.musicianId,
  );
  if (!musician) throw Error("Select a registered musician.");
  if (
    state.payments.some(
      (item) => item.id === payment.id || item.batchId === payment.id,
    )
  )
    throw Error("This payment is already recorded.");
  const paid = state.payments
    .filter((item) => item.musicianId === musician.id)
    .reduce((sum, item) => sum + net(item), 0);
  if (payment.kind === "Refund" && payment.amount > paid)
    throw Error("The refund exceeds this musician’s net payments.");
  return {
    ...payment,
    name: musician.name,
    venue: state.venue.name,
    recordedAt: new Date().toISOString(),
  };
}
const bandPaymentSchema = paymentSchema.omit({ musicianId: true }).extend({
  target: z.literal("band"),
  band: text.min(1),
  kind: z.literal("Payment"),
  memberIds: z.array(z.string().uuid()).min(1),
});

export const bandKey = (band: string) =>
  band.trim().replace(/\s+/g, " ").toLowerCase();

export function paymentRecords(state: Workspace, input: unknown): Payment[] {
  if (
    !input ||
    typeof input !== "object" ||
    !("target" in input) ||
    input.target !== "band"
  )
    return [paymentRecord(state, input)];

  const { id, memberIds, ...details } = bandPaymentSchema.parse(input);
  if (
    state.payments.some(
      (payment) => payment.batchId === id || payment.id === id,
    )
  )
    throw Error("This band payment is already recorded.");
  const members = state.musicians.filter(
    (musician) => bandKey(musician.band) === bandKey(details.band),
  );
  const selected = new Set(memberIds);
  if (
    memberIds.length !== selected.size ||
    members.length !== selected.size ||
    !members.every(({ id }) => selected.has(id))
  )
    throw Error(
      "This band’s membership changed. Refresh before recording the payment.",
    );

  return members.map((musician) => ({
    ...paymentRecord(state, {
      ...details,
      band: members[0].band.trim(),
      id: crypto.randomUUID(),
      musicianId: musician.id,
    }),
    batchId: id,
  }));
}

export const musicianEditSchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string(),
  profile: musicianSchema,
});

export function updateMusician(
  state: Workspace,
  input: z.infer<typeof musicianEditSchema>,
) {
  const index = state.musicians.findIndex(({ id }) => id === input.id);
  const current = state.musicians[index];
  if (!current) return "Musician not found.";
  if (current.updatedAt !== input.updatedAt)
    return "This musician was updated elsewhere. Close and reopen their details.";
  if (
    state.musicians.some(
      ({ id, email }) =>
        id !== input.id && email.toLowerCase() === input.profile.email,
    )
  )
    return "That email is already registered to another musician.";

  state.musicians[index] = {
    ...current,
    ...input.profile,
    cpr: state.venue.collectCpr ? input.profile.cpr : current.cpr,
    updatedAt: new Date().toISOString(),
  };
  return null;
}

export function clientWorkspace(state: Workspace) {
  return {
    revision: state.revision,
    venue: state.venue,
    payments: state.payments,
    invites: state.invites.map(({ hash, ...invite }) => invite),
    musicians: state.musicians.map(
      ({ cpr, registration, account, ...musician }) => musician,
    ),
  };
}
export type ClientWorkspace = ReturnType<typeof clientWorkspace>;
export function demoWorkspace(): Workspace {
  const state = empty();
  state.venue = {
    ...state.venue,
    name: "The Listening Room",
    legalName: "Example Venue ApS",
    address: "Example Street 12, Copenhagen",
    cvr: "12345678",
    email: "venue@example.com",
  };
  for (const [name, band, number] of [
    ["Sofie Lund", "Sofie Lund Trio", 1],
    ["Emil Berg", "Sofie Lund Trio", 2],
    ["Clara Voss", "Clara Voss", 3],
    ["Noah Jensen", "After Hours", 4],
  ] as const) {
    const id = "00000000-0000-4000-8000-00000000000" + number;
    state.musicians.push({
      id,
      name,
      band,
      email: "musician" + number + "@example.com",
      phone: "",
      address: "Example address",
      payee: "Individual",
      cpr: "",
      cvr: "",
      account: "0000000000",
      registration: "0000",
      createdAt: "2026-11-01",
      updatedAt: "2026-11-01",
    });
    state.payments.push({
      id: "example-" + number,
      musicianId: id,
      name,
      venue: state.venue.name,
      band,
      paidOn: "2026-11-06",
      performedOn: "2026-11-05",
      reference: "Example transfer",
      amount: 315000,
      kind: "Payment",
      notes: "",
      recordedAt: "2026-11-06",
    });
  }
  return state;
}
