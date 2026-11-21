import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
import * as model from "../lib/model.ts";
import * as bookingModel from "../lib/bookings.ts";

test("booking API completes registration, signatures, attendance and payment without exposing another musician's bank details", async () => {
  let state = model.demoWorkspace();
  const contact = state.musicians[0];
  const musician = state.musicians[1];
  const bookingId = crypto.randomUUID();
  const bookingToken = "a".repeat(64);
  let administrator = true;
  state.bookings = [
    {
      id: bookingId,
      date: model.today(),
      act: "Sofie Lund Trio",
      contactEmail: contact.email,
      expectedMembers: 2,
      fee: 315000,
      dueOn: model.today(),
      paymentType: "Bank transfer",
      version: 1,
      members: [],
    },
  ];
  const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
  class RequestError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  }
  const server = {
    admin: async () => {
      if (!administrator) throw new RequestError("Sign in", 401);
    },
    sameOrigin: (req: Request) => {
      assert.equal(req.headers.get("origin"), "https://example.com");
    },
    bookingToken: (id: string) => (id === bookingId ? bookingToken : hash(id)),
    bookingContractToken: (id: string) => hash("sign:" + id),
    token: () => hash(crypto.randomUUID()),
    hash,
    equals: (a: string, b: string) => a === b,
    RequestError,
    readState: async () => structuredClone(state),
    writeState: async (next: typeof state) => {
      assert.equal(next.revision, state.revision);
      state = structuredClone({ ...next, revision: next.revision + 1 });
      return structuredClone(state);
    },
    dispatchBookingMail: async () => {
      for (const mail of state.bookingMail || [])
        if (mail.status === "pending") {
          mail.status = "sent";
          mail.sentAt = new Date().toISOString();
        }
      state.revision++;
      return {
        state: structuredClone(state),
        delivery: { sent: 1, failed: 0 },
      };
    },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
    fail: (error: any) =>
      Response.json({ error: error.message }, { status: error.status || 400 }),
    spreadsheet: () => "https://docs.google.com/spreadsheets/d/example/edit",
    paymentSigningPath: (invite: any) =>
      "/register/" + hash("sign:" + invite.id),
    findInvite: (current: typeof state, raw: string) => {
      const invite = current.invites.find(
        (i) => i.hash === hash(raw) && !i.revoked,
      );
      if (!invite) throw new RequestError("Invalid invite");
      return invite;
    },
  };
  function route(path: string): any {
    const code = ts.transpileModule(
      readFileSync(new URL(path, import.meta.url), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    const exports = {};
    runInNewContext(code, {
      exports,
      require: (name: string) => {
        if (name === "@/lib/server") return server;
        if (name === "@/lib/model") return model;
        if (name === "@/lib/bookings") return bookingModel;
        if (name === "zod")
          return { z: (model.venueSchema as any)._def ? requireZod : null };
        throw Error(name);
      },
      crypto,
      Buffer,
      URL,
      Date,
      console,
    });
    return exports;
  }
  const { z: requireZod } = await import("zod");
  const artist = route("../app/api/bookings/[token]/route.ts");
  const owner = route("../app/api/bookings/route.ts");
  const signing = route("../app/api/register/[token]/route.ts");
  const context = { params: Promise.resolve({ token: bookingToken }) };
  const post = (body: unknown, url = "https://example.com/api/bookings") =>
    new Request(url, {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const publicResult = await (
    await artist.GET(
      new Request("https://example.com/api/bookings/" + bookingToken),
      context,
    )
  ).json();
  assert.equal(publicResult.profile, undefined);
  assert.equal(publicResult.email, undefined);
  // The shared invitation must accept details immediately, without an email round trip.
  const beforeDirectRegistration = structuredClone(state);
  const direct = await artist.POST(
    post({
      action: "register",
      profile: {
        ...contact,
        account: "1234567890",
        preferredPaymentType: "Bank transfer",
      },
    }),
    context,
  );
  assert.equal(direct.status, 200);
  assert.equal(state.bookings![0].members.length, 1);
  assert.equal(
    state.bookingMail?.filter((m) => m.kind === "verification").length || 0,
    0,
  );
  assert.equal(
    state.musicians.find((m) => m.id === contact.id)!.account,
    contact.account,
  );
  assert.notEqual(state.bookings![0].members[0].musicianId, contact.id);
  assert.equal((await direct.json()).profile, undefined);
  assert.equal(
    (
      await artist.POST(
        post({
          action: "register",
          profile: { ...contact, preferredPaymentType: "Cash" },
        }),
        context,
      )
    ).status,
    409,
  );
  const shared = await (
    await artist.GET(
      new Request("https://example.com/api/bookings/" + bookingToken),
      context,
    )
  ).json();
  assert.equal(shared.profile, undefined);
  assert.equal(shared.email, undefined);
  const directAct = await artist.POST(
    post({
      action: "act",
      performance: {
        start: "21:00",
        end: "00:00",
        sets: 2,
        minutesPerSet: 45,
        soundcheck: "Yes",
        requests: "Microphone",
      },
      expectedMembers: 2,
      fee: 315000,
    }),
    context,
  );
  assert.equal(directAct.status, 403);
  const privateToken = server.bookingToken(
    bookingModel.contactBookingId(state.bookings![0]),
  );
  const privateAct = await artist.POST(
    post({
      action: "act",
      performance: {
        start: "21:00",
        end: "00:00",
        sets: 2,
        minutesPerSet: 45,
        soundcheck: "Yes",
      },
      expectedMembers: 2,
      fee: 315000,
    }),
    { params: Promise.resolve({ token: privateToken }) },
  );
  assert.equal(privateAct.status, 200);
  state = beforeDirectRegistration;
  const proofs = new Map<string, string>();
  for (const person of [contact, musician]) {
    const response = await artist.POST(
      post({ action: "verify", email: person.email }),
      context,
    );
    assert.equal(response.status, 200);
    const mail = state
      .bookingMail!.filter(
        (m) => m.kind === "verification" && m.to === person.email,
      )
      .at(-1)!;
    const proof = mail.body.match(/verify=([a-f0-9]{64})/)![1];
    proofs.set(person.email, proof);
    const verified = await (
      await artist.GET(
        new Request(
          "https://example.com/api/bookings/" +
            bookingToken +
            "?verify=" +
            proof,
        ),
        context,
      )
    ).json();
    assert.equal(verified.profile.email, person.email);
    assert.equal(verified.profile.account, person.account);
    assert.equal(verified.profile.cpr, undefined);
    const submitted = await artist.POST(
      post({
        action: "register",
        verification: proof,
        profile: { ...person, preferredPaymentType: "Bank transfer" },
      }),
      context,
    );
    assert.equal(submitted.status, 200);
  }
  const schedule = {
    start: "21:00",
    end: "00:00",
    sets: 2,
    minutesPerSet: 45,
    soundcheck: "Yes",
    requests: "Microphone",
  };
  const unauthorisedAct = await artist.POST(
    post({
      action: "act",
      verification: proofs.get(musician.email),
      performance: schedule,
      expectedMembers: 2,
      fee: 315000,
    }),
    context,
  );
  assert.equal(unauthorisedAct.status, 403);
  const updatedAct = await artist.POST(
    post({
      action: "act",
      verification: proofs.get(contact.email),
      performance: schedule,
      expectedMembers: 2,
      fee: 315000,
    }),
    context,
  );
  assert.equal(updatedAct.status, 200);
  administrator = false;
  assert.equal(
    (
      await owner.GET(
        new Request("https://example.com/api/bookings?accounts=" + bookingId),
      )
    ).status,
    401,
  );
  administrator = true;
  const staffLinkResponse = await owner.POST(
    post({
      action: "staffLink",
      data: { day: model.today(), name: "Night Employee" },
    }),
  );
  assert.equal(staffLinkResponse.status, 200);
  const staffLink = (await staffLinkResponse.json()).link.split("/").pop();
  const staffEndpoint = "https://example.com/api/bookings?night=" + staffLink;
  administrator = false;
  const staffView = await (await owner.GET(new Request(staffEndpoint))).json();
  assert.equal(staffView.staff.name, "Night Employee");
  assert.equal(staffView.bookings[0].members[0].email, undefined);
  assert.equal(staffView.bookings[0].members[0].payout, undefined);
  assert.equal(staffView.bookings[0].fee, undefined);
  assert.equal(
    (await owner.POST(post({ action: "paid" }, staffEndpoint))).status,
    403,
  );
  const attended = await owner.POST(
    post(
      {
        action: "attendance",
        id: bookingId,
        data: {
          by: "Untrusted name",
          members: state.bookings![0].members.map((m) => ({
            id: m.id,
            status: "played",
          })),
        },
      },
      staffEndpoint,
    ),
  );
  assert.equal(attended.status, 200);
  assert.equal(state.bookings![0].confirmedBy, "Night Employee");
  administrator = true;
  assert.equal(
    (
      await owner.POST(
        post({ action: "revokeStaff", data: { day: model.today() } }),
      )
    ).status,
    200,
  );
  assert.equal((await owner.GET(new Request(staffEndpoint))).status, 403);
  const approved = await owner.POST(
    post({
      action: "approve",
      id: bookingId,
      data: {
        signer: "Venue Owner",
        accepted: true,
        fee: 315000,
        dueOn: model.today(),
      },
    }),
  );
  assert.equal(approved.status, 200);
  const historyCount = state.payments.length;
  const oldInvite = state.invites.find((i) => i.bookingId === bookingId)!;
  const reissued = await owner.POST(
    post({
      action: "reissue",
      id: bookingId,
      data: { memberId: oldInvite.memberId, returnBy: "2099-01-01" },
    }),
  );
  assert.equal(reissued.status, 200);
  assert.equal(state.invites.find((i) => i.id === oldInvite.id)?.revoked, true);
  const replacement = state.invites.find(
    (i) => i.memberId === oldInvite.memberId && !i.revoked,
  )!;
  assert.equal(
    replacement.offer!.organizerSignedAt,
    oldInvite.offer!.organizerSignedAt,
  );
  assert.equal(replacement.offer!.returnBy, "2099-01-01");
  for (const invite of state.invites.filter(
    (i) => i.bookingId === bookingId && !i.revoked,
  )) {
    const raw = hash("sign:" + invite.id);
    const ctx = { params: Promise.resolve({ token: raw }) };
    const form = {
      email: invite.offer!.performerEmail,
      signature: {
        name: invite.performer!.name,
        accepted: "on",
        version: model.dmfTemplate.version,
      },
    };
    const wrongEmail = await signing.POST(
      post({ ...form, email: "other@example.com" }),
      ctx,
    );
    assert.equal(wrongEmail.status, 403);
    const signed = await signing.POST(post(form), ctx);
    assert.equal(signed.status, 200);
    assert.equal((await signing.POST(post(form), ctx)).status, 409);
  }
  assert.equal(state.payments.length, historyCount);
  const members = state.bookings![0].members.map((m) => ({
    bookingId,
    memberId: m.id,
  }));
  const paid = await owner.POST(
    post({
      action: "paid",
      data: {
        members,
        by: "Venue Owner",
        paidOn: model.today(),
        reference: "Bank batch 19",
      },
    }),
  );
  assert.equal(paid.status, 200);
  assert.equal(state.payments.length, historyCount + 2);
  assert.ok(state.bookings![0].members.every((m) => m.paymentId));
  assert.equal(
    (
      await owner.POST(
        post({
          action: "paid",
          data: { members, by: "Owner", paidOn: model.today() },
        }),
      )
    ).status,
    400,
  );
});
