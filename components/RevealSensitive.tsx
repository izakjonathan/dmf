"use client";

import { useState } from "react";

export type SensitiveDetails = Partial<
  Record<
    "cpr" | "registration" | "account" | "iban" | "mobilePayNumber",
    string
  >
>;

export function RevealSensitive({
  target,
  keys,
}: {
  target: { musicianId: string } | { bookingId: string; memberId: string };
  keys: (keyof SensitiveDetails)[];
}) {
  const [details, setDetails] = useState<SensitiveDetails>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const labels = {
    cpr: "CPR",
    registration: "Bank registration",
    account: "Account number",
    iban: "IBAN",
    mobilePayNumber: "MobilePay number",
  };
  async function reveal() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/sensitive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      setDetails(data.details);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <button
        type="button"
        className="link"
        disabled={busy}
        onClick={() => (details ? setDetails(undefined) : void reveal())}
      >
        {details ? "Hide full details" : "Reveal full details"}
      </button>
      {error && <p role="alert">{error}</p>}
      {details &&
        keys.map(
          (key) =>
            details[key] && (
              <p key={key}>
                {labels[key]} · {details[key]}
              </p>
            ),
        )}
    </div>
  );
}
