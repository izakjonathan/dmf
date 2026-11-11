import {
  fail,
  findInvite,
  json,
  readState,
  RequestError,
  sameOrigin,
  writeState,
} from "@/lib/server";
import { musicianSchema } from "@/lib/model";
type Context = { params: Promise<{ token: string }> };
export const maxDuration = 60;
export async function GET(_req: Request, context: Context) {
  try {
    const state = await readState();
    const invite = findInvite(state, (await context.params).token);
    const profile = state.musicians.find(
      (item) => item.id === invite.musicianId,
    );
    const { name, legalName, email, collectCpr } = state.venue;
    return json({
      venue: { name, legalName, email, collectCpr },
      profile: profile
        ? {
            name: profile.name,
            band: profile.band,
            address: profile.address,
            email: profile.email,
            phone: profile.phone,
            payee: profile.payee,
            cvr: profile.cvr,
          }
        : null,
    });
  } catch (error) {
    return fail(error);
  }
}
export async function POST(req: Request, context: Context) {
  try {
    sameOrigin(req);
    const state = await readState();
    const invite = findInvite(state, (await context.params).token);
    const input = musicianSchema.parse(await req.json());
    const index = state.musicians.findIndex(
      (item) => item.id === invite.musicianId,
    );
    if (
      state.musicians.some(
        (item) => item.email === input.email && item.id !== invite.musicianId,
      )
    )
      throw new RequestError(
        "This email is already registered. Ask the venue to update your details.",
        409,
      );
    const at = new Date().toISOString();
    const existing = state.musicians[index];
    const profile = {
      ...input,
      cpr: state.venue.collectCpr ? input.cpr : "",
      id: existing?.id || crypto.randomUUID(),
      createdAt: existing?.createdAt || at,
      updatedAt: at,
    };
    if (existing) {
      state.musicians[index] = profile;
      invite.revoked = true;
    } else state.musicians.push(profile);
    await writeState(state);
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
