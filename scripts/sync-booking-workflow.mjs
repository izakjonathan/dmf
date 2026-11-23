import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const script = new URL("../public/Code.gs", import.meta.url);
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const bookings = source("../lib/bookings.ts");
const stage = bookings.slice(
  bookings.indexOf("export function bookingStage("),
  bookings.indexOf("export function resolveBookingException("),
);
const payments = bookings.slice(
  bookings.indexOf("export function pendingReason("),
  bookings.indexOf("export const approvalSchema"),
);
const shared =
  source("../lib/booking-stage.ts") +
  payments +
  stage.replaceAll("isCurrentBookingMail", "currentBookingMail");
const compiled = ts.transpile(
  shared.replaceAll("export function", "function"),
  {
    target: ts.ScriptTarget.ES2022,
  },
);
const marker =
  "// Shared booking workflow. Regenerate with npm run sync:booking-workflow.";
const installed = readFileSync(script, "utf8");
const index = installed.indexOf(marker);
if (index < 0) throw Error("Missing Apps Script workflow marker.");
const updated =
  installed.slice(0, index) +
  marker +
  "\n" +
  'function today() { return Utilities.formatDate(new Date(),"Europe/Copenhagen","yyyy-MM-dd"); }\n' +
  "function bookingRegistrationClosed(b) { return b.approvedVersion===b.version || b.contractsVersion===b.version; }\n" +
  'function hasOtherPaymentPath(state,v,manual) { return (state.payments || []).some(p=>!p.voidReason && p.kind==="Payment" && Boolean(p.bookingId)===manual && p.musicianId===v.musicianId && p.performedOn===v.performedOn && normalizeBand(p.band)===normalizeBand(v.band)); }\n' +
  compiled;
if (process.argv.includes("--check")) {
  if (updated !== installed)
    throw Error("Regenerate Apps Script booking workflow.");
} else writeFileSync(script, updated);
