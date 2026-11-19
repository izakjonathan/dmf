import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  approveBooking,
  confirmBooking,
  markBookingsPaid,
  pendingReason,
  type Booking,
} from "../lib/bookings.ts";
import { demoWorkspace, today } from "../lib/model.ts";
function fixture() {
  const state = demoWorkspace();
  state.venue.phone = "+4512345678";
  const booking: Booking = {
    id: crypto.randomUUID(),
    date: today(),
    act: "Sofie Lund Trio",
    contactEmail: state.musicians[0].email,
    expectedMembers: 2,
    fee: 315000,
    paymentType: "Bank transfer",
    dueOn: today(),
    version: 1,
    members: state.musicians.slice(0, 2).map((m) => ({
      id: crypto.randomUUID(),
      musicianId: m.id,
      name: m.name,
      email: m.email,
    })),
    performance: {
      start: "21:00",
      end: "00:00",
      sets: 2,
      minutesPerSet: 45,
      soundcheck: "Yes",
      requests: "Microphone",
    },
  };
  state.bookings = [booking];
  return { state, booking };
}
function approve(state: ReturnType<typeof demoWorkspace>, booking: Booking) {
  return approveBooking(
    state,
    booking.id,
    { signer: "Venue Owner", accepted: true, fee: 315000, dueOn: today() },
    (id) => ({ hash: id, url: "https://example.com/" + id }),
  );
}
function sign(state: ReturnType<typeof demoWorkspace>, booking: Booking) {
  state.contracts = state.invites
    .filter((i) => i.bookingId === booking.id)
    .map((i) => ({
      id: i.id,
      bookingId: booking.id,
      bookingVersion: booking.version,
      musicianId: i.musicianId!,
      memberId: i.memberId,
      offer: i.offer!,
      performer: i.performer!,
      performerSigner: i.performer!.name,
      performerSignedAt: new Date().toISOString(),
    }));
}
test("company approval creates individual immutable agreements and queues each email once", () => {
  const { state, booking } = fixture();
  approve(state, booking);
  assert.equal(state.invites.length, 2);
  assert.equal(state.bookingMail?.length, 2);
  assert.equal(state.invites[0].offer?.start, "21:00");
  assert.equal(state.invites[0].offer?.fee, 315000);
  assert.equal(state.invites[0].offer?.artistPerformance, false);
  assert.throws(() => approve(state, booking), /already approved/);
  assert.equal(state.bookingMail?.length, 2);
  booking.performance!.start = "22:00";
  assert.equal(state.invites[0].offer?.start, "21:00");
});
test("approval waits for the complete lineup and schedule", () => {
  const { state, booking } = fixture();
  booking.expectedMembers = 3;
  assert.throws(() => approve(state, booking), /Every expected musician/);
  booking.expectedMembers = 2;
  booking.performance = undefined;
  assert.throws(() => approve(state, booking));
  assert.equal(state.invites.length, 0);
});
test("signed and performed bookings enter the queue, and only processed payments enter history", () => {
  const { state, booking } = fixture();
  const count = state.payments.length;
  approve(state, booking);
  assert.equal(state.payments.length, count);
  assert.equal(
    pendingReason(state, booking, booking.members[0]),
    "Artist signature needed",
  );
  sign(state, booking);
  assert.equal(
    pendingReason(state, booking, booking.members[0]),
    "Performance confirmation needed",
  );
  confirmBooking(state, booking.id, {
    by: "Night Employee",
    members: booking.members.map((m) => ({ id: m.id, status: "played" })),
  });
  assert.equal(
    pendingReason(state, booking, booking.members[0]),
    "Ready to pay",
  );
  const input = {
    by: "Venue Owner",
    paidOn: today(),
    members: booking.members.map((m) => ({
      bookingId: booking.id,
      memberId: m.id,
    })),
  };
  markBookingsPaid(state, input);
  assert.equal(state.payments.length, count + 2);
  assert.ok(
    state.payments
      .slice(-2)
      .every(
        (p) =>
          p.amount === 315000 &&
          p.paymentType === "Bank transfer" &&
          p.bookingId === booking.id,
      ),
  );
  assert.equal(pendingReason(state, booking, booking.members[0]), "Paid");
  assert.throws(() => markBookingsPaid(state, input), /no longer ready/);
  assert.equal(state.payments.length, count + 2);
});
test("a partial band payment fails atomically if any selected musician is not ready", () => {
  const { state, booking } = fixture();
  approve(state, booking);
  sign(state, booking);
  confirmBooking(state, booking.id, {
    by: "Night Employee",
    note: "Second musician absent",
    members: booking.members.map((m, i) => ({
      id: m.id,
      status: i ? "absent" : "played",
    })),
  });
  const count = state.payments.length;
  assert.throws(
    () =>
      markBookingsPaid(state, {
        by: "Owner",
        paidOn: today(),
        members: booking.members.map((m) => ({
          bookingId: booking.id,
          memberId: m.id,
        })),
      }),
    /no longer ready/,
  );
  assert.equal(state.payments.length, count);
  assert.ok(booking.members.every((m) => !m.paymentId));
});
test("future dates, stale lineups, missing exception notes and cancelled bookings cannot be confirmed", () => {
  const { state, booking } = fixture();
  approve(state, booking);
  const input = {
    by: "Employee",
    members: booking.members.map((m) => ({ id: m.id, status: "played" })),
  };
  booking.date = "2099-01-01";
  assert.throws(() => confirmBooking(state, booking.id, input), /on its date/);
  booking.date = today();
  assert.throws(
    () =>
      confirmBooking(state, booking.id, {
        ...input,
        members: input.members.slice(1),
      }),
    /lineup changed/,
  );
  assert.throws(
    () =>
      confirmBooking(state, booking.id, {
        ...input,
        members: input.members.map((m) => ({ ...m, status: "issue" })),
      }),
    /Describe/,
  );
  booking.cancelled = true;
  assert.throws(() => confirmBooking(state, booking.id, input), /cancelled/);
});
test("a revised or invalid booking holds payments even with a previous signature", () => {
  const { state, booking } = fixture();
  approve(state, booking);
  sign(state, booking);
  booking.version++;
  assert.equal(
    pendingReason(state, booking, booking.members[0]),
    "Company approval needed",
  );
  booking.sourceError = "Invalid sheet input";
  assert.equal(
    pendingReason(state, booking, booking.members[0]),
    "Booking sheet needs attention",
  );
});
const script = readFileSync(
  new URL("../public/Code.gs", import.meta.url),
  "utf8",
);
function sheetFixture(rows: unknown[][]) {
  const outputs = new Map<string, unknown>();
  const inputRows = rows;
  const sheet = {
    getLastRow: () => inputRows.length + 1,
    getRange: (row: number, col: number, height?: number, width?: number) => ({
      getValues: () => inputRows,
      getValue: () => "Performance date",
      setValues: (values: unknown[][]) => {
        outputs.set(row + ":" + col, values);
        return sheet.getRange(row, col);
      },
      setValue: (value: unknown) => {
        if (col === 9) inputRows[row - 2][8] = value;
        outputs.set(row + ":" + col, value);
      },
      clearDataValidations: () => {},
      setNumberFormat: () => {},
      setBackground: () => sheet.getRange(row, col),
      setFontColor: () => sheet.getRange(row, col),
      setFontWeight: () => sheet.getRange(row, col),
      setNote: () => {},
    }),
    getMaxRows: () => 1000,
    setFrozenRows: () => {},
  };
  const book = {
    getSheetByName: () => sheet,
    getSpreadsheetTimeZone: () => "Europe/Copenhagen",
  };
  const props = { getProperty: () => "secret" };
  const Utilities = {
    getUuid: () => crypto.randomUUID(),
    computeHmacSha256Signature: () => [1, 2, 3],
    formatDate: (value: Date) => value.toISOString().slice(0, 10),
  };
  return { book, props, Utilities, outputs, inputRows };
}
test("sheet import keeps stable IDs and does not duplicate invitations across syncs", () => {
  const state = demoWorkspace();
  const f = sheetFixture([
    [
      today(),
      "Band",
      "band@example.com",
      2,
      3150,
      "Bank transfer",
      "",
      "No",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
  ]);
  runInNewContext(
    script +
      "\nsyncBookingRows(book,state,props); syncBookingRows(book,state,props);",
    { state, ...f },
  );
  assert.equal(state.bookings?.length, 1);
  assert.equal(state.bookingMail?.length, 1);
  assert.equal(state.bookings?.[0].fee, 315000);
  assert.equal(f.inputRows[0][8], state.bookings?.[0].id);
});
test("sheet revisions require approval again and never rewrite paid booking terms", () => {
  const state = demoWorkspace();
  const f = sheetFixture([
    [
      today(),
      "Band",
      "band@example.com",
      2,
      3150,
      "Cash",
      "",
      "No",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
  ]);
  const context = { state, ...f };
  runInNewContext(script + "\nsyncBookingRows(book,state,props);", {
    ...context,
  });
  const booking = state.bookings![0];
  booking.approvedVersion = booking.version;
  f.inputRows[0][4] = 3200;
  runInNewContext(script + "\nsyncBookingRows(book,state,props);", {
    ...context,
  });
  assert.equal(booking.version, 2);
  assert.notEqual(booking.approvedVersion, booking.version);
  booking.members = [
    {
      id: crypto.randomUUID(),
      musicianId: state.musicians[0].id,
      name: "Name",
      email: "a@example.com",
      paymentId: "paid",
    },
  ];
  f.inputRows[0][4] = 3300;
  runInNewContext(script + "\nsyncBookingRows(book,state,props);", {
    ...context,
  });
  assert.equal(booking.fee, 320000);
  assert.match(booking.sourceError!, /processed payments/);
});

test("booking email reservations prevent duplicate sends after a failed status save", () => {
  const { state, booking } = fixture();
  state.bookingMail = [
    {
      id: "invitation:" + booking.id,
      bookingId: booking.id,
      to: "band@example.com",
      kind: "invitation",
      status: "pending",
      createdAt: new Date(Date.now() - 120000).toISOString(),
      subject: "Booking",
      body: "Register",
    },
  ];
  const properties = new Map<string, string>();
  const props = {
    getProperty: (key: string) => properties.get(key),
    setProperty: (key: string, value: string) => properties.set(key, value),
    deleteProperty: (key: string) => properties.delete(key),
  };
  let sends = 0;
  const MailApp = {
    getRemainingDailyQuota: () => 10,
    sendEmail: () => {
      sends++;
    },
  };
  assert.throws(
    () =>
      runInNewContext(
        script +
          "\nwriteBookingState = function(){throw Error('Save interrupted')}; processBookingMail({},state,props);",
        { state, props, MailApp },
      ),
    /Save interrupted/,
  );
  assert.equal(sends, 1);
  state.bookingMail[0].status = "pending";
  runInNewContext(
    script +
      "\nwriteBookingState = function(){}; processBookingMail({},state,props);",
    { state, props, MailApp },
  );
  assert.equal(sends, 1);
  assert.equal(state.bookingMail[0].status, "sent");
  assert.equal(properties.size, 0);
});

test("an unknown mail outcome is held for manual follow-up instead of sent twice", () => {
  const { state, booking } = fixture();
  state.bookingMail = [
    {
      id: "invitation:" + booking.id,
      bookingId: booking.id,
      to: "band@example.com",
      kind: "invitation",
      status: "pending",
      createdAt: new Date(Date.now() - 120000).toISOString(),
      subject: "Booking",
      body: "Register",
    },
  ];
  const props = { getProperty: () => "sending" };
  let sends = 0;
  runInNewContext(
    script +
      "\nwriteBookingState = function(){}; processBookingMail({},state,props);",
    {
      state,
      props,
      MailApp: {
        getRemainingDailyQuota: () => 10,
        sendEmail: () => {
          sends++;
        },
      },
    },
  );
  assert.equal(sends, 0);
  assert.equal(state.bookingMail[0].status, "uncertain");
});

test("deleting a booking row flags it for attention rather than losing its members", () => {
  const state = demoWorkspace();
  const f = sheetFixture([
    [
      today(),
      "Band",
      "band@example.com",
      2,
      3150,
      "Cash",
      "",
      "No",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
  ]);
  runInNewContext(script + "\nsyncBookingRows(book,state,props);", {
    state,
    ...f,
  });
  f.inputRows.length = 0;
  runInNewContext(script + "\nsyncBookingRows(book,state,props);", {
    state,
    ...f,
  });
  assert.equal(state.bookings?.length, 1);
  assert.match(state.bookings![0].sourceError!, /row is missing/);
});

test("missing booking tabs get Google-assigned IDs and are reused on retries", () => {
  const state = demoWorkspace();
  state.musicians = [];
  state.payments = [];
  const sheets = new Map<string, any>();
  let nextId = 100;
  const created: string[] = [];
  function sheet(id: number) {
    return {
      getSheetId: () => id,
      getLastRow: () => 0,
      getMaxRows: () => 1000,
    };
  }
  for (const [name, id] of [
    ["Venue", 7],
    ["Musicians", 9],
    ["Payments", 1],
    ["Summary", 0],
    ["_Stagebook", 4],
  ] as const)
    sheets.set(name, sheet(id));
  const batches: any[][] = [];
  const book = {
    getId: () => "test-book",
    getSpreadsheetTimeZone: () => "Europe/Copenhagen",
    getSheetByName: (name: string) => sheets.get(name),
    insertSheet: (name: string) => {
      assert.ok(!sheets.has(name));
      created.push(name);
      const s = sheet(nextId++);
      sheets.set(name, s);
      return s;
    },
  };
  const context = {
    state,
    book,
    SpreadsheetApp: { flush: () => {} },
    Utilities: {
      Charset: { UTF_8: "UTF-8" },
      base64Encode: (value: string) => Buffer.from(value).toString("base64"),
    },
    Sheets: {
      Spreadsheets: {
        batchUpdate: (body: { requests: any[] }) => batches.push(body.requests),
      },
    },
  };
  runInNewContext(
    script + "\nwriteWorkbook(book,state); writeWorkbook(book,state);",
    context,
  );
  assert.deepEqual(created, [
    "Contracts",
    "Booking members",
    "Booking payments",
    "Booking emails",
  ]);
  assert.equal(batches.length, 2);
  for (const batch of batches) {
    assert.ok(batch.every((request) => !request.addSheet));
    const ids = batch
      .filter((request) => request.updateCells)
      .map((request) => request.updateCells.range.sheetId);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(1));
    assert.ok(ids.includes(100));
  }
});

test("each band member's chosen payment method reaches their agreement and processed payment", () => {
  const { state, booking } = fixture();
  booking.members[0].paymentType = "Cash";
  booking.members[1].paymentType = "Mobilepay";
  approve(state, booking);
  assert.equal(state.invites[0].offer?.paymentType, "Cash");
  assert.equal(state.invites[1].offer?.paymentType, "Mobilepay");
  sign(state, booking);
  confirmBooking(state, booking.id, {
    by: "Employee",
    members: booking.members.map((m) => ({ id: m.id, status: "played" })),
  });
  booking.paymentType = "Bank transfer";
  markBookingsPaid(state, {
    by: "Owner",
    paidOn: today(),
    members: booking.members.map((m) => ({
      bookingId: booking.id,
      memberId: m.id,
    })),
  });
  assert.deepEqual(
    state.payments.slice(-2).map((p) => p.paymentType),
    ["Cash", "Mobilepay"],
  );
});

test("column F becomes an artist-supplied summary without invalidating an existing approval", () => {
  const state = demoWorkspace();
  const f = sheetFixture([
    [
      today(),
      "Band",
      "band@example.com",
      2,
      3150,
      "Bank transfer",
      "",
      "No",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
  ]);
  runInNewContext(script + "\nsyncBookingRows(book,state,props);", {
    state,
    ...f,
  });
  const booking = state.bookings![0];
  booking.approvedVersion = booking.version;
  const oldSignature = JSON.parse(booking.sourceSignature!);
  const { dueOn, cancelled, ...other } = oldSignature;
  booking.sourceSignature = JSON.stringify({
    ...other,
    paymentType: "Bank transfer",
    dueOn,
    cancelled,
  });
  booking.members = state.musicians
    .slice(0, 2)
    .map((m, i) => ({
      id: crypto.randomUUID(),
      musicianId: m.id,
      name: m.name,
      email: m.email,
      paymentType: i ? "Mobilepay" : "Cash",
    }));
  f.inputRows[0][5] = "Mixed";
  runInNewContext(script + "\nsyncBookingRows(book,state,props);", {
    state,
    ...f,
  });
  assert.equal(booking.version, booking.approvedVersion);
  assert.equal(f.outputs.get("2:6"), "Mixed");
  assert.equal(booking.sourceError, undefined);
});
