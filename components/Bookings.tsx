"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { bookingOverview, type Booking } from "@/lib/bookings";
import { dmfTemplate, money, today } from "@/lib/model";
type View = ReturnType<typeof bookingOverview>[number] & { link: string };
type Account = {
  memberId: string;
  name: string;
  email: string;
  registration?: string;
  account?: string;
  iban?: string;
  phone?: string;
  payee?: string;
  cvr?: string;
};
async function request(body?: object, query = "") {
  const response = await fetch(
    "/api/bookings" + query,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Please try again.");
  return result;
}
export default function Bookings({
  payments = false,
  onPaid,
}: {
  payments?: boolean;
  onPaid?: () => void;
}) {
  const [bookings, setBookings] = useState<View[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [past, setPast] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState("");
  const [accounts, setAccounts] = useState<Record<string, Account[]>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("Pending");
  const load = useCallback(async () => {
    try {
      const result = await request();
      setBookings(result.bookings);
      setSheet(result.sheet || "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function act(action: string, id?: string, data?: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result =
        action === "link"
          ? { link: bookings.find((booking) => booking.id === id)?.link }
          : await request({ action, id, data });
      if (result.bookings) setBookings(result.bookings);
      if (result.link) {
        const url = location.origin + result.link;
        try {
          await navigator.clipboard.writeText(url);
          setNotice("Booking link copied.");
        } catch {
          setNotice(url);
        }
      } else
        setNotice(
          result.warning ||
            (result.delivery?.failed
              ? "Saved. Some emails need attention below."
              : "Saved."),
        );
      if (action === "paid") {
        setSelected([]);
        onPaid?.();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function showAccounts(id: string) {
    setBusy(true);
    setError("");
    try {
      const result = await request(undefined, "?accounts=" + id);
      setAccounts((current) => ({ ...current, [id]: result.accounts }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const days = Array.from(
    new Set(
      bookings
        .filter((b) => (past ? b.date < today() : b.date >= today()))
        .map((b) => b.date),
    ),
  ).sort();
  if (past) days.reverse();
  const dated = bookings.filter((b) => b.date === selectedDate);
  const obligations = bookings.flatMap((booking) =>
    booking.members.map((member) => ({
      booking,
      member,
      key: booking.id + ":" + member.id,
    })),
  );
  const filtered = obligations.filter(({ booking, member }) =>
    filter === "Paid"
      ? member.status === "Paid"
      : filter === "Ready to pay"
        ? member.status === "Ready to pay"
        : filter === "Overdue"
          ? !["Paid", "Cancelled"].includes(member.status) &&
            booking.dueOn < today()
          : filter === "Needs attention"
            ? !["Ready to pay", "Paid", "Cancelled"].includes(member.status)
            : !["Paid", "Cancelled"].includes(member.status),
  );
  function values(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    return Object.fromEntries(new FormData(event.currentTarget));
  }
  return (
    <section
      className="booking-workspace"
      aria-label={payments ? "Pending payments" : "Bookings"}
    >
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
      {!loaded && <p>Loading bookings…</p>}
      {!payments ? (
        <>
          <div className="row booking-toolbar">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void act("sync")}
            >
              {busy ? "Updating…" : "Update bookings"}
            </button>
            {sheet && (
              <a className="link" href={sheet} target="_blank" rel="noreferrer">
                Open booking sheet
              </a>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={past}
                onChange={(e) => {
                  setPast(e.target.checked);
                  setSelectedDate("");
                }}
              />
              Past dates
            </label>
          </div>
          {loaded && !bookings.length && (
            <p className="panel">
              Add dates, act names, contact emails and musician counts to the
              Bookings tab in your Google Sheet, then update bookings.
              Invitations and reminders run automatically once booking
              automation is enabled.
            </p>
          )}
          {!selectedDate ? (
            <ul className="payment-list">
              {days.map((date) => {
                const acts = bookings.filter((b) => b.date === date);
                return (
                  <li key={date}>
                    <button
                      className="musician-row"
                      onClick={() => setSelectedDate(date)}
                    >
                      <span>
                        <strong>
                          {new Date(date + "T12:00:00").toLocaleDateString(
                            "en-DK",
                            {
                              weekday: "short",
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            },
                          )}
                        </strong>
                        <small>{acts.map((b) => b.act).join(" · ")}</small>
                      </span>
                      <span>
                        {acts.filter((b) => b.confirmedAt).length}/{acts.length}{" "}
                        confirmed
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <>
              <button className="link" onClick={() => setSelectedDate("")}>
                All dates
              </button>
              <h2 className="booking-date">{selectedDate}</h2>
              {dated.some((b) => !b.cancelled && !b.confirmedAt) &&
                selectedDate <= today() && (
                  <form
                    className="panel"
                    onSubmit={(e) => {
                      const fields = values(e);
                      void act("attendanceDate", undefined, {
                        date: selectedDate,
                        by: fields.by,
                      });
                    }}
                  >
                    <h2>Confirm the night</h2>
                    <p className="fine">
                      Confirm that every listed act and musician played as
                      agreed. Use an act’s exceptions form if anything changed.
                    </p>
                    <label>
                      Your full name
                      <input name="by" required minLength={2} />
                    </label>
                    <label className="check">
                      <input type="checkbox" required />
                      All acts performed as agreed
                    </label>
                    <button disabled={busy}>Confirm this date</button>
                  </form>
                )}
              {dated.map((booking) => (
                <article className="panel booking-act" key={booking.id}>
                  <div className="section-title">
                    <h2>{booking.act}</h2>
                    <button
                      className="link"
                      disabled={busy}
                      onClick={() => void act("link", booking.id)}
                    >
                      Copy booking link
                    </button>
                  </div>
                  <p>
                    {booking.members.length}/{booking.expectedMembers} musicians
                    registered ·{" "}
                    {booking.cancelled
                      ? "Cancelled"
                      : booking.approvedVersion === booking.version
                        ? "Company signed"
                        : "Awaiting approval"}
                  </p>
                  {booking.sourceError && (
                    <p className="error">{booking.sourceError}</p>
                  )}
                  <Schedule booking={booking} />
                  <p>
                    {money(booking.fee)} per musician ·{" "}
                    {money(booking.fee * booking.expectedMembers)} total ·{" "}
                    {booking.paymentType}
                  </p>
                  <ul className="payment-list">
                    {booking.members.map((member) => (
                      <li className="payment-row" key={member.id}>
                        <span>
                          <strong>{member.name}</strong>
                          <small>{member.email}</small>
                        </span>
                        <span>
                          {member.status}
                          {member.contractId &&
                            member.status === "Artist signature needed" && (
                              <button
                                className="link"
                                disabled={busy}
                                onClick={() =>
                                  void act("signingLink", booking.id, {
                                    memberId: member.id,
                                  })
                                }
                              >
                                Copy signing link
                              </button>
                            )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {!booking.cancelled &&
                    booking.approvedVersion !== booking.version &&
                    !booking.confirmedAt && (
                      <form
                        className="booking-form"
                        onSubmit={(e) => {
                          const fields = values(e);
                          void act("approve", booking.id, {
                            signer: fields.signer,
                            accepted: true,
                            fee: Math.round(Number(fields.fee) * 100),
                            dueOn: fields.dueOn,
                          });
                        }}
                      >
                        <h3>Company approval</h3>
                        <p className="fine">
                          <a
                            href={dmfTemplate.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Read the DMF standard contract
                          </a>
                        </p>
                        <div className="grid">
                          <label>
                            Fee per musician (DKK)
                            <input
                              key={booking.fee}
                              name="fee"
                              type="number"
                              min="0.01"
                              step="0.01"
                              required
                              defaultValue={booking.fee / 100 || ""}
                            />
                          </label>
                          <label>
                            Payment due
                            <input
                              name="dueOn"
                              type="date"
                              required
                              defaultValue={booking.dueOn}
                            />
                          </label>
                        </div>
                        <label>
                          Company signer’s full name
                          <input
                            name="signer"
                            required
                            minLength={2}
                            maxLength={300}
                          />
                        </label>
                        <label className="check">
                          <input type="checkbox" required />I approve the
                          lineup, schedule, fees and DMF terms and sign for the
                          company.
                        </label>
                        <button
                          disabled={
                            busy ||
                            !booking.performance ||
                            booking.members.length !== booking.expectedMembers
                          }
                        >
                          Approve, sign and send contracts
                        </button>
                      </form>
                    )}
                  {booking.approvedBy && (
                    <p className="fine">
                      Company signed by {booking.approvedBy} ·{" "}
                      {booking.approvedAt?.slice(0, 10)}
                    </p>
                  )}
                  {booking.confirmedAt && (
                    <p className="banner">
                      Performance confirmed by {booking.confirmedBy}.{" "}
                      {booking.attendanceNote}
                    </p>
                  )}
                  {!booking.cancelled &&
                    booking.approvedVersion === booking.version &&
                    booking.date <= today() &&
                    !booking.members.some((m) => m.paymentId) && (
                      <details className="booking-form">
                        <summary>
                          {booking.confirmedAt
                            ? "Correct performance confirmation"
                            : "Record performance exceptions"}
                        </summary>
                        <form
                          onSubmit={(e) => {
                            const fields = values(e);
                            void act("attendance", booking.id, {
                              by: fields.by,
                              note: fields.note,
                              members: booking.members.map((m) => ({
                                id: m.id,
                                status: fields[m.id],
                              })),
                            });
                          }}
                        >
                          {booking.members.map((m) => (
                            <label key={m.id}>
                              {m.name}
                              <select
                                name={m.id}
                                defaultValue={m.attendance || "played"}
                              >
                                <option value="played">Played as agreed</option>
                                <option value="absent">Absent</option>
                                <option value="issue">Performance issue</option>
                              </select>
                            </label>
                          ))}
                          <label>
                            What changed?
                            <textarea
                              name="note"
                              rows={2}
                              defaultValue={booking.attendanceNote}
                              maxLength={2000}
                            />
                          </label>
                          <label>
                            Your full name
                            <input name="by" required minLength={2} />
                          </label>
                          <button disabled={busy}>
                            Save performance confirmation
                          </button>
                        </form>
                      </details>
                    )}
                  <details className="booking-form">
                    <summary>Email status</summary>
                    {booking.mail.length ? (
                      booking.mail.map((mail) => (
                        <div className="invite-row" key={mail.id}>
                          <span>
                            {mail.to} · {mail.kind} · {mail.status}
                            {mail.error && <> · {mail.error}</>}
                          </span>
                          {mail.status === "failed" && (
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                void act("retry", booking.id, {
                                  mailId: mail.id,
                                })
                              }
                            >
                              Retry email
                            </button>
                          )}
                        </div>
                      ))
                    ) : (
                      <p>No emails queued yet.</p>
                    )}
                  </details>
                </article>
              ))}
            </>
          )}
          {loaded && !days.length && bookings.length > 0 && (
            <p className="panel">No dates in this view.</p>
          )}
        </>
      ) : (
        <>
          <h2>Payment queue</h2>
          <div className="row booking-filters">
            {[
              "Pending",
              "Ready to pay",
              "Needs attention",
              "Overdue",
              "Paid",
            ].map((item) => (
              <button
                key={item}
                className={filter === item ? "" : "secondary"}
                onClick={() => setFilter(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <p className="fine">
            Select payments only after processing the actual transfers or cash
            payments.
          </p>
          <div className="stats">
            <div className="stat">
              <span>Pending</span>
              <strong>
                {money(
                  obligations
                    .filter(
                      (o) => !["Paid", "Cancelled"].includes(o.member.status),
                    )
                    .reduce((sum, o) => sum + o.booking.fee, 0),
                )}
              </strong>
            </div>
            <div className="stat">
              <span>Ready</span>
              <strong>
                {money(
                  obligations
                    .filter((o) => o.member.status === "Ready to pay")
                    .reduce((sum, o) => sum + o.booking.fee, 0),
                )}
              </strong>
            </div>
          </div>
          {filtered.map(({ booking, member, key }) => (
            <article className="panel" key={key}>
              <div className="section-title">
                <label className="check">
                  <input
                    type="checkbox"
                    disabled={busy || member.status !== "Ready to pay"}
                    checked={selected.includes(key)}
                    onChange={(e) =>
                      setSelected((current) =>
                        e.target.checked
                          ? [...current, key]
                          : current.filter((v) => v !== key),
                      )
                    }
                  />
                  <strong>{member.name}</strong>
                </label>
                <strong>{money(booking.fee)}</strong>
              </div>
              <p>
                {booking.act} · {booking.date} · {booking.paymentType}
              </p>
              <p>
                {member.status} · Due {booking.dueOn}
                {booking.dueOn < today() &&
                  member.status !== "Paid" &&
                  " · Overdue"}
              </p>
              <div className="row">
                <button
                  className="link"
                  disabled={busy}
                  onClick={() => void showAccounts(booking.id)}
                >
                  Show payment details
                </button>
                <button
                  className="link"
                  disabled={busy}
                  onClick={() =>
                    setSelected((current) =>
                      Array.from(
                        new Set([
                          ...current,
                          ...obligations
                            .filter(
                              (o) =>
                                o.booking.id === booking.id &&
                                o.member.status === "Ready to pay",
                            )
                            .map((o) => o.key),
                        ]),
                      ),
                    )
                  }
                >
                  Select ready band members
                </button>
              </div>
              {accounts[booking.id]
                ?.filter((a) => a.memberId === member.id)
                .map((account) => (
                  <p className="booking-account" key={account.memberId}>
                    {account.email}
                    <br />
                    {account.iban
                      ? "IBAN " + account.iban
                      : "Reg. " +
                        (account.registration || "") +
                        " · Account " +
                        (account.account || "")}
                    <br />
                    {account.phone && (
                      <>
                        Phone / Mobilepay · {account.phone}
                        <br />
                      </>
                    )}
                    {account.payee}
                    {account.cvr && <> · CVR {account.cvr}</>}
                  </p>
                ))}
            </article>
          ))}
          {loaded && !filtered.length && (
            <p className="panel">No payments in this view.</p>
          )}
          {selected.length > 0 && (
            <form
              className="panel payment-confirm"
              onSubmit={(e) => {
                const fields = values(e);
                void act("paid", undefined, {
                  by: fields.by,
                  paidOn: fields.paidOn,
                  reference: fields.reference,
                  members: selected.map((key) => {
                    const [bookingId, memberId] = key.split(":");
                    return { bookingId, memberId };
                  }),
                });
              }}
            >
              <h2>Confirm {selected.length} processed payments</h2>
              <p>
                {money(
                  obligations
                    .filter((o) => selected.includes(o.key))
                    .reduce((sum, o) => sum + o.booking.fee, 0),
                )}{" "}
                total
              </p>
              <label>
                Actual payment date
                <input
                  name="paidOn"
                  type="date"
                  required
                  max={today()}
                  defaultValue={today()}
                />
              </label>
              <label>
                Transaction reference (optional)
                <input name="reference" maxLength={300} />
              </label>
              <label>
                Your full name
                <input name="by" required minLength={2} />
              </label>
              <label className="check">
                <input type="checkbox" required />I confirm the selected
                payments have been processed.
              </label>
              <div className="row">
                <button disabled={busy}>Mark selected as paid</button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setSelected([])}
                >
                  Clear selection
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
function Schedule({ booking }: { booking: Booking }) {
  const p = booking.performance;
  return p ? (
    <div className="booking-schedule">
      <strong>
        {p.start}–{p.end}
        {p.end < p.start && " (next day)"}
      </strong>
      <span>
        {p.sets} × {p.minutesPerSet} minutes
      </span>
      <span>Soundcheck · {p.soundcheck}</span>
      {p.requests && <p>Requests · {p.requests}</p>}
    </div>
  ) : (
    <p className="fine">
      Waiting for the band contact to complete the schedule.
    </p>
  );
}
