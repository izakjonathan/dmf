import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  clientWorkspace,
  demoWorkspace,
  isoWeek,
  paymentRecord,
  tariff,
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
  const safe = clientWorkspace(state);
  assert.equal("auth" in safe, false);
  assert.equal("account" in safe.musicians[0], false);
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
