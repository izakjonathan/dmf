import { z } from "zod";
import {
  admin,
  closeSession,
  configured,
  equals,
  fail,
  hash,
  json,
  metadata,
  openSession,
  passwordHash,
  readState,
  RequestError,
  sameOrigin,
  verifyPassword,
  writeState,
} from "@/lib/server";
export const maxDuration = 60;
export async function GET() {
  if (!configured()) return json({ connected: false });
  try {
    const { initialized } = await metadata();
    let signedIn = false;
    try {
      await admin();
      signedIn = true;
    } catch {}
    return json({ connected: true, initialized, signedIn });
  } catch (error) {
    return fail(error);
  }
}
const input = z.object({
  action: z.enum(["setup", "login", "logout"]),
  email: z.string().email().max(254).optional(),
  password: z.string().min(12).max(200).optional(),
  setup: z.string().max(200).optional(),
});
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    const data = input.parse(await req.json());
    if (data.action === "logout") {
      await closeSession();
      return json({ ok: true });
    }
    if (!data.email || !data.password)
      throw new RequestError("Enter your email and password.");
    if (
      data.action === "setup" &&
      !equals(data.setup || "", process.env.SETUP_TOKEN || "unconfigured")
    )
      throw new RequestError("The setup key is incorrect.", 403);
    const state = await readState();
    if (data.action === "setup") {
      if (state.auth)
        throw new RequestError(
          "The administrator account is already set up.",
          409,
        );
      state.auth = {
        email: data.email.toLowerCase(),
        passwordHash: passwordHash(data.password),
      };
      await writeState(state);
    } else {
      const attempts = (state.attempts || []).filter(
        (item) => item.at > Date.now() - 15 * 60000,
      );
      const key = hash(
        req.headers.get("x-vercel-forwarded-for")?.split(",")[0] || "default",
      );
      if (
        attempts.filter((item) => item.key === key).length >= 8 ||
        attempts.length >= 100
      )
        throw new RequestError(
          "Too many attempts. Try again in 15 minutes.",
          429,
        );
      if (
        !state.auth ||
        !verifyPassword(data.password, state.auth.passwordHash) ||
        data.email.toLowerCase() !== state.auth.email
      ) {
        state.attempts = [...attempts, { key, at: Date.now() }];
        await writeState(state);
        throw new RequestError("Email or password is incorrect.", 401);
      }
    }
    await openSession();
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
