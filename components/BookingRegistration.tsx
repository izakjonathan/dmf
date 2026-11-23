"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { Booking } from "@/lib/bookings";
import type { Musician } from "@/lib/model";
import { money } from "@/lib/model";
import { ArtistPerformanceFields } from "./Contract";
import { BankFields } from "./BankFields";
import { Brand } from "./Dashboard";
import { ViewportTheme } from "./ViewportTheme";
import { PrivacyNotice } from "./PrivacyNotice";
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
  > & {
    registered: number;
    approved: boolean;
    artistFirst?: boolean;
    venueFee?: boolean;
  };
  venue: {
    name: string;
    email: string;
    legalName: string;
    collectCpr: boolean;
  };
  promotion?: Booking["promotion"];
  email?: string;
  isContact?: boolean;
  sharedPath?: string;
  profile?: Musician | null;
  registered?: boolean;
  paymentType?: string;
};
export default function BookingRegistration({ token }: { token: string }) {
  const [details, setDetails] = useState<Details>();
  const [verification, setVerification] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [payee, setPayee] = useState("Individual");
  const [paymentType, setPaymentType] = useState("");
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
          setPaymentType(
            data.paymentType || data.profile?.preferredPaymentType || "",
          );
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  const [copyMessage, setCopyMessage] = useState("");
  async function copySharedLink() {
    const url = location.origin + details!.sharedPath;
    try {
      await navigator.clipboard.writeText(url);
      setCopyMessage("Musician registration link copied.");
    } catch {
      setCopyMessage(url);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>, action: string) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const payload =
      action === "act"
        ? {
            performance: fields,
            expectedMembers: fields.expectedMembers,
            fee: details!.booking.venueFee
              ? details!.booking.fee
              : Math.round(Number(fields.fee) * 100),
            promotion: {
              bio: fields.bio,
              photoUrl: fields.photoUrl,
              website: fields.website,
            },
          }
        : action === "register"
          ? {
              profile: {
                cpr: "",
                cvr: "",
                band: details!.booking.act,
                ...fields,
                email: details!.email || fields.email,
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
        body: JSON.stringify({
          action,
          verification,
          privacyAcknowledged: fields.privacyAcknowledged,
          ...payload,
        }),
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
            ? "Your details are saved for this booking. Check your email for the signing link once the lineup is complete."
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
              {details.booking.performance
                ? `${details.booking.registered} of ${details.booking.expectedMembers} musicians registered.`
                : `${details.booking.registered} registered. The band contact will confirm the lineup size.`}{" "}
              Each musician needs to register before playing.
            </p>
            {details.booking.approved ? (
              <div className="panel">
                <h2>Registration complete</h2>
                <p>
                  Check your inbox for your individual signing request. Contact{" "}
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
                      musician registration link with every performing musician.
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
                          defaultValue={Math.max(
                            details.booking.registered,
                            details.booking.expectedMembers,
                          )}
                        />
                      </label>
                      {details.booking.venueFee ? (
                        <p>
                          Agreed fee per musician · {money(details.booking.fee)}
                        </p>
                      ) : (
                        <label>
                          Agreed fee per musician (DKK)
                          <input
                            name="fee"
                            type="number"
                            min="0.01"
                            step="0.01"
                            required
                            defaultValue={
                              details.booking.fee
                                ? details.booking.fee / 100
                                : ""
                            }
                          />
                        </label>
                      )}
                    </div>
                    <ArtistPerformanceFields
                      value={details.booking.performance}
                    />
                    <label>
                      Act bio for promotion (optional)
                      <textarea
                        name="bio"
                        maxLength={4000}
                        defaultValue={details.promotion?.bio}
                      />
                    </label>
                    <div className="grid">
                      <label>
                        Press photo link (optional)
                        <input
                          name="photoUrl"
                          type="url"
                          maxLength={1000}
                          defaultValue={details.promotion?.photoUrl}
                        />
                      </label>
                      <label>
                        Website or social link (optional)
                        <input
                          name="website"
                          type="url"
                          maxLength={1000}
                          defaultValue={details.promotion?.website}
                        />
                      </label>
                    </div>
                    <PrivacyNotice venue={details.venue} kind="contact" />
                    <div className="row">
                      <button disabled={busy}>Save act details</button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void copySharedLink()}
                      >
                        Copy musician link
                      </button>
                    </div>
                    {copyMessage && (
                      <p className="fine" role="status">
                        {copyMessage}
                      </p>
                    )}
                  </form>
                )}
                {details.registered && !verification ? (
                  <div className="panel">
                    <h2>Thank you</h2>
                    <p>
                      Your details are saved. Your contract will be sent to your
                      email once the booking details are ready.
                    </p>
                    <p className="fine">
                      Share the musician registration link with everyone
                      performing.
                    </p>
                  </div>
                ) : (
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
                        Email
                        <input
                          name="email"
                          defaultValue={details.email}
                          type="email"
                          autoComplete="email"
                          readOnly={Boolean(details.email)}
                          required
                        />
                      </label>
                      <label>
                        Phone / Mobilepay number
                        <input
                          name="phone"
                          type="tel"
                          autoComplete="tel"
                          defaultValue={details.profile?.phone}
                          maxLength={300}
                          required={paymentType === "Mobilepay"}
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
                    <label>
                      Preferred payment method
                      <select
                        name="preferredPaymentType"
                        value={paymentType}
                        onChange={(e) => setPaymentType(e.target.value)}
                        required
                      >
                        <option value="" disabled>
                          Select payment method
                        </option>
                        <option>Cash</option>
                        <option>Bank transfer</option>
                        <option>Mobilepay</option>
                      </select>
                    </label>
                    {paymentType === "Bank transfer" && (
                      <BankFields profile={details.profile || undefined} />
                    )}
                    <p className="fine">
                      {paymentType && <>Payment method · {paymentType}. </>}{" "}
                      {details.booking.fee > 0 && (
                        <>Fee per musician · {money(details.booking.fee)}.</>
                      )}
                    </p>
                    <PrivacyNotice venue={details.venue} kind="musician" />
                    <button disabled={busy}>
                      {busy ? "Saving…" : "Save my details"}
                    </button>
                  </form>
                )}
                {!verification && !details.registered && (
                  <details className="panel">
                    <summary>
                      {details.isContact
                        ? "Reuse previously saved details"
                        : "Reuse saved details or update your registration"}
                    </summary>
                    <form
                      className="booking-form"
                      onSubmit={(e) => void submit(e, "verify")}
                    >
                      <p className="fine">
                        We’ll email you a private link to use your existing
                        details or correct your entry.
                        {!details.isContact &&
                          " If you’re the booking contact, you can also use it to edit the schedule."}
                      </p>
                      <label>
                        Email
                        <input
                          name="email"
                          type="email"
                          required
                          autoComplete="email"
                        />
                      </label>
                      <button disabled={busy}>Email me a private link</button>
                    </form>
                  </details>
                )}
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
