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

test("contract email reports known rejections and allows retry without clearing uncertain sends", () => {
  const state = demoWorkspace();
  const payment = state.payments[0];
  const properties = new Map<string, string>();
  const props = {
    getProperty: (key: string) => properties.get(key),
    setProperty: (key: string, value: string) => properties.set(key, value),
    deleteProperty: (key: string) => properties.delete(key),
  };
  const warnings: string[] = [];
  let failure = "You do not have permission to call MailApp.sendEmail";
  let attempts = 0;
  const invite = {
    id: "first",
    paymentId: payment.id,
    offer: {
      performerEmail: "artist@example.com",
      returnBy: "2026-12-01",
      performanceDate: "2026-11-30",
      organizer: state.venue,
    },
  };
  const context = {
    state: { ...state, invites: [invite] },
    props,
    links: [
      {
        id: invite.id,
        url: "https://dmf-eta.vercel.app/register/" + "a".repeat(64),
      },
    ],
    Utilities: { formatDate: () => "2026-11-11" },
    console: { warn: (message: string) => warnings.push(message) },
    MailApp: {
      getRemainingDailyQuota: () => 1,
      sendEmail: () => {
        attempts++;
        if (failure) throw Error(failure);
      },
    },
  };
  runInNewContext(
    readFileSync(new URL("../public/Code.gs", import.meta.url), "utf8") +
      "\nwriteWorkbook = () => {};",
    context,
  );
  assert.equal(
    runInNewContext(
      "emailContracts({}, state, links, props).delivery.issues[0]",
      context,
    ),
    "MAIL_PERMISSION",
  );
  assert.equal(properties.size, 0);
  failure = "Unexpected transport failure";
  assert.equal(
    runInNewContext(
      "emailContracts({}, state, links, props).delivery.issues[0]",
      context,
    ),
    "MAIL_UNCERTAIN",
  );
  assert.equal(properties.size, 1);
  failure = "";
  assert.equal(
    runInNewContext(
      "emailContracts({}, state, links, props).delivery.issues[0]",
      context,
    ),
    "MAIL_UNCERTAIN",
  );
  assert.equal(attempts, 2);
  assert.ok(warnings.some((message) => message.includes("MAIL_PERMISSION")));
});

test("Sheets sync writes numeric dates, times and DKK while keeping custom formats", () => {
  const state = demoWorkspace();
  state.payments[0].recordedAt = "2026-11-11T23:30:45.000Z";
  let captured: unknown[] = [];
  const requests = runInNewContext(
    readFileSync(new URL("../public/Code.gs", import.meta.url), "utf8") +
      `
      writeWorkbook(book, state);
      output;
    `,
    {
      state,
      book: {
        getId: () => "book",
        getSpreadsheetTimeZone: () => "Europe/Copenhagen",
        getSheetByName: (name: string) => ({
          getSheetId: () =>
            [
              "Venue",
              "Musicians",
              "Payments",
              "Summary",
              "Contracts",
              "_Stagebook",
            ].indexOf(name) + 1,
          getMaxRows: () => 1000,
          getLastRow: () => 0,
        }),
      },
      Utilities: {
        Charset: { UTF_8: "UTF-8" },
        base64Encode: (value: string) => Buffer.from(value).toString("base64"),
        formatDate: (_instant: Date, timeZone: string) => {
          assert.equal(timeZone, "Europe/Copenhagen");
          return "2026-11-12T00:30:45.000";
        },
      },
      Sheets: {
        Spreadsheets: {
          get: (_id: string, options: { ranges: string[] }) => {
            assert.ok(options.ranges.includes("Payments!F2:F5"));
            return {
              sheets: [
                {
                  properties: { title: "Payments" },
                  data: [
                    {
                      startRow: 1,
                      startColumn: 5,
                      rowData: [
                        {
                          values: [
                            {
                              userEnteredFormat: {
                                numberFormat: {
                                  type: "DATE",
                                  pattern: "yyyy/mm/dd",
                                },
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            };
          },
          batchUpdate: (value: { requests: unknown[] }) => {
            captured = value.requests;
          },
        },
      },
      get output() {
        return captured;
      },
    },
  );
  function dateSerial(iso: string) {
    return Date.parse(iso) / 86400000 + 25569;
  }
  const values = requests.find(
    (request: any) => request.updateCells?.range.sheetId === 3,
  ).updateCells.rows[1].values;
  assert.equal(
    values[5].userEnteredValue.numberValue,
    dateSerial("2026-11-06T00:00:00Z"),
  );
  assert.equal(values[7].userEnteredValue.numberValue, 3150);
  assert.equal(
    values[13].userEnteredValue.numberValue,
    dateSerial("2026-11-12T00:30:45Z"),
  );
  const numberFormats = requests
    .filter(
      (request: any) =>
        request.repeatCell?.fields === "userEnteredFormat.numberFormat",
    )
    .map((request: any) => request.repeatCell);
  assert.ok(
    numberFormats.some(
      (request: any) =>
        request.range.sheetId === 3 &&
        request.range.startColumnIndex === 5 &&
        request.range.startRowIndex === 2 &&
        request.cell.userEnteredFormat.numberFormat.pattern === "dd-mm-yyyy",
    ),
  );
  assert.ok(
    !numberFormats.some(
      (request: any) =>
        request.range.sheetId === 3 &&
        request.range.startColumnIndex === 5 &&
        request.range.startRowIndex === 1,
    ),
  );
  assert.ok(
    numberFormats.some(
      (request: any) =>
        request.range.sheetId === 3 &&
        request.range.startColumnIndex === 7 &&
        request.cell.userEnteredFormat.numberFormat.type === "CURRENCY",
    ),
  );
  const conversion = runInNewContext(
    readFileSync(new URL("../public/Code.gs", import.meta.url), "utf8") +
      '\n[sheetValue("21:30",TIME_FORMAT),sheetValue("First working day after performance",DATE_FORMAT),sheetValue("0000")]',
  );
  assert.equal(conversion[0].numberValue, 1290 / 1440);
  assert.equal(
    conversion[1].stringValue,
    "First working day after performance",
  );
  assert.equal(conversion[2].stringValue, "0000");
});
