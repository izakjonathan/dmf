import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  clientWorkspace,
  paymentContractSchema,
  dmfTemplate,
  demoWorkspace,
  isoWeek,
  musicianEditSchema,
  musicianSchema,
  paymentRecord,
  paymentRecords,
  performerSignatureSchema,
  tariff,
  updateMusician,
} from "../lib/model.ts";
test("a payment attaches directly to a registered musician and keeps its band and venue", () => {
  const state = demoWorkspace();
  const musician = state.musicians[0];
  const p = paymentRecord(state, {
    id: crypto.randomUUID(),
    musicianId: musician.id,
    paidOn: "2027-01-02",
    performedOn: "2026-12-31",
    band: "Original band",
    reference: "Bank",
    amount: 315050,
    kind: "Payment",
    notes: "",
  });
  assert.equal(p.venue, state.venue.name);
  assert.equal(p.band, "Original band");
  assert.equal(p.amount, 315050);
  state.payments.push(p);
  assert.throws(() => paymentRecord(state, p), /already recorded/);
  assert.throws(
    () =>
      paymentRecord(state, {
        ...p,
        id: crypto.randomUUID(),
        kind: "Refund",
        amount: 10000000,
      }),
    /exceeds/,
  );
});
test("reports handle ISO week years and the tariff change", () => {
  assert.equal(isoWeek("2027-01-02"), "2026-W53");
  assert.equal(tariff("2027-03-31"), 315000);
  assert.equal(tariff("2027-04-01"), 320000);
});
test("workspace responses omit sensitive account and authentication values", () => {
  const state = demoWorkspace();
  state.auth = { email: "example@example.com", passwordHash: "internal" };
  state.musicians[0].account = "0000000000";
  state.musicians[0].iban = "DK5000400440116243";
  const safe = clientWorkspace(state);
  assert.equal("auth" in safe, false);
  assert.equal("account" in safe.musicians[0], false);
  assert.equal("iban" in safe.musicians[0], false);
});
test("Apps Script produces matching totals and retains account numbers as strings", () => {
  const context = { state: demoWorkspace(), result: null as any };
  context.state.musicians[0].account = "0000000000";
  const script = readFileSync(
    new URL("../public/Code.gs", import.meta.url),
    "utf8",
  );
  runInNewContext(script + "\nresult = rowsFor(state);", context);
  assert.equal(context.result.Musicians[1][10], "0000000000");
  assert.equal(context.result.Payments[1][8], 3150);
  const weekly = context.result.Summary.find(
    (row: unknown[]) => row[0] === "Week",
  );
  assert.equal(weekly[1], isoWeek("2026-11-06"));
  assert.equal(weekly[2], 12600);
});

test("a band payment records the full amount for each member and rejects stale or repeated submissions", () => {
  const state = demoWorkspace();
  const [first, second, third] = state.musicians;
  second.band = "  sofie lund   trio ";
  const input = {
    target: "band",
    id: crypto.randomUUID(),
    memberIds: [first.id, second.id],
    paidOn: "2026-11-11",
    performedOn: "2026-11-11",
    band: first.band,
    reference: "",
    amount: 315000,
    kind: "Payment",
    notes: "",
  };
  assert.throws(
    () => paymentRecords(state, { ...input, memberIds: [first.id, third.id] }),
    /membership changed/,
  );
  assert.equal(state.payments.length, 4);
  const batch = paymentRecords(state, input);
  assert.deepEqual(
    batch.map((payment) => payment.musicianId),
    input.memberIds,
  );
  assert.ok(
    batch.every(
      (payment) => payment.batchId === input.id && payment.band === first.band,
    ),
  );
  assert.equal(new Set(batch.map((payment) => payment.id)).size, 2);
  assert.equal(
    batch.reduce((total, payment) => total + payment.amount, 0),
    630000,
  );
  state.payments.push(...batch);
  assert.throws(() => paymentRecords(state, input), /already recorded/);
  assert.throws(
    () =>
      paymentRecords(state, {
        ...input,
        target: undefined,
        musicianId: first.id,
      }),
    /already recorded/,
  );
});

