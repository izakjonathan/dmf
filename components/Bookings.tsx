"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { bookingOverview, signingDeadline, type Booking } from "@/lib/bookings";
import { AttendanceEditor } from "./AttendanceEditor";
import { money, today } from "@/lib/model";
function bookingDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}
type View = ReturnType<typeof bookingOverview>[number] & {
  link: string;
  contactLink: string;
};
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
  contracts = false,
  focusBooking = "",
  onPaid,
}: {
  payments?: boolean;
  contracts?: boolean;
  focusBooking?: string;
  onPaid?: () => void;
}) {
  const [bookings, setBookings] = useState<View[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [past, setPast] = useState(false);
  const [management, setManagement] = useState(false);
  const [employee, setEmployee] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState("");
  const [accounts, setAccounts] = useState<Record<string, Account[]>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("Pending");
  const requestGeneration = useRef(0);
  const saving = useRef(false);
  const bookingRequest = useRef("");
  const [updated, setUpdated] = useState("");
  const load = useCallback(async () => {
    if (saving.current) return;
    const generation = ++requestGeneration.current;
    try {
      const result = await request();
      if (generation !== requestGeneration.current) return;
      setBookings(result.bookings);
      setAccounts({});
      const ready = new Set<string>(
        result.bookings.flatMap((b: View) =>
          b.members
            .filter((m) => m.status === "Ready to pay")
            .map((m) => b.id + ":" + m.id),
        ),
      );
      setSelected((current) => current.filter((key) => ready.has(key)));
      setUpdated(
        new Date().toLocaleTimeString("en-DK", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
      setSheet(result.sheet || "");
    } catch (e) {
      if (generation === requestGeneration.current)
        setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    const savedDate = sessionStorage.getItem("stagebook-booking-date");
    const savedEmployee = sessionStorage.getItem("stagebook-employee");
    if (savedDate) {
      setSelectedDate(savedDate);
      setPast(savedDate < today());
    }
    if (savedEmployee) setEmployee(savedEmployee);
    void load();
    const refresh = () => {
      if (!document.hidden) void load();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  useEffect(() => {
    if (!focusBooking || payments || contracts) return;
    const booking = bookings.find((item) => item.id === focusBooking);
    if (!booking) return;
    setSelectedDate(booking.date);
    setPast(booking.date < today());
    setManagement(true);
  }, [focusBooking, payments, contracts, bookings.length]);
  function chooseDate(date: string) {
    setSelectedDate(date);
    sessionStorage.setItem("stagebook-booking-date", date);
  }
  async function act(action: string, id?: string, data?: unknown) {
    if (saving.current) return;
    saving.current = true;
    requestGeneration.current++;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result =
        action === "link" || action === "contactLink"
          ? {
              link: bookings.find((booking) => booking.id === id)?.[
                action === "link" ? "link" : "contactLink"
              ],
            }
          : await request({ action, id, data });
      if (action === "createBooking") bookingRequest.current = "";
      if (result.bookingDate) {
        setPast(result.bookingDate < today());
        chooseDate(result.bookingDate);
        setManagement(true);
      }
      if (result.bookings) {
        setBookings(result.bookings);
        setUpdated(
          new Date().toLocaleTimeString("en-DK", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        );
      }
      if (result.link) {
        const url = location.origin + result.link;
        try {
          await navigator.clipboard.writeText(url);
          setNotice(
            {
              link: "Musician registration link copied.",
              contactLink: "Private band contact link copied.",
              staffLink:
                "Staff link copied. Share it with the named staff member only.",
              signingLink: "Signing link copied.",
            }[action] || "Link copied.",
          );
        } catch {
          setNotice(url);
        }
      } else
        setNotice(
          result.message ||
            result.warning ||
            (result.delivery?.failed
              ? "Saved. Some emails need attention below."
              : {
                  correctBooking:
                    "Booking reopened. Review the corrected terms before issuing new contracts.",
                  issueContracts:
                    "Contracts queued. Check email status for delivery.",
                  approve:
                    "Company signature saved. Check email status for each signing request.",
                  resendInvitation:
                    "Current invitation queued for the next email run.",
                  reissue:
                    "New signing link created. Check email status for delivery.",
                  attendance: "Performance recorded.",
                  attendanceDate: "Night confirmed.",
                  paid: "Processed payments recorded.",
                  sync: "Bookings updated from Google Sheets.",
                  retry:
                    "Email retry completed. Check email status for delivery.",
                }[action] || "Saved."),
        );
      if (action === "paid") {
        setSelected([]);
        onPaid?.();
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      saving.current = false;
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
  const dated = bookings
    .filter((b) => b.date === selectedDate)
    .sort((a, b) =>
      (a.performance?.start || "99:99").localeCompare(
        b.performance?.start || "99:99",
      ),
    );
  const scopedBookings =
    payments && focusBooking
      ? bookings.filter((booking) => booking.id === focusBooking)
      : bookings;
  const obligations = scopedBookings.flatMap((booking) =>
    booking.members.map((member) => ({
      booking,
      member,
      key: booking.id + ":" + member.id,
    })),
  );
  const unregistered = scopedBookings
    .filter((b) => !b.cancelled)
    .map((b) => ({
      booking: b,
      missing: b.performance
        ? Math.max(0, b.expectedMembers - b.members.length)
        : 0,
    }))
    .filter((entry) => entry.missing > 0);
  const missingCost = unregistered.reduce(
    (sum, { booking, missing }) => sum + booking.fee * missing,
    0,
  );
  const unconfirmedLineups = scopedBookings.filter(
    (b) => !b.cancelled && !b.performance,
  ).length;
  const pendingCost = obligations
    .filter(
      (o) => !["Paid", "Cancelled", "Artist absent"].includes(o.member.status),
    )
    .reduce((sum, o) => sum + o.member.amount, missingCost);
  const filtered = obligations.filter(({ booking, member }) =>
    filter === "Paid"
      ? member.status === "Paid"
      : filter === "Ready to pay"
        ? member.status === "Ready to pay"
        : filter === "Overdue"
          ? !["Paid", "Cancelled", "Artist absent"].includes(member.status) &&
            booking.dueOn < today()
          : filter === "Needs attention"
            ? !["Ready to pay", "Paid", "Cancelled"].includes(member.status)
            : !["Paid", "Cancelled"].includes(member.status),
  );
  const groups = bookings
    .map((booking) => ({
      booking,
      rows: filtered.filter((row) => row.booking.id === booking.id),
    }))
    .filter((group) => group.rows.length)
    .sort(
      (a, b) =>
        a.booking.dueOn.localeCompare(b.booking.dueOn) ||
        a.booking.act.localeCompare(b.booking.act),
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
      {contracts ? (
        <>
          <h2>Booking contracts</h2>
          {bookings
            .filter(
              (booking) =>
                !booking.cancelled &&
                booking.approvedVersion !== booking.version,
            )
            .map((booking) => (
              <div className="invite-row" key={booking.id}>
                <span>
                  <strong>{booking.act}</strong> · {bookingDate(booking.date)} ·{" "}
                  {booking.contractStatus}
                </span>
                {!booking.sourceError &&
                  booking.artistFirst &&
                  booking.performance &&
                  booking.members.length === booking.expectedMembers &&
                  booking.fee > 0 &&
                  booking.contractsVersion !== booking.version && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void act("issueContracts", booking.id)}
                    >
                      Issue signing requests
                    </button>
                  )}
                {!booking.sourceError &&
                  (booking.contractStatus === "Ready for venue signature" ||
                    booking.contractStatus ===
                      "Ready for company signature") && (
                    <a className="link" href={"/?review=" + booking.id}>
                      {booking.artistFirst
                        ? "Review and countersign"
                        : "Review booking contracts"}
                    </a>
                  )}
              </div>
            ))}
        </>
      ) : !payments ? (
        <>
          <details className="panel booking-form">
            <summary>New booking</summary>
            <form
              onSubmit={(event) => {
                const form = event.currentTarget;
                const fields = values(event);
                bookingRequest.current ||= crypto.randomUUID();
                void act("createBooking", undefined, {
                  ...fields,
                  requestId: bookingRequest.current,
                  fee: Math.round(Number(fields.fee) * 100),
                  ticketPrice: Math.round(Number(fields.ticketPrice) * 100),
                }).then((saved) => {
                  if (saved) form.reset();
                });
              }}
            >
              <div className="grid">
                <label>
                  Performance date
                  <input name="date" type="date" required />
                </label>
                <label>
                  Artist or band
                  <input name="act" required maxLength={300} />
                </label>
                <label>
                  Contact name
                  <input name="contactName" required maxLength={300} />
                </label>
                <label>
                  Contact email
                  <input
                    name="contactEmail"
                    type="email"
                    required
                    maxLength={254}
                  />
                </label>
                <label>
                  Contact phone (optional)
                  <input name="contactPhone" type="tel" maxLength={50} />
                </label>
                <label>
                  Responsible booker
                  <input name="booker" required maxLength={300} />
                </label>
                <label>
                  Fee per musician (DKK)
                  <input
                    name="fee"
                    type="number"
                    min="0.01"
                    max={1000000}
                    step="0.01"
                    required
                  />
                </label>
                <label>
                  Ticket price (DKK)
                  <input
                    name="ticketPrice"
                    type="number"
                    min="0"
                    max={1000000}
                    step="0.01"
                    required
                  />
                </label>
              </div>
              <button disabled={busy}>Save booking</button>
            </form>
          </details>
          <div className="row booking-toolbar">
            <button
              className="link"
              onClick={() => void load()}
              disabled={busy}
            >
              Refresh
            </button>
            {updated && <small className="fine">Updated {updated}</small>}
            {days.includes(today()) && selectedDate !== today() && (
              <button className="secondary" onClick={() => chooseDate(today())}>
                Tonight
              </button>
            )}
            <button
              className="link"
              onClick={() => setManagement(!management)}
              aria-pressed={management}
            >
              {management ? "Night view" : "Manage bookings"}
            </button>
            {management && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void act("sync")}
              >
                {busy ? "Updating…" : "Update bookings"}
              </button>
            )}
            {management && sheet && (
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
                  chooseDate("");
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
            <ul className="booking-day-list">
              {days.map((date) => {
                const acts = bookings.filter((b) => b.date === date);
                return (
                  <li key={date}>
                    <button
                      className="booking-day-summary"
                      aria-expanded={false}
                      onClick={() => chooseDate(date)}
                    >
                      <span>
                        <strong>{bookingDate(date)}</strong>
                        <span className="booking-day-acts">
                          {acts.map((b) => (
                            <span key={b.id}>
                              {b.act}
                              {b.cancelled && " · Cancelled"}
                            </span>
                          ))}
                        </span>
                      </span>
                      <span className="booking-day-meta">
                        <small>
                          {acts.length} {acts.length === 1 ? "act" : "acts"}
                        </small>
                        <span className="card-chevron" aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <>
              <section className="booking-day-card is-expanded">
                <button
                  className="booking-day-summary"
                  aria-expanded={true}
                  onClick={() => chooseDate("")}
                >
                  <span>
                    <strong>{bookingDate(selectedDate)}</strong>
                    <small className="booking-day-caption">
                      {dated.length} {dated.length === 1 ? "act" : "acts"} ·{" "}
                      {management ? "Booking overview" : "Night overview"}
                    </small>
                  </span>
                  <span className="card-chevron" aria-hidden="true" />
                </button>
                <div className="booking-day-body">
                  {management ? (
                    <>
                      {dated.some((b) => !b.cancelled) && (
                        <details className="panel">
                          <summary>Staff access for this night</summary>
                          <form
                            className="booking-form"
                            onSubmit={(e) => {
                              const fields = values(e);
                              void act("staffLink", undefined, {
                                day: selectedDate,
                                name: fields.name,
                              });
                            }}
                          >
                            <p className="fine">
                              Share a link for this date only. Creating a new
                              link replaces the previous one. It expires the day
                              after the performance, or the day after creation
                              for past bookings.
                            </p>
                            <label>
                              Staff member’s full name
                              <input
                                name="name"
                                required
                                minLength={2}
                                maxLength={100}
                              />
                            </label>
                            <div className="row">
                              <button disabled={busy}>Copy staff link</button>
                              <button
                                type="button"
                                className="secondary"
                                disabled={busy}
                                onClick={() =>
                                  void act("revokeStaff", undefined, {
                                    day: selectedDate,
                                  })
                                }
                              >
                                Revoke staff link
                              </button>
                            </div>
                          </form>
                        </details>
                      )}
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
                              Confirm that every listed act and musician played
                              as agreed. Use an act’s exceptions form if
                              anything changed.
                            </p>
                            <label>
                              Your full name
                              <input name="by" required minLength={2} />
                            </label>
                            <label className="check">
                              <input type="checkbox" required />
                              All acts performed as agreed
                            </label>
                            <button
                              disabled={
                                busy ||
                                dated.some(
                                  (b) =>
                                    !b.cancelled &&
                                    !b.confirmedAt &&
                                    b.members.length !== b.expectedMembers,
                                )
                              }
                            >
                              Confirm this date
                            </button>
                            {dated.some(
                              (b) =>
                                !b.cancelled &&
                                !b.confirmedAt &&
                                b.members.length !== b.expectedMembers,
                            ) && (
                              <p className="fine">
                                Open each act with missing registrations and
                                record who played.
                              </p>
                            )}
                          </form>
                        )}
                      {dated.map((booking) => (
                        <details
                          className="booking-act booking-act-card"
                          key={booking.id}
                        >
                          <summary className="act-card-summary">
                            <span>
                              <strong>{booking.act}</strong>
                              <small>
                                {booking.members.length}/
                                {booking.expectedMembers} registered ·{" "}
                                {booking.performance?.start || "Time pending"}
                              </small>
                            </span>
                            <span className="card-chevron" aria-hidden="true" />
                          </summary>
                          <div className="act-card-body">
                            <div className="section-title">
                              <button
                                className="link"
                                disabled={busy}
                                onClick={() => void act("link", booking.id)}
                              >
                                Copy musician link
                              </button>
                              <button
                                className="link"
                                disabled={busy}
                                onClick={() =>
                                  void act("contactLink", booking.id)
                                }
                              >
                                Copy private band contact link
                              </button>
                            </div>
                            <p>
                              {booking.members.length}/{booking.expectedMembers}{" "}
                              musicians registered ·{" "}
                              {booking.cancelled
                                ? "Cancelled"
                                : booking.contractStatus}
                            </p>
                            {booking.sourceError && (
                              <p className="error">{booking.sourceError}</p>
                            )}
                            <Schedule booking={booking} />
                            {booking.date <= today() &&
                              !booking.cancelled &&
                              !booking.sourceError &&
                              booking.artistFirst && (
                                <form
                                  className="booking-form"
                                  onSubmit={(event) => {
                                    const fields = values(event);
                                    void act("ticketSales", booking.id, {
                                      sold: Number(fields.sold),
                                    });
                                  }}
                                >
                                  <div className="row">
                                    <label>
                                      Tickets sold
                                      <input
                                        name="sold"
                                        type="number"
                                        step="1"
                                        min="0"
                                        max="1000000"
                                        defaultValue={
                                          booking.operations?.ticketsSold
                                        }
                                        required
                                      />
                                    </label>
                                    <button
                                      className="secondary"
                                      disabled={busy}
                                    >
                                      Save ticket sales
                                    </button>
                                  </div>
                                  {booking.operations?.ticketsSold !==
                                    undefined &&
                                    typeof booking.operations.ticketPrice ===
                                      "number" && (
                                      <p className="fine">
                                        Ticket revenue ·{" "}
                                        {money(
                                          Math.round(
                                            booking.operations.ticketPrice *
                                              booking.operations.ticketsSold *
                                              100,
                                          ),
                                        )}
                                      </p>
                                    )}
                                </form>
                              )}
                            {booking.promotion &&
                              (booking.promotion.bio ||
                                booking.promotion.photoUrl ||
                                booking.promotion.website) && (
                                <details className="booking-form">
                                  <summary>Promotion details</summary>
                                  {booking.promotion.bio && (
                                    <p>{booking.promotion.bio}</p>
                                  )}
                                  {booking.promotion.photoUrl && (
                                    <p>
                                      <a
                                        href={booking.promotion.photoUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        Press photo
                                      </a>
                                    </p>
                                  )}
                                  {booking.promotion.website && (
                                    <p>
                                      <a
                                        href={booking.promotion.website}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        Artist website
                                      </a>
                                    </p>
                                  )}
                                </details>
                              )}
                            <BookingChecklist booking={booking} />
                            <p>
                              {booking.fee ? (
                                <>
                                  {money(booking.fee)} per musician ·{" "}
                                  {money(booking.fee * booking.expectedMembers)}{" "}
                                  total
                                </>
                              ) : (
                                "Fee to confirm"
                              )}
                            </p>
                            <ul className="booking-member-list">
                              {booking.members.map((member) => (
                                <li
                                  className="booking-member-row"
                                  key={member.id}
                                >
                                  <span className="booking-member-identity">
                                    <strong>{member.name}</strong>
                                    <small>{member.email}</small>
                                  </span>
                                  <span className="booking-member-status">
                                    {member.signatureStatus} ·{" "}
                                    {member.paymentType}
                                    {member.signingDeadline &&
                                      ["Expired", "Revoked"].includes(
                                        member.signatureStatus,
                                      ) && (
                                        <form
                                          onSubmit={(e) => {
                                            const fields = values(e);
                                            void act("reissue", booking.id, {
                                              memberId: member.id,
                                              returnBy: fields.returnBy,
                                            });
                                          }}
                                        >
                                          <label>
                                            New signing deadline
                                            <input
                                              type="date"
                                              name="returnBy"
                                              min={today()}
                                              defaultValue={signingDeadline(
                                                booking.date,
                                              )}
                                              required
                                            />
                                          </label>
                                          <button
                                            className="secondary"
                                            disabled={busy}
                                          >
                                            Reissue contract
                                          </button>
                                        </form>
                                      )}
                                    {member.signingDeadline &&
                                      member.signingDeadline >= today() &&
                                      member.contractId &&
                                      !member.signed &&
                                      member.signatureStatus !== "Revoked" && (
                                        <button
                                          className="link"
                                          disabled={busy}
                                          onClick={() =>
                                            void act(
                                              "signingLink",
                                              booking.id,
                                              {
                                                memberId: member.id,
                                              },
                                            )
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
                              !booking.members.some((m) => m.paymentId) && (
                                <details className="booking-form">
                                  <summary>Correct terms or roster</summary>
                                  <form
                                    onSubmit={(event) => {
                                      const fields = values(event);
                                      void act("correctBooking", booking.id, {
                                        reason: fields.reason,
                                        memberId: fields.memberId || undefined,
                                      });
                                    }}
                                  >
                                    <p className="fine">
                                      This reopens registration and requires a
                                      new company signature. Existing signed
                                      copies are retained. Attendance remains
                                      recorded for the current lineup.
                                    </p>
                                    <label>
                                      Remove a roster entry
                                      <select name="memberId" defaultValue="">
                                        <option value="">
                                          Keep all musicians
                                        </option>
                                        {booking.members.map((member) => (
                                          <option
                                            key={member.id}
                                            value={member.id}
                                          >
                                            {member.name} · {member.email}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                    <label>
                                      Reason
                                      <input
                                        name="reason"
                                        required
                                        minLength={5}
                                        maxLength={500}
                                      />
                                    </label>
                                    <button
                                      className="secondary"
                                      disabled={busy}
                                    >
                                      Reopen booking
                                    </button>
                                  </form>
                                </details>
                              )}
                            {booking.correction && (
                              <p className="fine">
                                Last correction · {booking.correction.reason}
                              </p>
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
                              !booking.sourceError &&
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
                                          defaultValue={
                                            m.attendance || "played"
                                          }
                                        >
                                          <option value="played">
                                            Played as agreed
                                          </option>
                                          <option value="absent">Absent</option>
                                          <option value="issue">
                                            Performance issue
                                          </option>
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
                              {!booking.cancelled &&
                                !booking.sourceError &&
                                booking.approvedVersion !== booking.version && (
                                  <button
                                    className="link"
                                    disabled={busy}
                                    onClick={() =>
                                      void act("resendInvitation", booking.id)
                                    }
                                  >
                                    Resend invitation to {booking.contactEmail}
                                  </button>
                                )}
                              {booking.mail.length ? (
                                booking.mail.map((mail) => (
                                  <div className="invite-row" key={mail.id}>
                                    <span>
                                      {mail.to} · {mail.kind} · {mail.status}
                                      {mail.error && <> · {mail.error}</>}
                                    </span>
                                    {mail.status === "failed" &&
                                      mail.kind !== "verification" && (
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
                          </div>
                        </details>
                      ))}
                    </>
                  ) : (
                    <div className="night-view">
                      {selectedDate <= today() &&
                        dated.some((b) => !b.cancelled && !b.confirmedAt) && (
                          <label className="night-employee">
                            Confirmed by
                            <input
                              value={employee}
                              onChange={(e) => {
                                setEmployee(e.target.value);
                                sessionStorage.setItem(
                                  "stagebook-employee",
                                  e.target.value,
                                );
                              }}
                              autoComplete="name"
                              placeholder="Your full name"
                              minLength={2}
                              maxLength={300}
                            />
                            <span className="fine">
                              Enter your name, then check each act after they
                              have played.
                            </span>
                          </label>
                        )}
                      {dated.map((booking) => {
                        const missing = Math.max(
                          0,
                          booking.expectedMembers - booking.members.length,
                        );
                        const confirmed =
                          Boolean(booking.confirmedAt) &&
                          booking.members.every((m) => m.attendance);
                        const allPlayed =
                          confirmed &&
                          booking.members.every(
                            (m) => m.attendance === "played",
                          );
                        const canConfirm =
                          !busy &&
                          !confirmed &&
                          !booking.cancelled &&
                          !booking.sourceError &&
                          selectedDate <= today() &&
                          employee.trim().length >= 2 &&
                          !missing;
                        return (
                          <details
                            className="night-act booking-act-card"
                            key={booking.id}
                          >
                            <summary className="act-card-summary">
                              <span className="act-card-title">
                                <strong>{booking.act}</strong>
                                <small>
                                  {booking.cancelled
                                    ? "Cancelled"
                                    : missing
                                      ? `${missing} ${missing === 1 ? "registration" : "registrations"} missing`
                                      : "Registration complete"}
                                </small>
                              </span>
                              <span className="act-card-meta">
                                <time>
                                  {booking.performance?.start || "Time pending"}
                                </time>
                                <span
                                  className="card-chevron"
                                  aria-hidden="true"
                                />
                              </span>
                            </summary>
                            <div className="act-card-body">
                              {booking.cancelled ? (
                                <p className="fine">Cancelled</p>
                              ) : (
                                <>
                                  <p className="night-members-label">Members</p>
                                  <ul className="night-members">
                                    {booking.members.map((member) => (
                                      <li key={member.id}>{member.name}</li>
                                    ))}
                                    {!booking.members.length && (
                                      <li className="fine">
                                        No musicians registered yet
                                      </li>
                                    )}
                                  </ul>
                                  {booking.performance ? (
                                    <p className="night-set-info">
                                      {booking.performance.sets}{" "}
                                      {booking.performance.sets === 1
                                        ? "set"
                                        : "sets"}{" "}
                                      of {booking.performance.minutesPerSet}{" "}
                                      min.
                                      <span className="fine">
                                        Finishes {booking.performance.end}
                                        {booking.performance.end <
                                          booking.performance.start &&
                                          " (next day)"}
                                      </span>
                                    </p>
                                  ) : (
                                    <p className="fine">Schedule pending</p>
                                  )}
                                  {booking.performance?.requests && (
                                    <p className="fine">
                                      Requests: {booking.performance.requests}
                                    </p>
                                  )}
                                  <p
                                    className={
                                      missing
                                        ? "night-registration missing"
                                        : "night-registration"
                                    }
                                  >
                                    {missing
                                      ? `${missing} ${missing === 1 ? "registration" : "registrations"} missing`
                                      : "Registration complete"}
                                  </p>
                                  {booking.sourceError && (
                                    <p className="fine">
                                      Booking details need attention. Contact
                                      the manager.
                                    </p>
                                  )}
                                  <p className="fine night-contract-status">
                                    {booking.contractStatus}
                                  </p>
                                  <label className="check night-confirm">
                                    <input
                                      type="checkbox"
                                      checked={allPlayed}
                                      disabled={!canConfirm}
                                      onChange={(e) => {
                                        if (e.target.checked)
                                          void act("attendance", booking.id, {
                                            by: employee.trim(),
                                            note: "",
                                            members: booking.members.map(
                                              (m) => ({
                                                id: m.id,
                                                status: "played",
                                              }),
                                            ),
                                          });
                                      }}
                                    />
                                    Act performed as agreed
                                  </label>
                                  {confirmed ? (
                                    <p className="fine">
                                      {allPlayed
                                        ? "Confirmed"
                                        : "Exceptions recorded"}{" "}
                                      by {booking.confirmedBy}
                                      {booking.attendanceNote &&
                                        ` · ${booking.attendanceNote}`}
                                    </p>
                                  ) : selectedDate > today() ? (
                                    <p className="fine">
                                      Confirm on the performance date.
                                    </p>
                                  ) : null}
                                  {booking.date <= today() &&
                                    !booking.sourceError &&
                                    !booking.members.some(
                                      (m) => m.paymentId,
                                    ) && (
                                      <AttendanceEditor
                                        booking={booking}
                                        busy={busy}
                                        by={employee}
                                        onSave={(data) =>
                                          void act(
                                            "attendance",
                                            booking.id,
                                            data,
                                          )
                                        }
                                      />
                                    )}
                                </>
                              )}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>
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
            Process the payment using the musician’s chosen method, then record
            it here.
          </p>
          <div className="stats">
            <div className="stat">
              <span>Known pending fees</span>
              <strong>{money(pendingCost)}</strong>
            </div>
            <div className="stat">
              <span>Ready</span>
              <strong>
                {money(
                  obligations
                    .filter((o) => o.member.status === "Ready to pay")
                    .reduce((sum, o) => sum + o.member.amount, 0),
                )}
              </strong>
            </div>
          </div>
          {unconfirmedLineups > 0 && filter === "Pending" && (
            <p className="fine">
              {unconfirmedLineups}{" "}
              {unconfirmedLineups === 1
                ? "booking still needs"
                : "bookings still need"}{" "}
              a confirmed lineup before the full cost can be calculated.
            </p>
          )}
          {["Pending", "Needs attention", "Overdue"].includes(filter) &&
            unregistered.length > 0 && (
              <details className="panel">
                <summary>
                  Waiting for{" "}
                  {unregistered.reduce((sum, entry) => sum + entry.missing, 0)}{" "}
                  registrations · {money(missingCost)} in known fees
                </summary>
                <ul className="booking-checklist">
                  {unregistered.map(({ booking, missing }) => (
                    <li key={booking.id}>
                      <strong>
                        {booking.act} · {bookingDate(booking.date)}
                      </strong>
                      <span>
                        {missing} missing ·{" "}
                        {booking.fee
                          ? money(booking.fee * missing)
                          : "Fee to confirm"}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          {groups.map(({ booking, rows }) => (
            <section className="panel payment-booking" key={booking.id}>
              <div className="section-title">
                <div>
                  <h3>{booking.act}</h3>
                  <p className="fine">
                    {bookingDate(booking.date)} · Due{" "}
                    {bookingDate(booking.dueOn)}
                  </p>
                </div>
                <strong>
                  {money(rows.reduce((sum, row) => sum + row.member.amount, 0))}
                </strong>
              </div>
              <div className="row">
                <button
                  className="link"
                  disabled={busy}
                  onClick={() => {
                    if (accounts[booking.id])
                      setAccounts(({ [booking.id]: _, ...rest }) => rest);
                    else void showAccounts(booking.id);
                  }}
                >
                  {accounts[booking.id]
                    ? "Hide payment details"
                    : "Show payment details"}
                </button>
                {rows.some((row) => row.member.status === "Ready to pay") && (
                  <button
                    className="link"
                    disabled={busy}
                    onClick={() =>
                      setSelected((current) => [
                        ...new Set([
                          ...current,
                          ...rows
                            .filter(
                              (row) => row.member.status === "Ready to pay",
                            )
                            .map((row) => row.key),
                        ]),
                      ])
                    }
                  >
                    Select ready musicians
                  </button>
                )}
              </div>
              {rows.map(({ member, key }) => (
                <article className="payment-person" key={key}>
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
                    <strong>
                      {member.amount ? money(member.amount) : "Fee to confirm"}
                    </strong>
                  </div>
                  <p>{member.paymentType}</p>
                  <p>
                    {member.status} · Due {booking.dueOn}
                    {booking.dueOn < today() &&
                      member.status !== "Paid" &&
                      " · Overdue"}
                  </p>
                  {accounts[booking.id]
                    ?.filter((a) => a.memberId === member.id)
                    .map((account) => (
                      <div className="booking-account" key={account.memberId}>
                        <PaymentDetails
                          method={member.paymentType}
                          account={account}
                        />
                      </div>
                    ))}
                </article>
              ))}
            </section>
          ))}
          {loaded &&
            !filtered.length &&
            (filter === "Paid" || !unregistered.length) && (
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
              <ul className="booking-checklist">
                {obligations
                  .filter((row) => selected.includes(row.key))
                  .map(({ booking, member, key }) => (
                    <li key={key}>
                      <span>
                        {member.name} · {booking.act}
                      </span>
                      <strong>{money(member.amount)}</strong>
                    </li>
                  ))}
              </ul>
              <p>
                {money(
                  obligations
                    .filter((o) => selected.includes(o.key))
                    .reduce((sum, o) => sum + o.member.amount, 0),
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

function BookingChecklist({ booking }: { booking: View }) {
  const registered = booking.members.length;
  const signed = booking.members.filter((m) => m.signed).length;
  const paid = booking.members.filter((m) => m.status === "Paid").length;
  const recorded = booking.members.filter((m) => m.attendance).length;
  const company = booking.approvedVersion === booking.version;
  const next = booking.cancelled
    ? "Cancelled"
    : booking.sourceError
      ? "Fix the booking row in Google Sheets"
      : !booking.performance
        ? "Ask the band contact for the schedule"
        : registered !== booking.expectedMembers
          ? "Share the musician registration link"
          : booking.artistFirst && !company
            ? signed < registered
              ? booking.contractsVersion === booking.version
                ? "Waiting for musician signatures"
                : "Check signing requests under Contracts"
              : !booking.confirmedAt
                ? "Record who performed"
                : "Review countersignature under Contracts"
            : !company
              ? "Sign for the venue from Contracts or the Bookings sheet"
              : signed < registered
                ? "Follow up on unsigned contracts"
                : recorded < registered
                  ? "Record who performed"
                  : booking.members.some((m) => m.status === "Ready to pay")
                    ? "Process the ready payments"
                    : paid < registered
                      ? "Review any performance exceptions"
                      : "Complete";
  return (
    <div className="booking-progress">
      <p>
        <strong>{booking.contractStatus}</strong>
      </p>
      <ul className="booking-checklist">
        <li>
          <span>Schedule</span>
          <strong>{booking.performance ? "Ready" : "Waiting"}</strong>
        </li>
        <li>
          <span>Musicians registered</span>
          <strong>
            {registered}/{booking.expectedMembers}
          </strong>
        </li>
        <li>
          <span>Company signature</span>
          <strong>{company ? "Signed" : "Waiting"}</strong>
        </li>
        <li>
          <span>Artist signatures</span>
          <strong>
            {signed}/{booking.expectedMembers}
          </strong>
        </li>
        <li>
          <span>Attendance recorded</span>
          <strong>
            {recorded}/{booking.expectedMembers}
          </strong>
        </li>
        <li>
          <span>Payments recorded</span>
          <strong>
            {paid}/{booking.expectedMembers}
          </strong>
        </li>
      </ul>
      <p className="fine">{next}</p>
    </div>
  );
}

function PaymentDetails({
  method,
  account,
}: {
  method: View["members"][number]["paymentType"];
  account: Account;
}) {
  const [status, setStatus] = useState("");
  const details =
    method === "Bank transfer"
      ? account.iban ||
        [account.registration, account.account].filter(Boolean).join(" ")
      : method === "Mobilepay"
        ? account.phone
        : "";
  async function copy() {
    if (!details) return;
    try {
      await navigator.clipboard.writeText(details);
      setStatus("Copied");
    } catch {
      setStatus("Select the details to copy.");
    }
  }
  return (
    <>
      <p>
        <strong>{account.name}</strong> · {account.payee}
        {account.cvr && " · CVR " + account.cvr}
      </p>
      {method === "Cash" ? (
        <p>Cash payment</p>
      ) : details ? (
        <div className="row">
          <span>
            {method === "Mobilepay"
              ? "Mobilepay " + details
              : account.iban
                ? "IBAN " + details
                : "Reg. " +
                  account.registration +
                  " · Account " +
                  account.account}
          </span>
          <button className="link" onClick={() => void copy()}>
            Copy details
          </button>
        </div>
      ) : (
        <p>Payment details missing. Contact the musician.</p>
      )}
      {status && (
        <p className="fine" role="status">
          {status}
        </p>
      )}
    </>
  );
}
