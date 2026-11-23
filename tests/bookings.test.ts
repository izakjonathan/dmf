import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  approveBooking,
  bookingStage,
  countersignBooking,
  issueBookingContracts,
  resolveBookingException,
  bookingContractStatus,
  reopenBooking,
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
      to: booking.contactEmail,
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
        { state, props, MailApp, Utilities: { formatDate: today } },
      ),
    /Save interrupted/,
  );
  assert.equal(sends, 1);
  state.bookingMail[0].status = "pending";
  runInNewContext(
    script +
      "\nwriteBookingState = function(){}; processBookingMail({},state,props);",
    { state, props, MailApp, Utilities: { formatDate: today } },
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
      to: booking.contactEmail,
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
      Utilities: { formatDate: today },
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
  booking.members = state.musicians.slice(0, 2).map((m, i) => ({
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

test("superseded invitations do not mask the current email delivery status", () => {
  const { booking, state } = fixture();
  booking.sourceVersion = 3;
  const old = {
    id: "old",
    bookingId: booking.id,
    to: booking.contactEmail,
    kind: "invitation",
    status: "failed",
    sourceVersion: 2,
    error: "Booking changed. Use its current links.",
  };
  const current = {
    ...old,
    id: "current",
    sourceVersion: 3,
    status: "pending",
    error: undefined,
  };
  state.bookingMail = [old, current] as any;
  const context = { state, booking, result: "" };
  runInNewContext(
    script + "\nresult=bookingEmailStatus(state,booking);",
    context,
  );
  assert.equal(context.result, "Queued");
  current.status = "sent";
  const sentContext = { state, booking, result: "" };
  runInNewContext(
    script + "\nresult=bookingEmailStatus(state,booking);",
    sentContext,
  );
  assert.equal(sentContext.result, "Sent");
  current.status = "failed";
  current.error = "MAIL_PERMISSION" as any;
  const failedContext = { state, booking, result: "" };
  runInNewContext(
    script + "\nresult=bookingEmailStatus(state,booking);",
    failedContext,
  );
  assert.equal(failedContext.result, "Needs attention");
});

test("email status refresh updates only the booking email status column", () => {
  const { booking, state } = fixture();
  state.bookingMail = [];
  const writes: unknown[] = [];
  const sheet = {
    getLastRow: () => 3,
    getRange: (
      row: number | string,
      column: number,
      count: number,
      width: number,
    ) => {
      if (row === "A1") return { getValue: () => "Performance date" };
      assert.equal(row, 2);
      assert.equal(count, 2);
      assert.equal(width, 1);
      if (column === 9) return { getValues: () => [[booking.id], [""]] };
      assert.equal(column, 13);
      return {
        setValues: (values: unknown) =>
          writes.push(JSON.parse(JSON.stringify(values))),
      };
    },
  };
  runInNewContext(script + "\nrefreshBookingEmailStatuses(book,state);", {
    state,
    book: {
      getSheetByName: (name: string) => {
        assert.equal(name, "Bookings");
        return sheet;
      },
    },
  });
  assert.deepEqual(writes, [[["No email pending"], [""]]]);
});

function operationsFixture(
  state: ReturnType<typeof demoWorkspace>,
  row: unknown[],
) {
  const outputs = new Map<number, unknown[]>();
  const rows = [row];
  const sheet = {
    getLastRow: () => 2,
    getRange: (
      r: number | string,
      col?: number,
      height?: number,
      width?: number,
    ) => ({
      getValue: (): unknown => (r === "A1" ? "Dato" : row[(col || 1) - 1]),
      getValues: () =>
        typeof r === "number" && col === 23 ? [[row[22]]] : rows,
      setValue: (value: unknown) => {
        outputs.set(col!, [value]);
        row[col! - 1] = value;
      },
      setValues: (values: unknown[][]) => {
        outputs.set(col!, values[0]);
        values[0].forEach((value, i) => (row[col! - 1 + i] = value));
      },
    }),
  };
  const book = {
    getSheetByName: () => sheet,
    getSpreadsheetTimeZone: () => "Europe/Copenhagen",
  };
  const props = { getProperty: () => "secret" };
  const Utilities = {
    getUuid: () => crypto.randomUUID(),
    computeHmacSha256Signature: () => [1, 2, 3],
    formatDate: (date: Date) => date.toISOString().slice(0, 10),
  };
  return { state, book, props, Utilities, outputs, row };
}
test("reference layout preserves staff columns, booking IDs, links and approved artist changes", () => {
  const { state, booking } = fixture();
  booking.sourceVersion = 1;
  const source = {
    date: booking.date,
    act: booking.act,
    contactEmail: booking.contactEmail,
    expectedMembers: 2,
    fee: booking.fee,
    dueOn: booking.dueOn,
    cancelled: false,
  };
  booking.sourceSignature = JSON.stringify(source);
  booking.approvedVersion = booking.version;
  const row: unknown[] = Array(28).fill("");
  row[0] = booking.date;
  row[2] = booking.act;
  row[9] = booking.contactEmail;
  row[6] = 2;
  row[18] = booking.fee / 100;
  row[20] = booking.dueOn;
  row[21] = "No";
  row[22] = booking.id;
  const staffColumns = [3, 4, 7, 11, 12, 13, 14, 15, 16, 17];
  const staff = [50, 1500, 30, "Ebbe", "sendt", true, false, true, false, true];
  staffColumns.forEach((col, i) => (row[col] = staff[i]));
  const f = operationsFixture(state, row);
  runInNewContext(script + "\nsyncBookingRows(book,state,props);", f);
  assert.equal(booking.id, row[22]);
  assert.equal(booking.version, booking.approvedVersion);
  assert.equal(row[5], 6300);
  assert.equal(row[8], 1500 / 6300);
  assert.equal(row[1], false);
  assert.ok(String(row[24]).startsWith("https://dmf-eta.vercel.app/b/"));
  assert.deepEqual(
    staffColumns.map((col) => row[col]),
    staff,
  );
  assert.equal((booking as any).operations.booker, "Ebbe");
  row[4] = 2000;
  row[13] = false;
  runInNewContext(script + "\nsyncBookingRows(book,state,props);", { ...f });
  assert.equal(booking.version, booking.approvedVersion);
  assert.equal(
    state.bookingMail?.filter((m) => m.kind === "invitation").length,
    1,
  );
  booking.expectedMembers = 3;
  booking.version++;
  booking.approvedVersion = booking.version;
  runInNewContext(script + "\nsyncBookingRows(book,state,props);", { ...f });
  assert.equal(booking.version, booking.approvedVersion);
  assert.equal(row[6], 3);
  assert.equal(row[5], 9450);
});
test("payment completion comes only from real recorded payments and projection never writes staff fields", () => {
  const { state, booking } = fixture();
  const row: unknown[] = Array(28).fill("");
  row[22] = booking.id;
  row[4] = 0;
  booking.members.forEach((m, i) => {
    const p = { ...state.payments[0], id: crypto.randomUUID(), voidReason: "" };
    state.payments.push(p);
    m.paymentId = p.id;
  });
  const f = operationsFixture(state, row);
  runInNewContext(script + "\nrefreshBookingProjection(book,state);", f);
  assert.equal(row[1], true);
  assert.equal(row[8], 0);
  assert.ok(
    [...f.outputs.keys()].every((col) => [2, 6, 9, 11, 24, 26].includes(col)),
  );
  state.payments.find(
    (p) => p.id === booking.members[0].paymentId,
  )!.voidReason = "Reversed";
  runInNewContext(script + "\nrefreshBookingProjection(book,state);", { ...f });
  assert.equal(row[1], false);
});
test("legacy row migration maps the source layout without changing staff inputs or IDs", () => {
  const old = [
    "2026-12-01",
    "Act",
    "band@example.com",
    3,
    3000,
    "Mixed",
    "2026-12-10",
    "No",
    "stable-id",
    "Collecting details",
    "private-link",
    "1 / 3",
    "Sent",
    "",
  ];
  const ctx: any = { old, result: null };
  runInNewContext(script + "\nresult=bookingRowFromLegacy(old);", ctx);
  assert.equal(ctx.result.length, 28);
  assert.equal(ctx.result[0], old[0]);
  assert.equal(ctx.result[2], old[1]);
  assert.equal(ctx.result[9], old[2]);
  assert.equal(ctx.result[6], 3);
  assert.equal(ctx.result[18], 3000);
  assert.equal(ctx.result[22], "stable-id");
  assert.equal(ctx.result[24], "private-link");
  assert.ok(
    [3, 4, 7, 11, 12, 13, 14, 15, 16, 17].every(
      (col) => ctx.result[col] === "",
    ),
  );
});

test("upgrade keeps the original tab, refreshes legacy values and retains staff entries and staged additions", () => {
  const legacyId = crypto.randomUUID();
  const legacyRow = [
    today(),
    "Updated act",
    "band@example.com",
    3,
    3200,
    "Mixed",
    today(),
    "No",
    legacyId,
    "Collecting details",
    "existing-link",
    "1 / 3",
    "Sent",
    "",
  ];
  const stagedRow: any[] = Array(28).fill("");
  stagedRow[0] = today();
  stagedRow[2] = "Old title";
  stagedRow[9] = "band@example.com";
  stagedRow[22] = legacyId;
  stagedRow[3] = 75;
  stagedRow[11] = "Bertil";
  stagedRow[15] = true;
  const added: any[] = Array(28).fill("");
  added[0] = today();
  added[2] = "Another act";
  added[9] = "new@example.com";
  const sheets: any = {};
  function sheet(name: string, data: any[][], columns: number) {
    const result: any = {
      name,
      data,
      getLastRow: () => result.data.length,
      getMaxRows: () => 1000,
      getMaxColumns: () => columns,
      getRange: (row: number, col: number, height = 1, width = 1) => ({
        getValue: () => result.data[0][0],
        getValues: () => result.data.slice(row - 1, row - 1 + height),
        setValues: (values: any[][]) =>
          values.forEach((v, i) => (result.data[row - 1 + i] = Array.from(v))),
        clearContent: () => {},
      }),
      setName: (next: string) => {
        delete sheets[result.name];
        result.name = next;
        sheets[next] = result;
      },
      insertColumnsAfter: () => {
        columns = 28;
      },
      insertRowsAfter: () => {},
    };
    sheets[name] = result;
    return result;
  }
  const old = sheet("Bookings", [["Performance date"], legacyRow], 14);
  const staged = sheet("Bookings v2", [["Dato"], stagedRow, added], 28);
  const context: any = {
    book: { getSheetByName: (name: string) => sheets[name] },
    state: demoWorkspace(),
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => "id" }),
    },
    SpreadsheetApp: { openById: () => context.book },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
    },
    Utilities: { formatDate: () => "20261120-120000" },
    console: { info: () => {} },
  };
  context.state.auth = {} as any;
  runInNewContext(
    script +
      `\nreadStoredState=()=>state;configureModernBookingSheet=()=>{};syncBookingRows=()=>{};writeBookingState=()=>{};
    upgradeBookingSheet();`,
    context,
  );
  assert.equal(sheets.Bookings, staged);
  assert.equal(sheets["Bookings legacy 20261120-120000"], old);
  assert.equal(staged.data[1][2], "Updated act");
  assert.equal(staged.data[1][18], 3200);
  assert.equal(staged.data[1][22], legacyId);
  assert.equal(staged.data[1][24], "existing-link");
  assert.equal(staged.data[1][3], 75);
  assert.equal(staged.data[1][11], "Bertil");
  assert.equal(staged.data[1][15], true);
  assert.equal(staged.data[2][2], "Another act");
});

