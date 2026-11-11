"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { Musician } from "@/lib/model";
import { Brand } from "./Dashboard";
type Details = {
  venue: {
    name: string;
    legalName: string;
    email: string;
    collectCpr: boolean;
  };
  profile: Partial<Musician> | null;
};
export default function Registration({ token }: { token: string }) {
  const demo = token === "demo";
  const [details, setDetails] = useState<Details | null>(
    demo
      ? {
          venue: {
            name: "The Listening Room",
            legalName: "Example Venue ApS",
            email: "venue@example.com",
            collectCpr: false,
          },
          profile: null,
        }
      : null,
  );
  const [error, setError] = useState("");
  const [payee, setPayee] = useState("Individual");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (demo) return;
    let active = true;
    fetch("/api/register/" + encodeURIComponent(token))
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw Error(data.error);
        if (active) {
          setDetails(data);
          setPayee(data.profile?.payee || "Individual");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [token, demo]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (demo) {
      setSaved(true);
      return;
    }
    const values = {
      cvr: "",
      cpr: "",
      ...Object.fromEntries(new FormData(event.currentTarget)),
    };
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        "/api/register/" + encodeURIComponent(token),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        },
      );
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="gate registration">
      <header>
        <Brand />
        {demo && <span className="pill">Demo</span>}
      </header>
      <h1>Musician details</h1>
      {details && <p className="lead">{details.venue.name}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!details && !error && <p>Opening registration…</p>}
      {saved && (
        <div className="panel">
          <h2>{demo ? "Demo completed" : "Details received"}</h2>
          <p>
            {demo
              ? "The sample details were discarded."
              : "The venue can now record payments to you."}
          </p>
        </div>
      )}
      {details && !saved && (
        <form className="panel" onSubmit={submit}>
          {demo && (
            <p className="banner">Use fictional details to try this form.</p>
          )}
          <div className="grid">
            <label>
              Legal name
              <input
                name="name"
                required
                defaultValue={details.profile?.name}
              />
            </label>
            <label>
              Email
              <input
                name="email"
                type="email"
                required
                defaultValue={details.profile?.email}
              />
            </label>
            <label>
              Phone (optional)
              <input
                name="phone"
                type="tel"
                defaultValue={details.profile?.phone}
              />
            </label>
            <label>
              Band (optional)
              <input name="band" defaultValue={details.profile?.band} />
            </label>
          </div>
          <label>
            Full address
            <input
              name="address"
              required
              minLength={5}
              defaultValue={details.profile?.address}
            />
          </label>
          <label>
            Payment recipient
            <select
              name="payee"
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
            >
              <option>Individual</option>
              <option>Business</option>
            </select>
          </label>
          {payee === "Business" ? (
            <label>
              CVR
              <input
                name="cvr"
                inputMode="numeric"
                pattern="[0-9]{8}"
                required
                defaultValue={details.profile?.cvr}
              />
            </label>
          ) : (
            details.venue.collectCpr && (
              <label>
                CPR (optional)
                <input
                  name="cpr"
                  inputMode="numeric"
                  pattern="[0-9]{6}-?[0-9]{4}"
                  autoComplete="off"
                />
              </label>
            )
          )}
          <div className="grid">
            <label>
              Bank registration number
              <input
                name="registration"
                inputMode="numeric"
                pattern="[0-9]{4}"
                required
                autoComplete="off"
              />
            </label>
            <label>
              Bank account number
              <input
                name="account"
                inputMode="numeric"
                pattern="[0-9]{6,10}"
                required
                autoComplete="off"
              />
            </label>
          </div>
          <p className="fine">
            {details.venue.legalName} uses these details to administer payments
            and accounting. Details go to its restricted Google Sheet. For
            corrections or questions, contact {details.venue.email}.
          </p>
          <button disabled={busy}>
            {busy ? "Submitting…" : "Submit details"}
          </button>
        </form>
      )}
    </main>
  );
}
