"use client";

import { useCallback, useEffect, useState } from "react";
import { today } from "@/lib/model";
import { ViewportTheme } from "./ViewportTheme";

type Act = {
  id: string;
  act: string;
  musicianCount: number;
  genre: string;
  start: string;
  end: string;
  sets: number | null;
  minutesPerSet: number | null;
  getIn: string;
  soundcheck: "Yes" | "No" | null;
  soundcheckTime: string;
  requests: string;
  notes: string;
  attendance: "unavailable" | "pending" | "performed" | "deviation";
};
type Night = { day: string; bookings: Act[] };
type Attendance =
  | { result: "performed" }
  | { result: "deviation"; note: string };
const status = {
  unavailable: "Check with venue",
  pending: "Attendance pending",
  performed: "Performed as agreed",
  deviation: "Reported to venue",
};
export default function NightShift({ token }: { token: string }) {
  const [night, setNight] = useState<Night>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useCallback(
    async (body?: object) => {
      const response = await fetch(
        "/api/bookings?night=" + encodeURIComponent(token),
        body
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              cache: "no-store",
            }
          : { cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      return data as Night;
    },
    [token],
  );

  useEffect(() => {
    let active = true;
    request()
      .then((data) => {
        if (active) setNight(data);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [request]);

  async function save(id: string, data: Attendance) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setNight(await request({ action: "attendance", id, data }));
      setNotice(
        data.result === "deviation"
          ? "Deviation recorded for venue review."
          : "Performance recorded.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="gate-inner booking-workspace night-shift">
      <ViewportTheme />
      <header>
        <h1>Night overview</h1>
        {night && <p>{night.day.split("-").reverse().join("/")}</p>}
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="banner" role="status">
          {notice}
        </p>
      )}
      {!night && !error && <p>Opening night overview…</p>}
      {night && !night.bookings.length && <p>No acts scheduled.</p>}
      {night?.bookings.map((act) => (
        <details key={act.id} className="night-act booking-act-card">
          <summary className="act-card-summary">
            <span className="act-card-title">
              <strong>{act.act}</strong>
              <small>
                {act.musicianCount}{" "}
                {act.musicianCount === 1 ? "musician" : "musicians"} ·{" "}
                {status[act.attendance]}
              </small>
            </span>
            <span className="act-card-meta">
              {act.start || "Time pending"}
              <span className="card-chevron" aria-hidden="true" />
            </span>
          </summary>
          <div className="act-card-body">
            {act.genre && <p>{act.genre}</p>}
            {act.start ? (
              <p>
                <strong>
                  {act.start}–{act.end}
                </strong>{" "}
                · {act.sets} × {act.minutesPerSet} min
              </p>
            ) : (
              <p>Schedule pending</p>
            )}
            {act.getIn && <p>Get-in · {act.getIn}</p>}
            {act.soundcheck && (
              <p>
                Soundcheck · {act.soundcheck}
                {act.soundcheckTime && " · " + act.soundcheckTime}
              </p>
            )}
            {act.requests && <p>Special requests · {act.requests}</p>}
            {act.notes && <p className="fine">{act.notes}</p>}
            {act.attendance === "pending" && night.day > today() && (
              <p className="fine">Attendance opens on the performance date.</p>
            )}
            {act.attendance === "pending" && night.day <= today() && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save(act.id, { result: "performed" })}
                >
                  Performed as agreed
                </button>
                <details>
                  <summary>Something differed</summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const note = String(
                        new FormData(event.currentTarget).get("note") || "",
                      );
                      void save(act.id, { result: "deviation", note });
                    }}
                  >
                    <label>
                      What differed?
                      <textarea
                        name="note"
                        required
                        maxLength={2000}
                        rows={3}
                      />
                    </label>
                    <button disabled={busy}>Send to venue</button>
                  </form>
                </details>
              </>
            )}
          </div>
        </details>
      ))}
    </main>
  );
}