test("sheet approval guard rejects live row changes, reordered columns and duplicate IDs", () => {
  const { state, booking } = fixture();
  const row = Array(28).fill("");
  row[0] = booking.date;
  row[2] = booking.act;
  row[9] = booking.contactEmail;
  row[18] = booking.fee / 100;
  row[20] = booking.dueOn;
  row[22] = booking.id;
  const rows = [row];
  let headerChanged = false;
  const context: any = {
    state,
    row,
    id: booking.id,
    header: [],
    book: {
      getSpreadsheetTimeZone: () => "Europe/Copenhagen",
      getSheetByName: () => ({
        getLastRow: () => rows.length + 1,
        getRange: (r: string | number) => ({
          getValue: () => "Dato",
          getValues: () =>
            r === 1
              ? [headerChanged ? ["Dato", "invalid"] : context.header]
              : rows,
        }),
      }),
    },
  };
  runInNewContext(
    script +
      '\nheader = BOOKING_OPERATIONS_HEADERS; state.bookings[0].sourceSignature = JSON.stringify(bookingInput(bookingInputRow(row,true),"Europe/Copenhagen",state.bookings[0],true));',
    context,
  );
  const matches = () =>
    runInNewContext(script + "\nsheetBookingMatches(book,state,id)", {
      ...context,
    });
  assert.equal(matches(), true);
  row[4] = 200;
  assert.equal(matches(), true);
  row[18] = 123;
  assert.equal(matches(), false);
  row[18] = booking.fee / 100;
  rows.push([...row]);
  assert.equal(matches(), false);
  rows.pop();
  headerChanged = true;
  assert.equal(matches(), false);
});

