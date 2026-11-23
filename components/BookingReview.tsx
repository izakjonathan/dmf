"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  money,
  type ArtistPerformance,
  type ContractOffer,
  type SignedContract,
} from "@/lib/model";
import { ContractTerms } from "./Contract";

type Review = {
  act: string;
  date: string;
  performance: ArtistPerformance;
  organizer: { legalName: string; address: string; cvr: string };
  fee: number;
  dueOn: string;
  returnBy: string;
  members: Array<{ id: string; name: string; email: string; method: string }>;
  template: { url: string };
  review: string;
  countersign?: boolean;
  terms?: Array<
    Pick<
      SignedContract,
      "performer" | "performerSigner" | "performerSignedAt"
    > & { offer: ContractOffer }
  >;
};

export default function BookingReview({ id }: { id: string }) {
  const [review, setReview] = useState<Review>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true);
      setError("");
      setReview(undefined);
      try {
        const response = await fetch(
          "/api/sheet-approval?id=" + encodeURIComponent(id),
          { signal },
        );
        const result = await response.json();
        if (!response.ok) throw Error(result.error);
        if (result.signed)
          setMessage(
            "The company signature is already recorded. Open the booking to check artist signatures.",
          );
        else setReview(result);
      } catch (error) {
        if (!signal?.aborted) setError((error as Error).message);
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [id],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function sign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review || busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/sheet-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sign",
          id,
          timestamp: Date.now(),
          review: review.review,
          signer: fields.get("signer"),
          accepted: fields.get("accepted") === "on",
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) setReview(undefined);
        throw Error(result.error);
      }
      setMessage(result.message);
      setReview(undefined);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="booking-form" aria-labelledby="approval-heading">
      <a href={"/?booking=" + id}>Back to booking</a>
      <h2 id="approval-heading">
        {review?.countersign
          ? "Countersign completed performance"
          : "Review booking contracts"}
      </h2>
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          {!review && (
            <button
              className="link"
              onClick={() => void load()}
              disabled={busy}
            >
              Load latest terms
            </button>
          )}
        </p>
      )}
      {!review && !message && !error && <p role="status">Loading booking…</p>}
      {review && (
        <form onSubmit={(event) => void sign(event)}>
          <h3>
            {review.act} · {review.date}
          </h3>
          <p>
            {review.organizer.legalName} · CVR {review.organizer.cvr} ·{" "}
            {review.organizer.address}
          </p>
          <p>
            {review.performance.start}–{review.performance.end} ·{" "}
            {review.performance.sets} × {review.performance.minutesPerSet} min ·
            Soundcheck {review.performance.soundcheck}
            {review.performance.soundcheckTime &&
              " · " + review.performance.soundcheckTime}
          </p>
          {review.performance.genre && (
            <p>Genre · {review.performance.genre}</p>
          )}
          {review.performance.getIn && (
            <p>Get-in · {review.performance.getIn}</p>
          )}
          {review.performance.requests && (
            <p>Requests · {review.performance.requests}</p>
          )}
          <p>
            {money(review.fee)} per artist ·{" "}
            {money(review.fee * review.members.length)} total
          </p>
          <p>
            Payment due {review.dueOn} · Artist signatures due {review.returnBy}
          </p>
          <ul>
            {review.members.map((member) => (
              <li key={member.id}>
                {member.name} · {member.email} · {member.method}
              </li>
            ))}
          </ul>
          {review.terms?.map((contract) => (
            <details key={contract.performer.email}>
              <summary>
                {contract.performer.name} · Signed{" "}
                {contract.performerSignedAt.slice(0, 10)}
              </summary>
              <ContractTerms offer={contract.offer} />
              <p>
                {contract.performer.address} · {contract.performer.email}
              </p>
              <p>Signed by {contract.performerSigner}</p>
            </details>
          ))}
          <a href={review.template.url} target="_blank" rel="noreferrer">
            Read the DMF standard contract
          </a>
          <label>
            Company signer’s full name
            <input
              name="signer"
              autoComplete="name"
              required
              minLength={2}
              maxLength={300}
            />
          </label>
          <label className="check">
            <input type="checkbox" name="accepted" required />I confirm these
            terms and sign on behalf of the venue.
          </label>
          <button type="submit" disabled={busy}>
            {busy
              ? "Saving signature…"
              : review.countersign
                ? "Countersign and send signed copies"
                : "Confirm, sign and email artists"}
          </button>
        </form>
      )}
    </section>
  );
}
