"use client";

import { useState } from "react";

import {
  dmfConditionsVersion,
  originalDmfPdf,
  money,
  today,
  type ArtistPerformance,
  type ContractOffer,
  type SignedContract,
} from "@/lib/model";

export function ContractLink() {
  return (
    <a href={originalDmfPdf} target="_blank" rel="noreferrer">
      View the original DMF standard contract (Danish)
    </a>
  );
}

function DmfConditions() {
  return (
    <section className="contract-conditions">
      <h3>Conditions</h3>
      <ul>
        <li>Cancellation cannot take place.</li>
        <li>If the event is open to the public, the venue pays Koda.</li>
        <li>
          No sound or video recording of the performance without prior written
          agreement.
        </li>
      </ul>
      {/* Pending legal review by DMF or the venue's lawyer. */}
      <p>
        This agreement follows the original Danish DMF Standardkontrakt. The
        Danish original prevails if the two differ.
      </p>
    </section>
  );
}

export function PaymentContractFields() {
  return (
    <fieldset className="form-fieldset">
      <legend>DMF signing request</legend>
      <p className="fine">
        <ContractLink />
      </p>
      <div className="grid">
        <label>
          Signing deadline
          <input name="returnBy" type="date" min={today()} required />
        </label>
      </div>
      <label>
        Organizer signature · type your full name
        <input name="organizerSigner" required minLength={2} maxLength={300} />
      </label>
      <label className="check">
        <input name="accepted" type="checkbox" required /> I agree to the DMF
        terms and sign for the organizer.
      </label>
    </fieldset>
  );
}

export function ArtistPerformanceFields({
  value,
  contact = false,
}: {
  value?: Partial<ArtistPerformance>;
  contact?: boolean;
}) {
  const [soundcheck, setSoundcheck] = useState(value?.soundcheck || "");
  return (
    <fieldset className="form-fieldset">
      <legend>Performance details</legend>
      <div className="grid">
        <label>
          Start time
          <input
            name="start"
            type="time"
            required
            defaultValue={value?.start}
          />
        </label>
        <label>
          End time
          <input name="end" type="time" required defaultValue={value?.end} />
        </label>
        <label>
          Soundcheck
          <select
            name="soundcheck"
            required
            value={soundcheck}
            onChange={(event) =>
              setSoundcheck(event.target.value as typeof soundcheck)
            }
          >
            <option value="" disabled>
              Select yes or no
            </option>
            <option>Yes</option>
            <option>No</option>
          </select>
        </label>
        {soundcheck === "Yes" && (
          <label>
            Soundcheck time
            <input
              name="soundcheckTime"
              type="time"
              defaultValue={value?.soundcheckTime}
              required={contact}
            />
          </label>
        )}
        {contact && (
          <>
            <label>
              Genre description
              <input name="genre" maxLength={300} defaultValue={value?.genre} />
            </label>
            <label>
              Get-in time
              <input name="getIn" type="time" defaultValue={value?.getIn} />
            </label>
          </>
        )}
        <label>
          Number of sets
          <input
            name="sets"
            type="number"
            min={1}
            max={30}
            required
            defaultValue={value?.sets}
          />
        </label>
        <label>
          Minutes per set
          <input
            name="minutesPerSet"
            type="number"
            min={1}
            max={720}
            required
            defaultValue={value?.minutesPerSet}
          />
        </label>
      </div>
      {contact && (
        <label>
          Technical notes (optional)
          <textarea
            name="technicalNotes"
            maxLength={1000}
            rows={2}
            defaultValue={value?.technicalNotes}
          />
        </label>
      )}
      <label>
        Requests (optional)
        <textarea
          aria-label="Requests for venue technicians. Leave out personal details."
          name="requests"
          rows={2}
          maxLength={2000}
          defaultValue={value?.requests}
        />
      </label>
    </fieldset>
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
  recordedPayment = false,
}: {
  offer: Omit<ContractOffer, "performerEmail">;
  recordedPayment?: boolean;
}) {
  const organizer = offer.organizer;
  return (
    <>
      <p>
        <ContractLink />
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
        {offer.bookingAct && (
          <>
            <dt>Act</dt>
            <dd>
              {offer.bookingAct}
              {offer.bookedMusicians
                ? ` · ${offer.bookedMusicians} musicians`
                : ""}
            </dd>
          </>
        )}
        <dt>Performance</dt>
        <dd>
          {offer.performanceDate}
          {offer.start && offer.end && (
            <>
              {" "}
              · {offer.start}–{offer.end}
            </>
          )}
          {offer.start &&
            offer.end &&
            offer.end < offer.start &&
            " (ends next day)"}
          <br />
          {offer.sets && offer.minutesPerSet ? (
            <>
              {offer.sets} × {offer.minutesPerSet} min
            </>
          ) : (
            "Artist supplies performance details when signing."
          )}
        </dd>
        {offer.getIn && (
          <>
            <dt>Get-in</dt>
            <dd>{offer.getIn}</dd>
          </>
        )}
        {offer.genre && (
          <>
            <dt>Genre</dt>
            <dd>{offer.genre}</dd>
          </>
        )}
        {(offer.soundcheck || offer.soundcheckRequired) && (
          <>
            <dt>Soundcheck</dt>
            <dd>{offer.soundcheck || offer.soundcheckRequired}</dd>
          </>
        )}
        <dt>Fee</dt>
        <dd>{money(offer.fee)}</dd>
        <dt>{recordedPayment ? "Payment date" : "Payment"}</dt>
        <dd>
          {recordedPayment
            ? offer.payOn
            : (offer.paymentType || "Bank transfer") +
              " " +
              (offer.payOn || "on the first working day after the performance")}
        </dd>
        {offer.requests && (
          <>
            <dt>Requests</dt>
            <dd>{offer.requests}</dd>
          </>
        )}
        {recordedPayment && offer.paymentType && (
          <>
            <dt>Payment type</dt>
            <dd>{offer.paymentType}</dd>
          </>
        )}
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
          {offer.organizerSignedAt ? (
            <>
              {offer.organizerSigner}
              <br />
              {signedDate(offer.organizerSignedAt)} (Copenhagen time)
            </>
          ) : (
            "Awaiting venue signature after the show"
          )}
        </dd>
      </dl>
      {offer.conditionsVersion === dmfConditionsVersion && <DmfConditions />}
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
        {contract.offer.organizerSignedAt
          ? "Signed DMF contract"
          : "Musician signature recorded"}
      </h2>
      <p className="fine">Contract ID {contract.id}</p>
      <ContractTerms
        offer={contract.offer}
        recordedPayment={Boolean(contract.paymentId)}
      />
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