test("booking corrections retain completed attendance and archive prior signatures", () => {
  const { state, booking } = fixture();
  approve(state, booking);
  sign(state, booking);
  confirmBooking(state, booking.id, {
    by: "Staff Person",
    note: "",
    members: booking.members.map((m) => ({ id: m.id, status: "played" })),
  });
  assert.equal(bookingContractStatus(state, booking), "All contracts signed");
  reopenBooking(state, booking.id, {
    memberId: booking.members[1].id,
    reason: "Incorrect performer in roster",
  });
  assert.equal(booking.members[0].attendance, "played");
  assert.equal(booking.confirmedBy, "Staff Person");
  assert.equal(state.contracts?.length, 2);
  assert.equal(
    bookingContractStatus(state, booking),
    "Waiting for booking details",
  );
});

test("payment gate and sheet projection agree when the booking needs reconciliation", () => {
  const { state, booking } = fixture();
  approve(state, booking);
  sign(state, booking);
  confirmBooking(state, booking.id, {
    by: "Staff Person",
    members: booking.members.map((m) => ({ id: m.id, status: "played" })),
  });
  const member = booking.members[0];
  const exportStatus = () =>
    runInNewContext(script + '\nrowsFor(state)["Booking payments"][1][8]', {
      state,
    });
  booking.sourceError = "Incomplete row";
  assert.equal(exportStatus(), pendingReason(state, booking, member));
  delete booking.sourceError;
  state.payments.push({
    ...state.payments[0],
    kind: "Payment",
    musicianId: member.musicianId,
    band: booking.act,
    performedOn: booking.date,
  });
  assert.equal(exportStatus(), "Manual payment needs reconciliation");
  assert.equal(exportStatus(), pendingReason(state, booking, member));
});

