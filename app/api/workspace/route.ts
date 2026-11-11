import { z } from "zod";
import {
  admin,
  fail,
  hash,
  json,
  readState,
  RequestError,
  sameOrigin,
  spreadsheet,
  token,
  writeState,
} from "@/lib/server";
import {
  clientWorkspace,
  contractTermsSchema,
  dmfTemplate,
  musicianEditSchema,
  net,
  paymentRecords,
  today,
  updateMusician,
  venueSchema,
} from "@/lib/model";
export const maxDuration = 60;
export async function GET(req: Request) {
  try {
    await admin();
    const state = await readState();
    const params = new URL(req.url).searchParams;
    const contractId = params.get("contract");
    if (contractId !== null) {
      const contract = state.contracts?.find(({ id }) => id === contractId);
      if (!contract) throw new RequestError("Contract not found.", 404);
      return json({ contract });
    }
    const musicianId = params.get("musician");
    if (musicianId !== null) {
      const profile = state.musicians.find(({ id }) => id === musicianId);
      if (!profile) throw new RequestError("Musician not found.", 404);
      return json({ profile, collectCpr: state.venue.collectCpr });
    }
    return json({
      workspace: clientWorkspace(state),
      sheet: spreadsheet(),
    });
  } catch (error) {
    return fail(error);
  }
}
const request = z.discriminatedUnion("action", [
  z.object({ action: z.literal("venue"), data: venueSchema }),
  z.object({ action: z.literal("payment"), data: z.unknown() }),
  z.object({ action: z.literal("musician"), data: musicianEditSchema }),
  z.object({
    action: z.literal("invite"),
    data: contractTermsSchema,
  }),
  z.object({
    action: z.literal("revoke"),
    data: z.object({ id: z.string().uuid() }),
  }),
  z.object({
    action: z.literal("void"),
    data: z.object({
      id: z.string(),
      reason: z.string().trim().min(5).max(300),
    }),
  }),
]);
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    await admin();
    const input = request.parse(await req.json());
    const state = await readState();
    let link: string | undefined;
    switch (input.action) {
      case "venue":
        state.venue = input.data;
        break;
      case "payment": {
        try {
          state.payments.push(...paymentRecords(state, input.data));
        } catch (error) {
          if (error instanceof z.ZodError) throw error;
          throw new RequestError((error as Error).message);
        }
        break;
      }
      case "musician": {
        const error = updateMusician(state, input.data);
        if (error) throw new RequestError(error, 409);
        break;
      }
      case "invite": {
        const { name, legalName, address, cvr, email, phone } =
          venueSchema.parse(state.venue);
        const { accepted, ...terms } = input.data;
        if (terms.returnBy < today())
          throw new RequestError("Enter a signing deadline of today or later.");
        const raw = token();
        state.invites.push({
          id: crypto.randomUUID(),
          hash: hash(raw),
          expiresAt: terms.returnBy + "T23:59:59.999Z",
          offer: {
            ...terms,
            organizer: { name, legalName, address, cvr, email, phone },
            organizerSignedAt: new Date().toISOString(),
            template: dmfTemplate,
          },
        });
        link = "/register/" + raw;
        break;
      }
      case "revoke": {
        const invite = state.invites.find((item) => item.id === input.data.id);
        if (!invite) throw new RequestError("Link not found.", 404);
        invite.revoked = true;
        break;
      }
      case "void": {
        const payment = state.payments.find(
          (item) => item.id === input.data.id && !item.voidReason,
        );
        if (!payment) throw new RequestError("Payment not found.", 404);
        const balance = state.payments
          .filter(
            (item) =>
              item.musicianId === payment.musicianId && item.id !== payment.id,
          )
          .reduce((sum, item) => sum + net(item), 0);
        if (balance < 0)
          throw new RequestError(
            "Correct the related refund before voiding this payment.",
          );
        payment.voidReason = input.data.reason;
        break;
      }
    }
    return json({ workspace: clientWorkspace(await writeState(state)), link });
  } catch (error) {
    return fail(error);
  }
}
