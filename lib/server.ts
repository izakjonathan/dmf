import {
  createHmac,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { cookies } from "next/headers";
import { ZodError } from "zod";
import { empty, type Workspace } from "./model";

export const configured = () =>
  Boolean(
    process.env.GOOGLE_SCRIPT_URL &&
      process.env.GOOGLE_SCRIPT_SECRET &&
      process.env.AUTH_SECRET &&
      process.env.SETUP_TOKEN,
  );
export const spreadsheet = () =>
  /^[\w-]+$/.test(process.env.GOOGLE_SPREADSHEET_ID || "")
    ? "https://docs.google.com/spreadsheets/d/" +
      process.env.GOOGLE_SPREADSHEET_ID +
      "/edit"
    : null;
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("hex");
export function equals(a: string, b: string) {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
const sign = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body).digest("hex");
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function sameOrigin(req: Request) {
  const url = new URL(req.url);
  const protocol = process.env.VERCEL ? "https:" : url.protocol;
  const host = req.headers.get("host") ?? url.host;
  if (req.headers.get("origin") !== protocol + "//" + host)
    throw new RequestError("Invalid request origin.", 403);
}
export const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
export function fail(error: unknown) {
  if (error instanceof ZodError)
    return json({ error: error.issues[0]?.message }, 400);
  if (error instanceof RequestError)
    return json({ error: error.message }, error.status);
  return json(
    {
      error:
        "The request could not be completed. Check the Google Sheet connection and try again.",
    },
    502,
  );
}
async function sheets(action: string, data: object = {}) {
  if (!configured())
    throw new RequestError("Connect the Google Sheet first.", 503);
  const endpoint = process.env.GOOGLE_SCRIPT_URL!;
  if (
    !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(endpoint)
  )
    throw new RequestError("Check the Google Apps Script deployment URL.", 503);
  // Keep the signed payload byte-for-byte identical across Apps Script and Node.
  const body = JSON.stringify({
    action,
    timestamp: Date.now(),
    ...data,
  }).replace(
    /[^\x00-\x7f]/g,
    (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  const response = await fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      body,
      signature: sign(body, process.env.GOOGLE_SCRIPT_SECRET!),
    }),
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new RequestError(
      "Google Sheets is unavailable. Check the integration settings.",
      503,
    );
  const result = await response.json();
  if (result.error === "CONFLICT")
    throw new RequestError(
      "The sheet has a newer change. Refresh and try again.",
      409,
    );
  if (!result.ok)
    throw new RequestError(
      action === "write"
        ? "Google Sheets could not save this change. Check the latest Apps Script execution."
        : "Google Sheets rejected the request. Check the script deployment and secret.",
      503,
    );
  return result;
}
export async function readState(): Promise<Workspace> {
  return (await sheets("read")).state ?? empty();
}
export async function metadata(): Promise<{ initialized: boolean }> {
  return sheets("metadata");
}
export async function writeState(state: Workspace) {
  const next = { ...state, revision: state.revision + 1 };
  await sheets("write", { state: next, expected: state.revision });
  return next;
}
const cookieName = "stagebook_session";
export async function admin() {
  const session = (await cookies()).get(cookieName)?.value;
  const secret = process.env.AUTH_SECRET;
  const [body, signature] = session?.split(".") ?? [];
  if (!secret || !body || !signature || !equals(signature, sign(body, secret)))
    throw new RequestError("Sign in to access your venue.", 401);
  const expires = Number(body.split(":")[0]);
  if (!Number.isSafeInteger(expires) || expires < Date.now())
    throw new RequestError("Sign in again.", 401);
}
export async function openSession() {
  const body = String(Date.now() + 8 * 3600000) + ":" + token();
  (await cookies()).set(
    cookieName,
    body + "." + sign(body, process.env.AUTH_SECRET!),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 3600,
    },
  );
}
export async function closeSession() {
  (await cookies()).delete(cookieName);
}
export function passwordHash(value: string, salt = token()) {
  return salt + ":" + scryptSync(value, salt, 64).toString("hex");
}
export function verifyPassword(value: string, stored: string) {
  return equals(passwordHash(value, stored.split(":")[0]), stored);
}
export function findInvite(state: Workspace, raw: string) {
  if (!/^[a-f0-9]{64}$/.test(raw))
    throw new RequestError("This registration link is invalid.", 404);
  const invite = state.invites.find(
    (item) =>
      item.hash === hash(raw) &&
      !item.revoked &&
      item.expiresAt > new Date().toISOString(),
  );
  if (!invite)
    throw new RequestError(
      "This link has expired. Ask the venue for a new one.",
      404,
    );
  return invite;
}