test("musician edits preserve historical payments and hidden CPR, and reject duplicate emails", () => {
  const state = demoWorkspace();
  const [first, second] = state.musicians;
  first.cpr = "0101010000";
  const edit = musicianEditSchema.parse({
    id: first.id,
    updatedAt: first.updatedAt,
    profile: { ...first, name: "Updated name", band: "New band", cpr: "" },
  });
  assert.match(
    updateMusician(state, {
      ...edit,
      profile: { ...edit.profile, email: second.email },
    }) || "",
    /already registered/,
  );
  assert.equal(updateMusician(state, edit), null);
  assert.equal(state.musicians[0].name, "Updated name");
  assert.equal(state.musicians[0].id, first.id);
  assert.equal(state.musicians[0].cpr, first.cpr);
  assert.equal(state.payments[0].name, first.name);
  assert.equal(state.payments[0].band, first.band);
  assert.match(updateMusician(state, edit) || "", /updated elsewhere/);
});

test("registration accepts either Danish bank details or a normalized IBAN", () => {
  const [profile] = demoWorkspace().musicians;
  assert.equal(musicianSchema.parse(profile).registration, "0000");
  const international = {
    ...profile,
    registration: "",
    account: "",
    iban: "dk50 0040 0440 1162 43",
  };
  const parsed = musicianSchema.parse(international);
  assert.equal(parsed.iban, "DK5000400440116243");
  assert.equal(parsed.registration, "");
  assert.throws(
    () =>
      musicianSchema.parse({ ...international, iban: "DK5000400440116244" }),
    /valid IBAN/,
  );
  assert.throws(
    () => musicianSchema.parse({ ...international, account: "0000000000" }),
    /either IBAN or Danish/,
  );
});

test("payment contract fields require explicit organizer and musician acceptance", () => {
  const terms = {
    returnBy: "2026-12-04",
    start: "22:00",
    end: "00:00",
    sets: "2",
    minutesPerSet: "45",
    organizerSigner: "Organizer Test",
  };
  assert.throws(() => paymentContractSchema.parse(terms), /Confirm/);
  assert.equal(
    paymentContractSchema.parse({ ...terms, accepted: "on" }).sets,
    2,
  );
  assert.throws(
    () =>
      paymentContractSchema.parse({
        ...terms,
        end: terms.start,
        accepted: "on",
      }),
    /different/,
  );
  assert.throws(
    () =>
      performerSignatureSchema.parse({
        name: "Musician Test",
        version: dmfTemplate.version,
      }),
    /Confirm/,
  );
  assert.equal(
    performerSignatureSchema.parse({
      name: "Musician Test",
      accepted: "on",
      version: dmfTemplate.version,
    }).name,
    "Musician Test",
  );
});

test("the Apps Script sends once per contract and respects the remaining daily email quota", () => {
  const state = demoWorkspace();
  const [payment, second] = state.payments;
  const mail: object[] = [];
  const properties = new Map<string, string>();
  const props = {
    getProperty: (key: string) => properties.get(key),
    setProperty: (key: string, value: string) => properties.set(key, value),
    deleteProperty: (key: string) => properties.delete(key),
  };
  const makeInvite = (id: string, paymentId: string, recipient: string) => ({
    id,
    paymentId,
    offer: {
      performerEmail: recipient,
      returnBy: "2026-12-01",
      performanceDate: "2026-11-30",
      organizer: state.venue,
    },
  });
  const first = makeInvite("first", payment.id, "artist@example.com");
  const next = makeInvite("next", second.id, "next@example.com");
  const result = runInNewContext(
    readFileSync(new URL("../public/Code.gs", import.meta.url), "utf8") +
      `
      writeWorkbook = () => {};
      const initial = emailContracts({}, state, links, props);
      const retry = emailContracts({}, state, links, props);
      [initial.delivery, retry.delivery];
    `,
    {
      state: { ...state, invites: [first, next] },
      props,
      links: [first, next].map(({ id }) => ({
        id,
        url: "https://dmf-eta.vercel.app/register/" + "a".repeat(64),
      })),
      Utilities: { formatDate: () => "2026-11-11" },
      MailApp: {
        getRemainingDailyQuota: () => Math.max(0, 1 - mail.length),
        sendEmail: (message: object) => mail.push(message),
      },
    },
  );
  assert.equal(mail.length, 1);
  assert.equal(result[0].sent, 1);
  assert.equal(result[0].failed, 1);
  assert.equal(result[1].sent, 1);
  assert.equal(result[1].failed, 1);
  assert.equal(properties.size, 0);
});
