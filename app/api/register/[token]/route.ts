import {
  fail,
  findInvite,
  json,
  readState,
  RequestError,
  sameOrigin,
  writeState,
} from "@/lib/server";
import {
  musicianSchema,
  performerSignatureSchema,
  today,
  type Invite,
  type SignedContract,
} from "@/lib/model";
type Context = { params: Promise<{ token: string }> };
export const maxDuration = 60;
function registrationOffer(invite: Invite) {
  if (invite.signedAt)
    throw new RequestError(
      "This contract has already been signed. Contact the venue if you need a copy.",
      409,
    );
  if (!invite.offer && !invite.musicianId)
    throw new RequestError(
      "Ask the venue for a new registration link with your DMF contract.",
      410,
    );
  if (invite.offer && invite.offer.returnBy < today())
    throw new RequestError(
      "The signing deadline has passed. Ask the venue for a new link.",
      410,
    );
  return invite.offer ?? null;
}

export async function GET(_req: Request, context: Context) {
  try {
    const state = await readState();
    const invite = findInvite(state, (await context.params).token);
    const offer = registrationOffer(invite);
    const { performerEmail, ...publicOffer } = offer ?? {};
    const profile = state.musicians.find(
      (item) => item.id === invite.musicianId,
    );
    const { name, legalName, email, collectCpr } = state.venue;
    return json({
      venue: { name, legalName, email, collectCpr },
      offer: offer ? publicOffer : null,
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
    const offer = registrationOffer(invite);
    const body = await req.json();
    const input = musicianSchema.parse(body);
    const signature = offer
      ? performerSignatureSchema.parse(body.signature)
      : null;
    if (offer && input.email !== offer.performerEmail)
      throw new RequestError(
        "Use the email address the venue sent this link to.",
        403,
      );
    const index = state.musicians.findIndex((item) =>
      offer
        ? item.email.toLowerCase() === input.email
        : item.id === invite.musicianId,
    );
    if (
      state.musicians.some(
        (item, position) =>
          item.email.toLowerCase() === input.email && position !== index,
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
      cpr: (state.venue.collectCpr && input.cpr) || existing?.cpr || "",
      id: existing?.id || crypto.randomUUID(),
      createdAt: existing?.createdAt || at,
      updatedAt: at,
    };
    if (existing) state.musicians[index] = profile;
    else state.musicians.push(profile);

    let contract: SignedContract | undefined;
    if (offer && signature) {
      const { name, email, address, phone, band, cvr, payee } = profile;
      contract = {
        id: invite.id,
        musicianId: profile.id,
        offer,
        performer: { name, email, address, phone, band, cvr, payee },
        performerSigner: signature.name,
        performerSignedAt: at,
      };
      state.contracts ??= [];
      state.contracts.push(contract);
      invite.signedAt = at;
    } else if (existing) invite.revoked = true;
    await writeState(state);
    return json({ ok: true, contract });
  } catch (error) {
    return fail(error);
  }
}