test("an absent performer cannot block a signed colleague or receive their payment", () => {
  const { state, booking } = fixture();
  booking.artistFirst = true;
  issueBookingContracts(state, booking, booking, (id) => ({
    hash: id,
    url: id,
  }));
  sign(state, booking);
  assert.equal(bookingStage(state, booking).action, "confirm");
  confirmBooking(state, booking.id, {
    by: "Staff",
    note: "Second musician absent",
    members: booking.members.map((m, i) => ({
      id: m.id,
      status: i ? "absent" : "played",
    })),
  });
  assert.equal(bookingStage(state, booking).action, "sign");
  countersignBooking(state, booking, "Owner", (id) => id);
  assert.equal(
    state.bookingMail!.filter((m) => m.kind === "receipt").length,
    1,
  );
  assert.equal(bookingStage(state, booking).action, "pay");
  markBookingsPaid(state, {
    by: "Owner",
    paidOn: today(),
    members: [{ bookingId: booking.id, memberId: booking.members[0].id }],
  });
  assert.equal(bookingStage(state, booking).label, "Needs attention");
  resolveBookingException(state, booking.id, {
    memberId: booking.members[1].id,
    by: "Owner",
    reason: "Handled separately",
    accepted: true,
  });
  const stage = bookingStage(state, booking);
  assert.equal(stage.label, "Complete");
  assert.equal(booking.members[1].paymentId, undefined);
  assert.equal(
    state.contracts!.filter((c) => c.offer.organizerSignedAt).length,
    1,
  );
  const sandbox = {
    state,
    booking,
    Utilities: { formatDate: () => today() },
    result: "",
  };
  runInNewContext(
    script + "\nresult = JSON.stringify(bookingStage(state, booking));",
    sandbox,
  );
  assert.deepEqual(JSON.parse(sandbox.result), stage);
});

