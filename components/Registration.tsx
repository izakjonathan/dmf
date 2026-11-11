"use client";
import { useEffect, useState, type FormEvent } from "react";
import {
  dmfTemplate,
  musicianSchema,
  performerSignatureSchema,
  today,
  type ContractOffer,
  type Musician,
  type SignedContract,
} from "@/lib/model";
import { BankFields } from "./BankFields";
import { ContractReceipt, ContractTerms } from "./Contract";
import { Brand } from "./Dashboard";
type Details = {
  venue: {
    name: string;
    legalName: string;
    email: string;
    collectCpr: boolean;
  };
  profile: Partial<Musician> | null;
  offer: Omit<ContractOffer, "performerEmail"> | null;
};
function demoDetails(): Details {
  const venue = {
    name: "The Listening Room",
    legalName: "Example Venue ApS",
    email: "venue@example.com",
    collectCpr: false,
  };
  return {
    venue,
    profile: null,
    offer: {
      organizer: {
        ...venue,
        address: "Example Street 12, Copenhagen",
        cvr: "12345678",
        phone: "",
      },
      performanceDate: today(),
      start: "20:00",
      end: "22:00",
      getIn: "",
      soundcheck: "",
      sets: 2,
      minutesPerSet: 45,
      fee: 315000,
      payOn: "",
      returnBy: today(),
      specialTerms: "",
      organizerSigner: "Example Organizer",
      organizerSignedAt: new Date().toISOString(),
      template: dmfTemplate,
    },
  };
}

export default function Registration({ token }: { token: string }) {
  const demo = token === "demo";
  const [details, setDetails] = useState<Details | null>(() =>
    demo ? demoDetails() : null,
  );
  const [contract, setContract] = useState<SignedContract | null>(null);
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
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const values = { cvr: "", cpr: "", ...fields };
    const signature = details?.offer
      ? {
          name: fields.signatureName,
          accepted: fields.signatureAccepted,
          version: details.offer.template.version,
        }
      : undefined;
    setBusy(true);
    setError("");
    try {
      if (demo) {
        const profile = musicianSchema.parse(values);
        const signed = performerSignatureSchema.parse(signature);
        const { name, email, address, phone, band, cvr, payee } = profile;
        if (details?.offer)
          setContract({
            id: "Demo",
            musicianId: "Demo",
            offer: { ...details.offer, performerEmail: email },
            performer: { name, email, address, phone, band, cvr, payee },
            performerSigner: signed.name,
            performerSignedAt: new Date().toISOString(),
          });
        setSaved(true);
        return;
      }
      const response = await fetch(
        "/api/register/" + encodeURIComponent(token),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...values, signature }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      setContract(result.contract ?? null);
      setSaved(true);
    } catch (e) {
      setError(
        e instanceof Error && "issues" in e && Array.isArray(e.issues)
          ? e.issues[0]?.message || "Check the form and try again."
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="gate registration">
      <div className="registration-intro">
        <div className="gate-inner">
          <header>
            <Brand />
            {demo && <span className="eyebrow">Demo</span>}
          </header>
          <h1>
            Musician
            <br />
            details.
          </h1>
          {details && <p className="lead">{details.venue.name}</p>}
        </div>
      </div>
      <div className="gate-inner registration-content">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!details && !error && <p>Opening registration…</p>}
        {saved && (
          <div className="panel">
            {demo && (
              <p className="banner">
                Demo only. No agreement or details were saved.
              </p>
            )}
            {contract ? (
              <ContractReceipt contract={contract} />
            ) : (
              <h2>Details received</h2>
            )}
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
            <BankFields />
            {details.offer && (
              <section
                className="contract-signing"
                aria-labelledby="contract-heading"
              >
                <h2 id="contract-heading">DMF standard contract</h2>
                <ContractTerms offer={details.offer} />
                <label>
                  Your signature · type your full name
                  <input
                    name="signatureName"
                    autoComplete="name"
                    required
                    minLength={2}
                    maxLength={300}
                  />
                </label>
                <label className="check">
                  <input name="signatureAccepted" type="checkbox" required />{" "}
                  {demo
                    ? "Simulate accepting the DMF contract."
                    : "I have read the DMF standard contract and agree to the performance terms above."}
                </label>
              </section>
            )}
            <p className="fine">
              {details.venue.legalName} uses these details to administer
              payments and accounting. Details go to its restricted Google
              Sheet. For corrections or questions, contact {details.venue.email}
              .
            </p>
            <button disabled={busy}>
              {busy
                ? "Submitting…"
                : details.offer
                  ? demo
                    ? "Simulate signing"
                    : "Sign contract and submit"
                  : "Submit details"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
