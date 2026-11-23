import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { acknowledgePrivacy, privacyNoticeVersion } from "../lib/privacy.ts";

const script = readFileSync(
  new URL("../public/Code.gs", import.meta.url),
  "utf8",
);
const musicianId = "11111111-1111-4111-8111-111111111111";
const bookingId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";
const record = () => ({
  musicians: [
    {
      id: musicianId,
      name: "Sample Musician",
      email: "sample@example.test",
      phone: "12345678",
      account: "9876543210",
      iban: "DK0000000000000000",
      mobilePayNumber: "87654321",
      cpr: "0101010000",
      createdAt: "2019-01-01",
    },
  ],
  bookings: [
    {
      id: bookingId,
      act: "Sample Musician",
      date: "2020-06-10",
      contactEmail: "sample@example.test",
      sourceSignature: "original inputs",
      members: [
        {
          id: memberId,
          musicianId,
          name: "Sample Musician",
          email: "sample@example.test",
          payout: { account: "9876543210" },
          privacyAcknowledgement: acknowledgePrivacy("on"),
        },
      ],
    },
  ],
  contracts: [
    {
      id: "contract-one",
      musicianId,
      performer: { name: "Sample Musician", payee: "Individual" },
      performerSigner: "Sample Musician",
      offer: {
        performanceDate: "2020-06-10",
        performerEmail: "sample@example.test",
        organizerSigner: "Sample Organizer",
      },
    },
  ],
  payments: [
    {
      id: "one",
      musicianId,
      name: "Sample Musician",
      paidOn: "2020-06-11",
      amount: 315000,
    },
  ],
  invites: [{ musicianId, offer: { performanceDate: "2020-06-10" } }],
  bookingMail: [
    { id: "one", bookingId, to: "sample@example.test", body: "private url" },
  ],
  bookingVerifications: [
    { bookingId, email: "sample@example.test", hash: "proof" },
  ],
});

test("privacy acknowledgement requires the submitted checkbox and records the active version", () => {
  assert.throws(() => acknowledgePrivacy(undefined));
  assert.throws(() => acknowledgePrivacy(true));
  assert.equal(acknowledgePrivacy("on").version, privacyNoticeVersion);
  assert.ok(
    Number.isFinite(Date.parse(acknowledgePrivacy("on").acknowledgedAt)),
  );
});

test("retention dry run logs counts only and leaves records and workbook untouched", () => {
  const state = record();
  const copy = structuredClone(state);
  const messages: string[] = [];
  const result = runInNewContext(
    script +
      `
    readStoredState = () => state;
    writeWorkbook = () => { throw Error("Dry run attempted to write"); };
    dryRunStagebookRetention();
  `,
    {
      state,
      console: { info: (value: string) => messages.push(value) },
      PropertiesService: {
        getScriptProperties: () => ({ getProperty: () => null }),
      },
      LockService: {
        getScriptLock: () => ({ waitLock() {}, releaseLock() {} }),
      },
      SpreadsheetApp: { openById: () => ({}) },
      Utilities: { formatDate: () => "2026-01-01" },
    },
  );
  assert.equal(result.musicians, 1);
  assert.deepEqual(state, copy);
  assert.deepEqual(JSON.parse(messages[0]), {
    musicians: 1,
    bookings: 1,
    members: 1,
    contracts: 1,
    payments: 1,
    emails: 1,
    deferred: 0,
  });
});

test("retention holds the cutoff year and removes copied identifiers when eligible", () => {
  const state = record();
  const result = runInNewContext(
    script +
      `
    const beforeBoundary = retentionPlan(state,2020).counts.musicians;
    anonymiseRetainedMusicians(state,retentionPlan(state,2021),"2026-01-01");
    ({ beforeBoundary, repeat: retentionPlan(state,2021).counts.musicians });
  `,
    { state },
  );
  assert.equal(result.beforeBoundary, 0);
  assert.equal(result.repeat, 0);
  assert.equal(state.payments[0].amount, 315000);
  assert.equal(state.bookings[0].date, "2020-06-10");
  assert.doesNotMatch(
    JSON.stringify(state),
    /sample@example|Sample Musician|Sample Organizer|9876543210|DK000|0101010000|87654321|private url|original inputs/i,
  );
});

test("audit rows contain event labels and IDs, not copied personal details", () => {
  const state = record();
  const rows = runInNewContext(
    script +
      `
    state.musicians[0].privacyAcknowledgement = state.bookings[0].members[0].privacyAcknowledgement;
    state.bookings[0].contactPrivacyAcknowledgement = state.musicians[0].privacyAcknowledgement;
    state.bookings[0].confirmedAt = "2020-06-11";
    state.bookings[0].confirmedBy = "person@example.test";
    bookingAuditChanges(null,state,true);
  `,
    { state },
  );
  const actions = new Set(Array.from(rows, (row: string[]) => row[1]));
  for (const action of [
    "Booking created",
    "Contact form submitted",
    "Musician form submitted",
    "Attendance recorded",
    "Musician signed contract",
    "Payment recorded",
  ])
    assert.ok(actions.has(action), action);
  assert.doesNotMatch(
    JSON.stringify(rows),
    /example\.test|9876543210|private url|proof/,
  );
  assert.equal(
    (rows as string[][]).find((row) => row[1] === "Attendance recorded")?.[2],
    "staff",
  );
});

test("sensitive migration externalises profile and booking payout, supports masked and audited views", () => {
  const state = record();
  Object.assign(state.musicians[0], { preferredPaymentType: "Mobilepay" });
  const privateRows: string[][] = [];
  let auditWrites = 0;
  const props = {
    getProperty: (key: string) => (key === "SENSITIVE_MIGRATED" ? "true" : ""),
  };
  const result = runInNewContext(
    script +
      `
    const storage = {book:{getId:()=>"private"},sheet:{getSheetId:()=>1}};
    sensitiveStorage = () => storage;
    sensitiveRows = () => privateRows;
    bookingHmac = message => hash(message);
    auditAppend = () => ({audit:true});
    persistSensitive(state,props,true);
    const privateCount = privateRows.length;
    persistSensitive(state,props,true);
    const masked = sensitiveView(main,state,{musicianId:state.musicians[0].id},props).records[0];
    const full = sensitiveView(main,state,{musicianId:state.musicians[0].id,mode:"reveal"},props).records[0];
    ({ masked, full, privateCount, project: rowsFor({...state,venue:{},bookings:[],contracts:[],bookingMail:[],payments:[]}) });
  `,
    {
      state,
      props,
      privateRows,
      main: { getId: () => "main" },
      hash: (s: string) => createHash("sha256").update(s).digest("hex"),
      Sheets: {
        Spreadsheets: {
          batchUpdate({ requests }: any, id: string) {
            if (id === "main") {
              auditWrites++;
              return;
            }
            for (const req of requests)
              privateRows.push(
                ...req.appendCells.rows.map((row: any) =>
                  row.values.map((v: any) => v.userEnteredValue.stringValue),
                ),
              );
          },
        },
      },
    },
  );
  assert.equal(privateRows.length, result.privateCount);
  assert.ok(privateRows.length >= 1);
  assert.equal(result.masked.account, "••••3210");
  assert.equal(result.masked.cpr, "••••0000");
  assert.equal(result.full.mobilePayNumber, "87654321");
  assert.equal(auditWrites, 1);
  assert.doesNotMatch(
    JSON.stringify({ state, projection: result.project }),
    /9876543210|0101010000|DK000000|87654321/,
  );
});
