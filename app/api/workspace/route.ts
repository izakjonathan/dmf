import { z } from "zod";
import {
  admin,
  fail,
  hash,
  json,
  paymentSigningPath,
  paymentSigningToken,
  probeContractEmail,
  readState,
  RequestError,
  sameOrigin,
  sendContractEmails,
  spreadsheet,
  token,
  writeState,
} from "@/lib/server";
import {
  clientWorkspace,
  paymentContractSchema,
  dmfTemplate,
  musicianEditSchema,
  net,
  paymentRecords,
  today,
  updateMusician,
  venueSchema,
  type Invite,
  type Workspace,
} from "@/lib/model";
export const maxDuration = 60;
export async function GET(req: Request) {
  try {
    await admin();
    const params = new URL(req.url).searchParams;
    if (params.get("emailCheck") === "1")
      return json(await probeContractEmail());
    const state = await readState();
    const signingId = params.get("signing");
    if (signingId !== null) {
      const invite = activePaymentInvite(state, signingId);
      return json({ link: paymentSigningPath(invite) });
    }
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
function activePaymentInvite(state: Workspace, id: string) {
  const invite = state.invites.find((item) => item.id === id);
  if (
    !invite?.paymentId ||
    !invite.offer ||
    invite.revoked ||
    invite.signedAt ||
    invite.offer.returnBy < today() ||
    !state.payments.some(
      (payment) => payment.id === invite.paymentId && !payment.voidReason,
    )
  )
    throw new RequestError("This signing link is no longer active.", 409);
  return invite;
}

async function deliver(state: Workspace, invites: Invite[]) {
  try {
    const result = await sendContractEmails(invites);
    return json({
      workspace: clientWorkspace(result.state),
      delivery: result.delivery,
    });
  } catch (error) {
    const message =
      error instanceof RequestError
        ? error.message
        : "Google did not confirm the send. Check the existing signing request or copy its link.";
    return json({
      workspace: clientWorkspace(state),
      delivery: { sent: 0, failed: invites.length, message },
    });
  }
}

const request = z.discriminatedUnion("action", [
  z.object({ action: z.literal("venue"), data: venueSchema }),
  z.object({ action: z.literal("payment"), data: z.unknown() }),
  z.object({ action: z.literal("musician"), data: musicianEditSchema }),
  z.object({
    action: z.literal("invite"),
    data: z.object({}),
  }),
  z.object({
    action: z.literal("sendContract"),
    data: z.object({ id: z.string().uuid() }),
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
        let payments;
        try {
          payments = paymentRecords(state, input.data);
        } catch (error) {
          if (error instanceof z.ZodError) throw error;
          throw new RequestError((error as Error).message);
        }
        const { contract } = z
          .object({ contract: paymentContractSchema.optional() })
          .parse(input.data);
        if (!contract) {
          state.payments.push(...payments);
          break;
        }
        if (payments.some(({ kind }) => kind !== "Payment"))
          throw new RequestError("Refunds do not generate signing requests.");
        if (contract.returnBy < today())
          throw new RequestError("Enter a signing deadline of today or later.");
        const { name, legalName, address, cvr, email, phone } =
          venueSchema.parse(state.venue);
        const { accepted, ...terms } = contract;
        const signedAt = new Date().toISOString();
        const invites: Invite[] = payments.map((payment) => {
          const artist = state.musicians.find(
            ({ id }) => id === payment.musicianId,
          )!;
          const id = crypto.randomUUID();
          return {
            id,
            hash: hash(paymentSigningToken(id)),
            musicianId: artist.id,
            paymentId: payment.id,
            expiresAt: terms.returnBy + "T23:59:59.999Z",
            performer: {
              name: artist.name,
              email: artist.email,
              address: artist.address,
              phone: artist.phone,
              band: payment.band,
              cvr: artist.cvr,
              payee: artist.payee,
            },
            offer: {
              ...terms,
              performerEmail: artist.email.toLowerCase(),
              performanceDate: payment.performedOn,
              payOn: payment.paidOn,
              fee: payment.amount,
              organizer: { name, legalName, address, cvr, email, phone },
              organizerSignedAt: signedAt,
              template: dmfTemplate,
            },
          };
        });
        state.payments.push(...payments);
        state.invites.push(...invites);
        return deliver(await writeState(state), invites);
      }
      case "sendContract":
        return deliver(state, [activePaymentInvite(state, input.data.id)]);
      case "musician": {
        const error = updateMusician(state, input.data);
        if (error) throw new RequestError(error, 409);
        break;
      }
      case "invite": {
        if (!state.venue.legalName)
          throw new RequestError(
            "Save your venue details before getting a registration link.",
          );
        const raw = token();
        state.invites.push({
          id: crypto.randomUUID(),
          hash: hash(raw),
          registration: true,
          expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
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
        for (const invite of state.invites)
          if (invite.paymentId === payment.id && !invite.signedAt)
            invite.revoked = true;
        break;
      }
    }
    return json({ workspace: clientWorkspace(await writeState(state)), link });
  } catch (error) {
    return fail(error);
  }
}
