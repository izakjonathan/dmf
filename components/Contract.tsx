"use client";

import {
  dmfTemplate,
  money,
  today,
  type ContractOffer,
  type SignedContract,
} from "@/lib/model";
import type { FormEvent } from "react";

export function ContractLink({
  template = dmfTemplate,
}: {
  template?: ContractOffer["template"];
}) {
  return (
    <a href={template.url} target="_blank" rel="noreferrer">
      Read the DMF standard contract (PDF)
    </a>
  );
}

export function OfferForm({
  busy,
  save,
}: {
  busy: boolean;
  save: (values: object) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save(Object.fromEntries(new FormData(event.currentTarget)));
  }
  return (
    <form onSubmit={submit}>
      <h2 id="workspace-dialog-title">DMF contract</h2>
      <p className="fine">
        Create a signing link for one musician and one performance.{" "}
        <ContractLink />
      </p>
      <div className="grid">
        <label>
          Musician email
          <input name="performerEmail" type="email" required />
        </label>
        <label>
          Performance date
          <input name="performanceDate" type="date" min={today()} required />
        </label>
        <label>
          Starts at
          <input name="start" type="time" required />
        </label>
        <label>
          Ends at
          <input name="end" type="time" required />
        </label>
        <label>
          Get-in (optional)
          <input name="getIn" type="time" />
        </label>
        <label>
          Soundcheck (optional)
          <input name="soundcheck" type="time" />
        </label>
        <label>
          Number of sets
          <input name="sets" type="number" min={1} max={30} required />
        </label>
        <label>
          Minutes per set
          <input
            name="minutesPerSet"
            type="number"
            min={1}
            max={720}
            required
          />
        </label>
        <label>
          Total fee for this musician (DKK)
          <input name="fee" inputMode="decimal" required />
        </label>
        <label>
          Signing deadline
          <input name="returnBy" type="date" min={today()} required />
        </label>
        <label>
          Bank transfer date (optional)
          <input name="payOn" type="date" />
          <small>
            Leave blank for the first working day after the performance.
          </small>
        </label>
      </div>
      <label>
        Special agreements (optional)
        <textarea name="specialTerms" rows={2} maxLength={2000} />
      </label>
      <label>
        Organizer signature · type your full name
        <input name="organizerSigner" required minLength={2} maxLength={300} />
      </label>
      <label className="check">
        <input name="accepted" type="checkbox" required /> I agree to the DMF
        terms and sign for the organizer.
      </label>
      <button disabled={busy}>
        {busy ? "Creating link…" : "Sign and copy link"}
      </button>
    </form>
  );
}

function signedDate(value: string) {
  return new Intl.DateTimeFormat("en-DK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Copenhagen",
  }).format(new Date(value));
}

export function ContractTerms({
  offer,
}: {
  offer: Omit<ContractOffer, "performerEmail">;
}) {
  const organizer = offer.organizer;
  return (
    <>
      <p>
        <ContractLink template={offer.template} />
      </p>
      <dl className="contract-terms">
        <dt>Organizer</dt>
        <dd>
          {organizer.legalName}
          <br />
          {organizer.address}
          <br />
          CVR {organizer.cvr}
          <br />
          {organizer.email}
          {organizer.phone && <> · {organizer.phone}</>}
        </dd>
        <dt>Venue</dt>
        <dd>
          {organizer.name} · {organizer.address}
        </dd>
        <dt>Performance</dt>
        <dd>
          {offer.performanceDate} · {offer.start}–{offer.end}
          {offer.end < offer.start && " (ends next day)"}
          <br />
          {offer.sets} × {offer.minutesPerSet} min
        </dd>
        {offer.getIn && (
          <>
            <dt>Get-in</dt>
            <dd>{offer.getIn}</dd>
          </>
        )}
        {offer.soundcheck && (
          <>
            <dt>Soundcheck</dt>
            <dd>{offer.soundcheck}</dd>
          </>
        )}
        <dt>Fee</dt>
        <dd>{money(offer.fee)}</dd>
        <dt>Payment</dt>
        <dd>
          Bank transfer{" "}
          {offer.payOn || "on the first working day after the performance"}
        </dd>
        <dt>Sign by</dt>
        <dd>{offer.returnBy}</dd>
        {offer.specialTerms && (
          <>
            <dt>Special agreements</dt>
            <dd>{offer.specialTerms}</dd>
          </>
        )}
        <dt>Organizer signed</dt>
        <dd>
          {offer.organizerSigner}
          <br />
          {signedDate(offer.organizerSignedAt)} (Copenhagen time)
        </dd>
      </dl>
    </>
  );
}

export function ContractReceipt({
  contract,
  inDialog = false,
}: {
  contract: SignedContract;
  inDialog?: boolean;
}) {
  return (
    <article className="contract-receipt">
      <h2 id={inDialog ? "workspace-dialog-title" : undefined}>
        Signed DMF contract
      </h2>
      <p className="fine">Contract ID {contract.id}</p>
      <ContractTerms offer={contract.offer} />
      <dl className="contract-terms">
        <dt>Musician</dt>
        <dd>
          {contract.performer.name}
          <br />
          {contract.performer.address}
          <br />
          {contract.performer.email}
          {contract.performer.phone && <> · {contract.performer.phone}</>}
        </dd>
        {contract.performer.band && (
          <>
            <dt>Band</dt>
            <dd>{contract.performer.band}</dd>
          </>
        )}
        {contract.performer.cvr && (
          <>
            <dt>CVR</dt>
            <dd>{contract.performer.cvr}</dd>
          </>
        )}
        <dt>Musician signed</dt>
        <dd>
          {contract.performerSigner}
          <br />
          {signedDate(contract.performerSignedAt)} (Copenhagen time)
        </dd>
      </dl>
      <button
        className="secondary print-contract"
        onClick={() => window.print()}
      >
        Print or save as PDF
      </button>
    </article>
  );
}
