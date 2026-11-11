"use client";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  clientWorkspace,
  demoWorkspace,
  empty,
  isoWeek,
  money,
  net,
  paymentRecord,
  tariff,
  today,
  type ClientWorkspace,
  type Payment,
  type Venue,
} from "@/lib/model";

type Page =
  | "Overview"
  | "Musicians"
  | "Payments"
  | "Reports"
  | "Venue"
  | "Google Sheet";
type Modal =
  | { kind: "payment"; musicianId?: string }
  | { kind: "link"; url: string }
  | { kind: "void"; payment: Payment };
const pages: Page[] = [
  "Overview",
  "Musicians",
  "Payments",
  "Reports",
  "Venue",
  "Google Sheet",
];
function fields(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget));
}
async function request(url: string, body?: object) {
  const response = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Try again.");
  return result;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
    </label>
  );
}
export function Brand() {
  return (
    <a className="brand" href="/">
      <span className="mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      stagebook<span>.</span>
    </a>
  );
}
export default function Dashboard() {
  const [page, setPage] = useState<Page>("Overview");
  const [mode, setMode] = useState<
    "loading" | "connect" | "setup" | "login" | "app"
  >("loading");
  const [workspace, setWorkspace] = useState<ClientWorkspace>(() =>
    clientWorkspace(empty()),
  );
  const [sample, setSample] = useState(demoWorkspace);
  const [demo, setDemo] = useState(false);
  const [sheet, setSheet] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [search, setSearch] = useState("");
  const data = demo ? clientWorkspace(sample) : workspace;
  const start = useCallback(async () => {
    setError("");
    try {
      const status = await request("/api/session");
      if (!status.connected) {
        setMode("connect");
        return;
      }
      if (!status.initialized) {
        setMode("setup");
        return;
      }
      if (!status.signedIn) {
        setMode("login");
        return;
      }
      const result = await request("/api/workspace");
      setWorkspace(result.workspace);
      setSheet(result.sheet);
      setMode("app");
    } catch (e) {
      setMode("connect");
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void start();
  }, [start]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timeout);
  }, [notice]);
  function go(next: Page) {
    setPage(next);
    setSearch("");
    setError("");
  }
  async function mutate(action: string, values: object) {
    setBusy(true);
    setError("");
    try {
      if (demo) {
        const copy = structuredClone(sample);
        if (action === "venue") copy.venue = values as Venue;
        if (action === "payment")
          copy.payments.push(paymentRecord(copy, values));
        if (action === "void") {
          const { id, reason } = values as { id: string; reason: string };
          const item = copy.payments.find((p) => p.id === id);
          if (item) item.voidReason = reason;
        }
        if (action === "invite") {
          setModal({ kind: "link", url: location.origin + "/register/demo" });
          return;
        }
        setSample(copy);
        setNotice("Saved in the demo.");
        setModal(null);
        return;
      }
      const result = await request("/api/workspace", { action, data: values });
      setWorkspace(result.workspace);
      if (result.link) {
        setModal({ kind: "link", url: location.origin + result.link });
        return;
      }
      setModal(null);
      setNotice("Saved to Google Sheets.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    const data = fields(event);
    setBusy(true);
    setError("");
    try {
      await request("/api/session", { action: mode, ...data });
      await start();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (mode !== "app" && !demo)
    return (
      <main className="gate">
        <header>
          <Brand />
          <button
            className="secondary"
            onClick={() => {
              setDemo(true);
              setError("");
            }}
          >
            Explore demo
          </button>
        </header>
        <h1>Musician payments</h1>
        <p className="lead">
          Collect musician details, record payments and keep everything in your
          Google Sheet.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {mode === "loading" ? (
          <p>Opening workspace…</p>
        ) : mode === "connect" ? (
          <section className="panel guide">
            <h2>Connect your Google Sheet</h2>
            <ol>
              <li>
                Create a private Google Sheet. Open{" "}
                <strong>Extensions → Apps Script</strong> and paste the{" "}
                <a href="/Code.gs" download>
                  integration code
                </a>
                .
              </li>
              <li>
                In Apps Script, add <strong>Google Sheets API</strong> under
                Services. Run <strong>initialize</strong> and authorize the
                script. In <strong>Project Settings → Script properties</strong>,
                copy the value of <code>API_SECRET</code>.
              </li>
              <li>
                Deploy a web app that runs as you and accepts requests from{" "}
                <strong>Anyone</strong>. The script checks the signature on
                every request.
              </li>
              <li>
                Set <code>GOOGLE_SCRIPT_URL</code> to the web app’s{" "}
                <code>/exec</code> URL and <code>GOOGLE_SCRIPT_SECRET</code> to
                its secret in the{" "}
                <a
                  href="https://vercel.com/izakh-s-projects/dmf/settings/environment-variables"
                  target="_blank"
                  rel="noreferrer"
                >
                  Vercel project
                </a>
                . Add <code>GOOGLE_SPREADSHEET_ID</code> for the workbook link.
                Redeploy.
              </li>
            </ol>
            <button onClick={() => void start()}>Check connection</button>
          </section>
        ) : (
          <form className="panel auth" onSubmit={signIn}>
            <h2>
              {mode === "setup" ? "Create your administrator login" : "Sign in"}
            </h2>
            <Field label="Email">
              <input name="email" type="email" required autoComplete="email" />
            </Field>
            <Field label="Password">
              <input
                name="password"
                type="password"
                required
                minLength={12}
                autoComplete={
                  mode === "setup" ? "new-password" : "current-password"
                }
              />
            </Field>
            {mode === "setup" && (
              <Field label="Administrator setup key">
                <input
                  name="setup"
                  type="password"
                  required
                  autoComplete="off"
                />
                <small>Use the SETUP_TOKEN value in Vercel.</small>
              </Field>
            )}
            <button disabled={busy}>
              {busy
                ? "Please wait…"
                : mode === "setup"
                  ? "Create login"
                  : "Sign in"}
            </button>
          </form>
        )}
      </main>
    );
  const matching = data.musicians.filter((m) =>
    [m.name, m.band, m.email]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const paid = (prefix: string) =>
    data.payments
      .filter((p) => p.paidOn.startsWith(prefix))
      .reduce((sum, p) => sum + net(p), 0);
  return (
    <div className="shell">
      <aside>
        <Brand />
        <div className="venue-label">{data.venue.name || "Your venue"}</div>
        <nav aria-label="Workspace">
          {pages.map((item) => (
            <button
              className={page === item ? "active" : ""}
              aria-current={page === item ? "page" : undefined}
              key={item}
              onClick={() => go(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <button
          className="signout"
          onClick={async () => {
            if (demo) {
              setDemo(false);
              return;
            }
            await request("/api/session", { action: "logout" });
            await start();
          }}
        >
          {demo ? "Exit demo" : "Sign out"}
        </button>
      </aside>
      <main className="main">
        <header className="top">
          <span>Workspace / {page}</span>
          <div>
            {demo ? (
              <span className="pill">Sample data</span>
            ) : (
              <>
                <span className="pill">Google Sheets connected</span>
                <button
                  className="secondary compact"
                  onClick={() => void start()}
                >
                  Refresh
                </button>
              </>
            )}
          </div>
        </header>
        <section className="content">
          <div className="heading">
            <div>
              <h1>{page === "Overview" ? "Musician payments" : page}</h1>
              <p>
                {
                  {
                    Overview:
                      "Invite musicians, then record payments as they’re made.",
                    Musicians: "Invite musicians to submit their own details.",
                    Payments: "Record and review payments to your musicians.",
                    Reports:
                      "Review actual payments by date, band and musician.",
                    Venue:
                      "Enter your organizer details once to reuse them throughout the app.",
                    "Google Sheet":
                      "Review the workbook and manage registration links.",
                  }[page]
                }
              </p>
            </div>
            {page === "Musicians" ? (
              <button disabled={busy} onClick={() => void mutate("invite", {})}>
                + Registration link
              </button>
            ) : (
              ["Overview", "Payments"].includes(page) && (
                <button
                  onClick={() => {
                    setError("");
                    setModal({ kind: "payment" });
                  }}
                >
                  + Add payment
                </button>
              )
            )}
          </div>
          {demo && (
            <div className="banner">
              Demo data stays in this browser session.{" "}
              <button
                className="link"
                onClick={() => {
                  setDemo(false);
                  setError("");
                }}
              >
                Return to workspace →
              </button>
            </div>
          )}
          {error && !modal && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {page === "Overview" && (
            <>
              <div className="stats">
                {[
                  ["Registered musicians", data.musicians.length],
                  ["Paid this month", money(paid(today().slice(0, 7)))],
                  ["Paid this year", money(paid(today().slice(0, 4)))],
                ].map(([label, value]) => (
                  <div className="panel stat" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <section className="hero">
                <div>
                  <h2>Register musicians</h2>
                  <p>
                    Save your venue details, then share a link so musicians can
                    enter their own information.
                  </p>
                  <button
                    onClick={() =>
                      data.venue.legalName
                        ? void mutate("invite", {})
                        : go("Venue")
                    }
                    disabled={busy}
                  >
                    {data.venue.legalName
                      ? "Get registration link"
                      : "Set up venue →"}
                  </button>
                </div>
                <div className="disc" aria-hidden="true">
                  <span>♬</span>
                </div>
              </section>
              <section className="panel">
                <h2>Recent payments</h2>
                <Payments rows={[...data.payments].reverse().slice(0, 5)} />
              </section>
            </>
          )}
          {page === "Musicians" && (
            <>
              <input
                className="search"
                placeholder="Search musician or band"
                aria-label="Search musicians"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="cards">
                {matching.map((m) => (
                  <article className="panel musician" key={m.id}>
                    <div className="avatar">
                      {m.name
                        .split(" ")
                        .slice(0, 2)
                        .map((s) => s[0])
                        .join("")}
                    </div>
                    <h2>{m.name}</h2>
                    <p>{m.band || "Independent musician"}</p>
                    <div className="subline">
                      <span>Details submitted</span>
                      <strong>
                        {money(
                          data.payments
                            .filter((p) => p.musicianId === m.id)
                            .reduce((sum, p) => sum + net(p), 0),
                        )}{" "}
                        paid
                      </strong>
                    </div>
                    <div className="row">
                      <button
                        onClick={() =>
                          setModal({ kind: "payment", musicianId: m.id })
                        }
                      >
                        + Add payment
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void mutate("invite", { musicianId: m.id })
                        }
                      >
                        Update link
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {!matching.length && (
                <div className="panel">
                  No matching musicians. Share a registration link to add
                  musicians.
                </div>
              )}
            </>
          )}
          {page === "Payments" && (
            <section className="panel">
              <Payments
                rows={[...data.payments].reverse()}
                onVoid={(payment) => setModal({ kind: "void", payment })}
              />
            </section>
          )}
          {page === "Reports" && <Reports workspace={data} />}
          {page === "Venue" && (
            <VenueForm
              key={data.revision + ":" + demo}
              venue={data.venue}
              busy={busy}
              save={(v) => void mutate("venue", v)}
            />
          )}
          {page === "Google Sheet" && (
            <section className="panel guide">
              <h2>Workbook</h2>
              <p>
                Venue details, musician details, payments and totals update on
                every save. Restrict workbook access to staff who handle
                payments.
              </p>
              {sheet && !demo && (
                <a
                  className="button"
                  href={sheet}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Google Sheet
                </a>
              )}
              <h2>Registration links</h2>
              {data.invites.length ? (
                data.invites.map((invite) => (
                  <div className="invite-row" key={invite.id}>
                    <span>
                      {invite.musicianId
                        ? "Personal update"
                        : "New registrations"}{" "}
                      ·{" "}
                      {invite.revoked
                        ? "Revoked"
                        : invite.expiresAt.slice(0, 10)}
                    </span>
                    {!invite.revoked && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void mutate("revoke", { id: invite.id })}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <p>No links created yet.</p>
              )}
            </section>
          )}
        </section>
      </main>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
      {modal && (
        <div
          className="overlay"
          onClick={() => {
            if (!busy) {
              setError("");
              setModal(null);
            }
          }}
        >
          <section
            className="dialog panel"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal.kind === "payment"
                ? "Add payment"
                : modal.kind === "link"
                  ? "Registration link"
                  : "Void payment"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close secondary"
              aria-label="Close"
              disabled={busy}
              onClick={() => {
                setError("");
                setModal(null);
              }}
            >
              ×
            </button>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {modal.kind === "payment" && (
              <PaymentForm
                workspace={data}
                musicianId={modal.musicianId}
                busy={busy}
                save={(p) => void mutate("payment", p)}
              />
            )}
            {modal.kind === "link" && (
              <>
                <h2>Musician registration link</h2>
                <p>Share this link with the musician. It expires in 90 days.</p>
                <input
                  readOnly
                  aria-label="Registration link"
                  value={modal.url}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="row">
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(modal.url);
                        setNotice("Link copied.");
                      } catch {
                        setError("Select and copy the link above.");
                      }
                    }}
                  >
                    Copy link
                  </button>
                  <a
                    className="button secondary"
                    href={modal.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open form
                  </a>
                </div>
              </>
            )}
            {modal.kind === "void" && (
              <form
                onSubmit={(e) =>
                  void mutate("void", {
                    id: modal.payment.id,
                    reason: fields(e).reason,
                  })
                }
              >
                <h2>Void payment</h2>
                <p>
                  {modal.payment.name} · {money(modal.payment.amount)}
                </p>
                <Field label="Reason">
                  <textarea name="reason" required minLength={5} />
                </Field>
                <button disabled={busy}>Void payment</button>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function Payments({
  rows,
  onVoid,
}: {
  rows: Payment[];
  onVoid?: (p: Payment) => void;
}) {
  if (!rows.length) return <p className="empty">No payments recorded.</p>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Musician</th>
            <th>Band</th>
            <th>Paid on</th>
            <th>Amount</th>
            {onVoid && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>
                <strong>{p.name}</strong>
                <small>
                  {p.reference}
                  {p.voidReason
                    ? " · Voided"
                    : p.kind === "Refund"
                      ? " · Refund"
                      : ""}
                </small>
              </td>
              <td>{p.band || "—"}</td>
              <td>{p.paidOn}</td>
              <td>{money(net(p))}</td>
              {onVoid && (
                <td>
                  {!p.voidReason && (
                    <button className="link" onClick={() => onVoid(p)}>
                      Void
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function PaymentForm({
  workspace,
  musicianId,
  busy,
  save,
}: {
  workspace: ClientWorkspace;
  musicianId?: string;
  busy: boolean;
  save: (p: object) => void;
}) {
  const [selected, setSelected] = useState(
    musicianId || workspace.musicians[0]?.id || "",
  );
  const [band, setBand] = useState(
    workspace.musicians.find((m) => m.id === selected)?.band || "",
  );
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState(() => String(tariff(today()) / 100));
  const [id] = useState(() => crypto.randomUUID());
  if (!workspace.musicians.length)
    return (
      <>
        <h2>Add payment</h2>
        <p>A musician must complete the registration form first.</p>
      </>
    );
  return (
    <form
      onSubmit={(event) =>
        save({
          ...fields(event),
          id,
          musicianId: selected,
          amount: Math.round(Number(amount) * 100),
        })
      }
    >
      <h2>Add payment</h2>
      <p>
        {workspace.venue.name} · {workspace.venue.legalName}
      </p>
      <Field label="Musician">
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setBand(
              workspace.musicians.find((m) => m.id === e.target.value)?.band ||
                "",
            );
          }}
        >
          {workspace.musicians.map((m) => (
            <option value={m.id} key={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid">
        <Field label="Amount (DKK)">
          <input
            required
            type="number"
            min="0.01"
            step="0.01"
            name="amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Date paid">
          <input name="paidOn" type="date" required defaultValue={today()} />
        </Field>
        <Field label="Band">
          <input
            name="band"
            value={band}
            onChange={(e) => setBand(e.target.value)}
          />
        </Field>
        <Field label="Performance date">
          <input
            name="performedOn"
            required
            type="date"
            value={date}
            onChange={(e) => {
              const next = e.target.value;
              if (Number(amount) * 100 === tariff(date))
                setAmount(String(tariff(next) / 100));
              setDate(next);
            }}
          />
        </Field>
        <Field label="Payment reference">
          <input name="reference" defaultValue={workspace.venue.reference} />
        </Field>
        <Field label="Entry type">
          <select name="kind">
            <option>Payment</option>
            <option>Refund</option>
          </select>
        </Field>
      </div>
      <Field label="Notes (optional)">
        <textarea name="notes" rows={2} />
      </Field>
      {tariff(date) > 0 && (
        <p className="fine">
          DMF reference for this performance date is {money(tariff(date))} per
          musician.
        </p>
      )}
      <button disabled={busy}>{busy ? "Saving…" : "Save payment"}</button>
    </form>
  );
}
function VenueForm({
  venue,
  busy,
  save,
}: {
  venue: Venue;
  busy: boolean;
  save: (v: Venue) => void;
}) {
  return (
    <form
      className="panel venue-form"
      onSubmit={(e) => {
        const values = fields(e);
        save({ ...values, collectCpr: values.collectCpr === "on" } as Venue);
      }}
    >
      <h2>Organizer details</h2>
      <div className="grid">
        {(
          [
            ["name", "Venue name"],
            ["legalName", "Legal organizer name"],
            ["address", "Full address"],
            ["cvr", "CVR"],
            ["email", "Email"],
            ["phone", "Phone"],
            ["reference", "Default payment reference"],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              name={key}
              defaultValue={venue[key]}
              required={!["phone", "reference"].includes(key)}
              type={key === "email" ? "email" : "text"}
              pattern={key === "cvr" ? "[0-9]{8}" : undefined}
            />
          </Field>
        ))}
      </div>
      <label className="check">
        <input
          name="collectCpr"
          type="checkbox"
          defaultChecked={venue.collectCpr}
        />{" "}
        Include an optional CPR field on the musician form
      </label>
      <button disabled={busy}>{busy ? "Saving…" : "Save venue details"}</button>
    </form>
  );
}
function Reports({ workspace }: { workspace: ClientWorkspace }) {
  const [period, setPeriod] = useState("month");
  const [musician, setMusician] = useState("");
  const [band, setBand] = useState("");
  const selected = workspace.payments.filter(
    (p) =>
      !p.voidReason &&
      (!musician || p.musicianId === musician) &&
      (!band || p.band === band),
  );
  const totals = new Map<string, number>();
  for (const p of selected) {
    const group =
      period === "week"
        ? isoWeek(p.paidOn)
        : p.paidOn.slice(0, period === "month" ? 7 : 4);
    totals.set(group, (totals.get(group) || 0) + net(p));
  }
  return (
    <section className="panel">
      <div className="filters">
        <Field label="Group by">
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
          </select>
        </Field>
        <Field label="Musician">
          <select
            value={musician}
            onChange={(e) => setMusician(e.target.value)}
          >
            <option value="">All musicians</option>
            {workspace.musicians.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Band">
          <select value={band} onChange={(e) => setBand(e.target.value)}>
            <option value="">All bands</option>
            {[...new Set(workspace.payments.map((p) => p.band).filter(Boolean))]
              .sort()
              .map((b) => (
                <option key={b}>{b}</option>
              ))}
          </select>
        </Field>
      </div>
      <h2>Net paid · {money(selected.reduce((sum, p) => sum + net(p), 0))}</h2>
      {totals.size ? (
        <table>
          <thead>
            <tr>
              <th>Period</th>
              <th>Net paid</th>
            </tr>
          </thead>
          <tbody>
            {[...totals]
              .sort(([a], [b]) => b.localeCompare(a))
              .map(([label, value]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{money(value)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : (
        <p>No payments match these filters.</p>
      )}
    </section>
  );
}
