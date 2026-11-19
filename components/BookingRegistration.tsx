"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { Booking } from "@/lib/bookings";
import type { Musician } from "@/lib/model";
import { money } from "@/lib/model";
import { ArtistPerformanceFields } from "./Contract";
import { BankFields } from "./BankFields";
import { Brand } from "./Dashboard";
import { ViewportTheme } from "./ViewportTheme";
type Details = {
  booking: Pick<
    Booking,
    | "date"
    | "act"
    | "expectedMembers"
    | "performance"
    | "fee"
    | "paymentType"
    | "dueOn"
  > & { registered: number; approved: boolean };
  venue: {
    name: string;
    email: string;
    legalName: string;
    collectCpr: boolean;
  };
  email?: string;
  isContact?: boolean;
  profile?: Musician | null;
  registered?: boolean;
};
export default function BookingRegistration({ token }: { token: string }) {
  const [details, setDetails] = useState<Details>();
  const [verification, setVerification] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [payee, setPayee] = useState("Individual");
  const endpoint = "/api/bookings/" + encodeURIComponent(token);
  useEffect(() => {
    let active = true;
    const proof = new URLSearchParams(location.search).get("verify") || "";
    setVerification(proof);
    fetch(endpoint + (proof ? "?verify=" + encodeURIComponent(proof) : ""))
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw Error(data.error);
        return data;
      })
      .then((data) => {
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
  }, [endpoint]);
  async function submit(event: FormEvent<HTMLFormElement>, action: string) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const payload =
      action === "act"
        ? {
            performance: fields,
            expectedMembers: fields.expectedMembers,
            fee: Math.round(Number(fields.fee) * 100),
          }
        : action === "register"
          ? {
              profile: {
                cpr: "",
                cvr: "",
                band: details!.booking.act,
                ...fields,
                email: details!.email,
              },
            }
          : { email: fields.email };
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, verification, ...payload }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Please try again.");
      if (result.booking)
        setDetails((current) => ({
          ...current!,
          ...result,
          registered: action === "register" || current?.registered,
        }));
      setMessage(
        result.message ||
          (action === "register"
            ? "Your details are saved for this booking. A contract will arrive after the company approves the agreement."
            : "Act details saved. Every performing musician must also register individually."),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="gate registration">
      <ViewportTheme />
      <div className="registration-intro">
        <div className="gate-inner">
          <header>
            <Brand />
          </header>
          <h1>Booking details</h1>
          {details && (
            <>
              <p className="lead">
                {details.booking.act} · {details.booking.date}
              </p>
              <p>{details.venue.name}</p>
            </>
          )}
        </div>
      </div>
      <div className="gate-inner registration-content">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="banner" role="status">
            {message}
          </p>
        )}
        {!details && !error && <p>Opening booking…</p>}
        {details && (
          <>
            <p className="fine">
              {details.booking.registered} of {details.booking.expectedMembers}{" "}
              musicians registered. Every musician must complete their own
              details before playing.
            </p>
            {!details.email ? (
              <form
                className="panel auth"
                onSubmit={(e) => void submit(e, "verify")}
              >
                <h2>Enter your email</h2>
                <p className="fine">
                  We will email a private link to enter your details or confirm
                  information you provided before.
                </p>
                <label>
                  Email
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                  />
                </label>
                <button disabled={busy}>
                  {busy ? "Sending…" : "Send my private link"}
                </button>
              </form>
            ) : details.booking.approved ? (
              <div className="panel">
                <h2>Agreement approved</h2>
                <p>
                  Your contract has been sent separately by email. Contact{" "}
                  {details.venue.email} if any details need changing.
                </p>
              </div>
            ) : (
              <>
                {details.isContact && (
                  <form
                    className="panel"
                    onSubmit={(e) => void submit(e, "act")}
                  >
                    <h2>Act and lineup</h2>
                    <p className="fine">
                      Complete the schedule once for the whole act. Share the
                      original booking link with every performing musician.
                    </p>
                    <div className="grid">
                      <label>
                        Number of musicians
                        <input
                          name="expectedMembers"
                          type="number"
                          required
                          min={1}
                          max={100}
                          defaultValue={details.booking.expectedMembers}
                        />
                      </label>
                      <label>
                        Agreed fee per musician (DKK)
                        <input
                          name="fee"
                          type="number"
                          min="0.01"
                          step="0.01"
                          required
                          defaultValue={
                            details.booking.fee ? details.booking.fee / 100 : ""
                          }
                        />
                      </label>
                    </div>
                    <ArtistPerformanceFields
                      value={details.booking.performance}
                    />
                    <button disabled={busy}>Save act details</button>
                  </form>
                )}
                <form
                  className="panel"
                  onSubmit={(e) => void submit(e, "register")}
                >
                  <h2>
                    {details.registered
                      ? "Confirm or update your details"
                      : "Your musician details"}
                  </h2>
                  <div className="grid">
                    <label>
                      Legal name
                      <input
                        name="name"
                        autoComplete="name"
                        defaultValue={details.profile?.name}
                        required
                        minLength={2}
                        maxLength={300}
                      />
                    </label>
                    <label>
                      Verified email
                      <input value={details.email} type="email" readOnly />
                    </label>
                    <label>
                      Phone / Mobilepay number
                      <input
                        name="phone"
                        type="tel"
                        autoComplete="tel"
                        defaultValue={details.profile?.phone}
                        maxLength={300}
                        required={details.booking.paymentType === "Mobilepay"}
                      />
                    </label>
                    <label>
                      Full address
                      <input
                        name="address"
                        autoComplete="street-address"
                        defaultValue={details.profile?.address}
                        required
                        minLength={5}
                        maxLength={300}
                      />
                    </label>
                  </div>
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
                  {payee === "Business" && (
                    <label>
                      CVR
                      <input
                        name="cvr"
                        pattern="[0-9]{8}"
                        inputMode="numeric"
                        defaultValue={details.profile?.cvr}
                        required
                      />
                    </label>
                  )}
                  {details.venue.collectCpr && (
                    <label>
                      CPR (optional)
                      <input
                        name="cpr"
                        pattern="[0-9]{6}-?[0-9]{4}"
                        autoComplete="off"
                      />
                    </label>
                  )}
                  <BankFields profile={details.profile || undefined} />
                  <p className="fine">
                    Payment method · {details.booking.paymentType}.{" "}
                    {details.booking.fee > 0 && (
                      <>Fee per musician · {money(details.booking.fee)}.</>
                    )}
                  </p>
                  <p className="fine">
                    {details.venue.legalName} uses your details for contracts,
                    payments and accounting in its restricted Google Sheet.
                    Contact {details.venue.email} for corrections.
                  </p>
                  <button disabled={busy}>
                    {busy ? "Saving…" : "Save my details"}
                  </button>
                </form>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