test("production booking intake rejects new bookings on legacy layouts", () => {
  const state = demoWorkspace();
  const f = sheetFixture([
    [today(), "New band", "act@example.test", 2, 3150, "Cash", "", "No", ""],
  ]);
  runInNewContext(script + "\nsyncBookingRows(book,state,props,true)", {
    state,
    ...f,
  });
  assert.equal(state.bookings?.length ?? 0, 0);
  assert.match(String(f.outputs.get("2:14")), /Upgrade the Bookings tab/);
});

test("both new booking entry points share the musician-first workflow", () => {
  const makeFixture = () => {
    const state = demoWorkspace();
    const row: unknown[] = Array(43).fill("");
    const f = operationsFixture(state, row);
    const readRange = f.book.getSheetByName().getRange;
    Object.assign(f.book.getSheetByName(), {
      getMaxColumns: () => 43,
      getMaxRows: () => 1000,
      getLastRow: () => (row[0] ? 2 : 1),
      getRange: (r: number | string, col?: number, n?: number, w?: number) =>
        r === "AD1"
          ? { getValue: (): string => "Contact name" }
          : { ...readRange(r, col, n, w), setNumberFormat() {} },
    });
    return f;
  };
  for (const fromApp of [true, false]) {
    const f = makeFixture();
    const input = {
      requestId: crypto.randomUUID(),
      date: today(),
      act: "New band",
      ticketPrice: 5000,
      contactEmail: "act@example.test",
      booker: "Staff",
      fee: 315000,
      contactName: "Band contact",
    };
    if (!fromApp) {
      for (const [index, value] of [
        [0, input.date],
        [2, input.act],
        [3, 50],
        [9, input.contactEmail],
        [11, input.booker],
        [18, 3150],
        [29, input.contactName],
      ] as const)
        f.row[index] = value;
    }
    runInNewContext(
      script +
        `
      const append = appendStagebookBooking;
      appendStagebookBooking = (book,sheet,data) => {
        sheetValue = () => ({numberValue:data.date});
        append(book,sheet,data);
      };
      if (fromApp) appendStagebookBooking(book,book.getSheetByName(),input);
      syncBookingRows(book,state,props,true);
    `,
      {
        ...f,
        input,
        fromApp,
        PropertiesService: { getScriptProperties: () => f.props },
      },
    );
    assert.equal(f.state.bookings?.[0].artistFirst, true);
    assert.equal(f.state.bookings?.[0].contactName, input.contactName);
  }
});
