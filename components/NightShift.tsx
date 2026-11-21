"use client";

import { useCallback, useEffect, useState } from "react";
import type { Booking } from "@/lib/bookings";
import { today } from "@/lib/model";
import { AttendanceEditor, type AttendanceInput } from "./AttendanceEditor";
import { ViewportTheme } from "./ViewportTheme";

type Act = Pick<
  Booking,
  | "id"
  | "act"
  | "date"
  | "expectedMembers"
  | "performance"
  | "confirmedAt"
  | "confirmedBy"
  | "attendanceNote"
  | "cancelled"
  | "sourceError"
> & {
  attendanceLocked: boolean;
  contractStatus: string;
  members: Pick<Booking["members"][number], "id" | "name" | "attendance">[];
};
type Night = { staff: { day: string; name: string }; bookings: Act[] };

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

  async function save(id: string, data: AttendanceInput) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setNight(await request({ action: "attendance", id, data }));
      setNotice("Performance recorded.");
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
        {night && (
          <p>
            {night.staff.day.split("-").reverse().join("/")} ·{" "}
            {night.staff.name}
          </p>
        )}
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
      {night?.bookings
        .slice()
        .sort((a, b) =>
          (a.performance?.start || "99:99").localeCompare(
            b.performance?.start || "99:99",
          ),
        )
        .map((act) => {
          const missing = Math.max(0, act.expectedMembers - act.members.length);
          const completeAttendance = act.members.every(
            (member) => member.attendance,
          );
          const canRecord =
            !act.cancelled &&
            !act.sourceError &&
            !act.attendanceLocked &&
            act.date <= today();
          return (
            <details key={act.id} className="night-act booking-act-card">
              <summary className="act-card-summary">
                <span className="act-card-title">
                  <strong>{act.act}</strong>
                  <small>
                    {act.cancelled
                      ? "Cancelled"
                      : act.confirmedAt && completeAttendance
                        ? "Attendance recorded"
                        : missing
                          ? missing + " registrations missing"
                          : "Registration complete"}
                  </small>
                </span>
                <span className="act-card-meta">
                  {act.performance?.start || "Time pending"}
                  <span className="card-chevron" aria-hidden="true" />
                </span>
              </summary>
              <div className="act-card-body">
                {act.performance ? (
                  <p>
                    <strong>
                      {act.performance.start}–{act.performance.end}
                    </strong>{" "}
                    · {act.performance.sets} × {act.performance.minutesPerSet}{" "}
                    min · Soundcheck {act.performance.soundcheck.toLowerCase()}
                  </p>
                ) : (
                  <p>Schedule pending</p>
                )}
                <p className="fine">{act.contractStatus}</p>
                {act.performance?.requests && (
                  <p className="fine">{act.performance.requests}</p>
                )}
                {act.members.length > 0 && (
                  <ul className="night-members">
                    {act.members.map((member) => (
                      <li key={member.id}>{member.name}</li>
                    ))}
                  </ul>
                )}
                {act.confirmedAt && (
                  <p className="fine">
                    Recorded by {act.confirmedBy}
                    {act.attendanceNote && " · " + act.attendanceNote}
                  </p>
                )}
                {act.sourceError && <p className="fine">{act.sourceError}</p>}
                {act.date > today() && (
                  <p className="fine">
                    Attendance opens on the performance date.
                  </p>
                )}
                {canRecord && !missing && !act.confirmedAt && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void save(act.id, {
                        by: night.staff.name,
                        note: "",
                        members: act.members.map((member) => ({
                          id: member.id,
                          status: "played",
                        })),
                      })
                    }
                  >
                    Everyone played as agreed
                  </button>
                )}
                {canRecord && (
                  <AttendanceEditor
                    booking={act}
                    busy={busy}
                    by={night.staff.name}
                    onSave={(data) => void save(act.id, data)}
                  />
                )}
              </div>
            </details>
          );
        })}
    </main>
  );
}
