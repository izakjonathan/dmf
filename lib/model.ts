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
export function validIban(iban: string) {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  let remainder = 0;
  for (const character of iban.slice(4) + iban.slice(0, 4)) {
    const code = character.charCodeAt(0);
    remainder =
      code >= 65
        ? (remainder * 100 + code - 55) % 97
        : (remainder * 10 + code - 48) % 97;
  }
  return remainder === 1;
}

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
    registration: z.string().default(""),
    account: z.string().default(""),
    iban: z
      .string()
      .max(100)
      .default("")
      .transform((value) => value.replace(/\s+/g, "").toUpperCase()),
  })
  .superRefine((value, ctx) => {
    function issue(path: string, message: string) {
      ctx.addIssue({ code: "custom", path: [path], message });
    }
    if (value.payee === "Business" && !value.cvr)
      issue("cvr", "Enter the business CVR.");
    if (value.iban) {
      if (!validIban(value.iban)) issue("iban", "Enter a valid IBAN.");
      if (value.registration || value.account)
        issue("iban", "Choose either IBAN or Danish bank details.");
      return;
    }
    if (!/^\d{4}$/.test(value.registration))
      issue("registration", "Enter the four-digit bank registration number.");
    if (!/^\d{6,10}$/.test(value.account))
      issue("account", "Enter a bank account number with 6–10 digits.");
  });

export const dmfTemplate = {
  version: "dmf-standardkontrakt-red-2019",
  url: "https://dmf.dk/sites/default/files/paragraph/field_files/Standardkontrakt%20R%C3%98D.pdf",
} as const;

const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a valid time.");
const accepted = z.literal("on", {
  message: "Confirm that you agree to the contract.",
});
export const paymentContractSchema = z
  .object({
    start: clock,
    end: clock,
    getIn: z.union([clock, z.literal("")]).default(""),
    soundcheck: z.union([clock, z.literal("")]).default(""),
    sets: z.coerce.number().int().min(1).max(30),
    minutesPerSet: z.coerce.number().int().min(1).max(720),
    returnBy: date,
    specialTerms: z.string().trim().max(2000).default(""),
    organizerSigner: text.min(2, "Enter the organizer signer’s full name."),
    accepted,
  })
  .refine(
    (value) => value.start !== value.end,
    "Enter different start and end times.",
  );

export const performerSignatureSchema = z.object({
  name: text.min(2, "Enter your full name to sign."),
  accepted,
  version: z.literal(dmfTemplate.version),
});

export type ContractOffer = Omit<
  z.infer<typeof paymentContractSchema>,
  "accepted"
> & {
  performerEmail: string;
  performanceDate: string;
  fee: number;
  payOn: string;
  organizer: Pick<
    Venue,
    "name" | "legalName" | "address" | "cvr" | "email" | "phone"
  >;
  organizerSignedAt: string;
  template: typeof dmfTemplate;
};

export type SignedContract = {
  id: string;
  paymentId?: string;
  musicianId: string;
  offer: ContractOffer;
  performer: Pick<
    Musician,
    "name" | "email" | "address" | "phone" | "band" | "cvr" | "payee"
  >;
  performerSigner: string;
  performerSignedAt: string;
};

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
export type Musician = Omit<z.infer<typeof musicianSchema>, "iban"> & {
  iban?: string;
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
  offer?: ContractOffer;
  signedAt?: string;
  registration?: true;
  paymentId?: string;
  performer?: SignedContract["performer"];
  emailSentAt?: string;
};
export type Workspace = {
  revision: number;
  venue: Venue;
  musicians: Musician[];
  payments: Payment[];
  invites: Invite[];
  contracts?: SignedContract[];
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
    invites: state.invites.map(({ hash, offer, performer, ...invite }) => ({
      ...invite,
      performanceDate: offer?.performanceDate,
      performerEmail: offer?.performerEmail,
    })),
    contracts: (state.contracts ?? []).map((contract) => ({
      id: contract.id,
      performer: contract.performer.name,
      date: contract.offer.performanceDate,
    })),
    musicians: state.musicians.map(
      ({ cpr, registration, account, iban, ...musician }) => musician,
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
