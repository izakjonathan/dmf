"use client";
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  bandKey,
  clientWorkspace,
  demoWorkspace,
  empty,
  isoWeek,
  money,
  net,
  musicianEditSchema,
  paymentRecords,
  tariff,
  today,
  updateMusician,
  type ClientWorkspace,
  type Musician,
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
  | { kind: "payment" }
  | { kind: "musician"; profile: Musician; collectCpr: boolean }
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
      Stagebook
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
  const [actionsOpen, setActionsOpen] = useState(false);
  const [copyUrl, setCopyUrl] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const actionToggle = useRef<HTMLButtonElement>(null);
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
  useEffect(() => {
    if (modal && !dialog.current?.open) dialog.current?.showModal();
  }, [modal]);
  useEffect(() => {
    if (!actionsOpen) return;
    function dismiss(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !actions.current?.contains(event.target)
      )
        setActionsOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setActionsOpen(false);
      actionToggle.current?.focus();
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [actionsOpen]);
  function go(next: Page) {
    setActionsOpen(false);
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
          copy.payments.push(...paymentRecords(copy, values));
        if (action === "musician") {
          const problem = updateMusician(
            copy,
            musicianEditSchema.parse(values),
          );
          if (problem) throw Error(problem);
        }
        if (action === "void") {
          const { id, reason } = values as { id: string; reason: string };
          const item = copy.payments.find((p) => p.id === id);
          if (item) item.voidReason = reason;
        }
        setSample(copy);
        setNotice("Saved in the demo.");
        dialog.current?.close();
        setModal(null);
        return;
      }
      const result = await request("/api/workspace", { action, data: values });
      setWorkspace(result.workspace);
      dialog.current?.close();
      setModal(null);
      setNotice("Saved to Google Sheets.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function editMusician(id: string) {
    setBusy(true);
    setError("");
    try {
      const result = demo
        ? {
            profile: sample.musicians.find((musician) => musician.id === id),
            collectCpr: sample.venue.collectCpr,
          }
        : await request("/api/workspace?musician=" + encodeURIComponent(id));
      if (!result.profile) throw Error("Musician not found.");
      setModal({
        kind: "musician",
        profile: result.profile,
        collectCpr: result.collectCpr,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copyRegistration() {
    if (!data.venue.legalName) {
      go("Venue");
      setError("Save your venue details before getting a registration link.");
      return;
    }
    setBusy(true);
    setError("");
    const link = copyUrl
      ? Promise.resolve(copyUrl)
      : (async () => {
          if (demo) return location.origin + "/register/demo";
          const result = await request("/api/workspace", {
            action: "invite",
            data: {},
          });
          setWorkspace(result.workspace);
          return location.origin + result.link;
        })();
    // Safari requires the clipboard write itself to start in the click handler.
    let clipboard: Promise<boolean> | undefined;
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        const clipboardData = link.then(
          (url) => new Blob([url], { type: "text/plain" }),
        );
        void clipboardData.catch(() => {});
        clipboard = navigator.clipboard
          .write([new ClipboardItem({ "text/plain": clipboardData })])
          .then(
            () => true,
            () => false,
          );
      }
    } catch {
      // Try the plain-text clipboard API after the link is ready.
    }
    try {
      const url = await link;
      if (!(await clipboard)) {
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          setCopyUrl(url);
          setActionsOpen(true);
          return;
        }
      }
      setCopyUrl("");
      setActionsOpen(false);
      actionToggle.current?.focus();
      setNotice("Registration link copied.");
    } catch (e) {
      setActionsOpen(false);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function closeModal() {
    if (!busy) {
      setError("");
      dialog.current?.close();
      setModal(null);
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
      <main className="gate sign-in">
        <div className="gate-inner">
          <header>
            <Brand />
            <button
              className="text-action"
              onClick={() => {
                setDemo(true);
                setError("");
              }}
            >
              Explore demo
            </button>
          </header>
          <h1>
            Musician
            <br />
            payments.
          </h1>
          <p className="lead">
            Collect musician details, record payments and keep everything in
            your Google Sheet.
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
                  script. In{" "}
                  <strong>Project Settings → Script properties</strong>, copy
                  the value of <code>API_SECRET</code>.
                </li>
                <li>
                  Deploy a web app that runs as you and accepts requests from{" "}
                  <strong>Anyone</strong>. The script checks the signature on
                  every request.
                </li>
                <li>
                  Set <code>GOOGLE_SCRIPT_URL</code> to the web app’s{" "}
                  <code>/exec</code> URL and <code>GOOGLE_SCRIPT_SECRET</code>{" "}
                  to its secret in the{" "}
                  <a
                    href="https://vercel.com/izakh-s-projects/dmf/settings/environment-variables"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Vercel project
                  </a>
                  . Add <code>GOOGLE_SPREADSHEET_ID</code> for the workbook
                  link. Redeploy.
                </li>
              </ol>
              <button onClick={() => void start()}>Check connection</button>
            </section>
          ) : (
            <form className="panel auth" onSubmit={signIn}>
              <h2>
                {mode === "setup"
                  ? "Create your administrator login"
                  : "Sign in"}
              </h2>
              <Field label="Email">
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                />
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
        </div>
        <div className="sign-in-photo" aria-hidden="true" />
      </main>
    );
  const matching = data.musicians.filter((m) =>
    [m.name, m.band, m.email]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const sortedPayments = [...data.payments]
    .reverse()
    .sort(
      (a, b) =>
        b.paidOn.localeCompare(a.paidOn) ||
        b.recordedAt.localeCompare(a.recordedAt),
    );
  const history = sortedPayments.filter((payment) =>
    [
      payment.name,
      payment.band,
      payment.paidOn,
      payment.reference,
      payment.kind,
    ]
      .join(" ")
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const paidByMusician = new Map<string, number>();
  for (const payment of data.payments) {
    paidByMusician.set(
      payment.musicianId,
      (paidByMusician.get(payment.musicianId) ?? 0) + net(payment),
    );
  }
  const paid = (prefix: string) =>
    data.payments
      .filter((p) => p.paidOn.startsWith(prefix))
      .reduce((sum, p) => sum + net(p), 0);
  return (
    <div className="shell">
      <header className="workspace-header">
        <h1>{page === "Overview" ? "Musician payments" : page}</h1>
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setActionsOpen(false);
            setCopyUrl("");
            go("Overview");
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
      </header>
      <main className="main">
        <nav aria-label="Workspace">
          {pages.map((item) => (
            <button
              aria-current={page === item ? "page" : undefined}
              key={item}
              onClick={() => go(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <section className="content">
          {error && !modal && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {page === "Overview" && (
            <>
              <div className="stats">
                {[
                  ["Musicians", data.musicians.length],
                  ["This month", money(paid(today().slice(0, 7)))],
                  ["This year", money(paid(today().slice(0, 4)))],
                ].map(([label, value]) => (
                  <div className="panel stat" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <section className="panel">
                <div className="section-title">
                  <h2>Recent payments</h2>
                  <button className="link" onClick={() => go("Payments")}>
                    View all payments
                  </button>
                </div>
                <Payments rows={sortedPayments.slice(0, 5)} />
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
              <ul className="musician-list">
                {matching.map((m) => (
                  <li key={m.id}>
                    <button
                      className="musician-row"
                      disabled={busy}
                      onClick={() => void editMusician(m.id)}
                    >
                      <span className="musician-name">
                        <strong>{m.name}</strong>
                        <small>{m.band || "Independent musician"}</small>
                      </span>
                      <span className="musician-edit">
                        {money(paidByMusician.get(m.id) ?? 0)}
                        <small>Edit</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {!matching.length && (
                <div className="panel">
                  No matching musicians. Share a registration link to add
                  musicians.
                </div>
              )}
            </>
          )}
          {page === "Payments" && (
            <section aria-label="Payment history">
              <input
                className="search"
                placeholder="Search payments"
                aria-label="Search payments"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {history.length || !search.trim() ? (
                <Payments
                  rows={history}
                  onVoid={(payment) => setModal({ kind: "void", payment })}
                />
              ) : (
                <p>No payments match your search.</p>
              )}
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
              {!demo && (
                <div className="sheet-status row">
                  <span className="eyebrow">Google Sheets connected</span>
                  <button className="secondary" onClick={() => void start()}>
                    Refresh
                  </button>
                </div>
              )}
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
      <div ref={actions} className="quick-actions">
        <button
          ref={actionToggle}
          className="quick-toggle"
          aria-label={
            actionsOpen ? "Close quick actions" : "Open quick actions"
          }
          aria-expanded={actionsOpen}
          aria-controls={actionsOpen ? "workspace-actions" : undefined}
          onClick={() => setActionsOpen(!actionsOpen)}
        >
          <span aria-hidden="true">×</span>
        </button>
        {actionsOpen && (
          <div
            id="workspace-actions"
            className="quick-menu"
            aria-label="Workspace actions"
          >
            <button
              disabled={busy}
              onClick={() => {
                setActionsOpen(false);
                actionToggle.current?.focus();
                setError("");
                setModal({ kind: "payment" });
              }}
            >
              Add payment
            </button>
            <button disabled={busy} onClick={() => void copyRegistration()}>
              Get registration link
            </button>
            {copyUrl && (
              <label className="clipboard-fallback">
                Copy this link manually
                <input
                  value={copyUrl}
                  readOnly
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            )}
          </div>
        )}
      </div>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
      {modal && (
        <dialog
          ref={dialog}
          className="dialog"
          aria-labelledby="workspace-dialog-title"
          onCancel={(event) => {
            event.preventDefault();
            closeModal();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeModal();
          }}
        >
          <div className="dialog-inner">
            <button
              className="close secondary"
              aria-label="Close"
              disabled={busy}
              onClick={closeModal}
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
                busy={busy}
                save={(p) => void mutate("payment", p)}
              />
            )}
            {modal.kind === "musician" && (
              <MusicianEditor
                profile={modal.profile}
                collectCpr={modal.collectCpr}
                busy={busy}
                save={(profile) =>
                  void mutate("musician", {
                    id: modal.profile.id,
                    updatedAt: modal.profile.updatedAt,
                    profile,
                  })
                }
              />
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
                <h2 id="workspace-dialog-title">Void payment</h2>
                <p>
                  {modal.payment.name} · {money(modal.payment.amount)}
                </p>
                <Field label="Reason">
                  <textarea name="reason" required minLength={5} />
                </Field>
                <button disabled={busy}>Void payment</button>
              </form>
            )}
          </div>
        </dialog>
      )}
    </div>
  );
}
const paymentDate = new Intl.DateTimeFormat("en-DK", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function Payments({
  rows,
  onVoid,
}: {
  rows: Payment[];
  onVoid?: (payment: Payment) => void;
}) {
  if (!rows.length) return <p>No payments recorded.</p>;
  return (
    <ul className="payment-list">
      {rows.map((payment) => (
        <li className="payment-row" key={payment.id}>
          <div>
            <strong>{payment.name}</strong>
            {payment.band && <small>{payment.band}</small>}
            {onVoid && payment.reference && <small>{payment.reference}</small>}
            {payment.voidReason && (
              <small>Voided{onVoid ? " · " + payment.voidReason : ""}</small>
            )}
            {!payment.voidReason && payment.kind === "Refund" && (
              <small>Refund</small>
            )}
          </div>
          <div className="payment-value">
            <strong className={payment.voidReason ? "void-amount" : undefined}>
              {money(payment.voidReason ? payment.amount : net(payment))}
            </strong>
            <time dateTime={payment.paidOn}>
              {paymentDate.format(new Date(payment.paidOn + "T12:00:00Z"))}
            </time>
            {onVoid && !payment.voidReason && (
              <button
                className="link"
                onClick={() => onVoid(payment)}
                aria-label={"Void payment for " + payment.name}
              >
                Void
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function PaymentForm({
  workspace,
  busy,
  save,
}: {
  workspace: ClientWorkspace;
  busy: boolean;
  save: (p: object) => void;
}) {
  const bands = new Map<
    string,
    { name: string; members: ClientWorkspace["musicians"] }
  >();
  for (const musician of workspace.musicians) {
    const key = bandKey(musician.band);
    if (!key) continue;
    const group = bands.get(key);
    if (group) group.members.push(musician);
    else bands.set(key, { name: musician.band.trim(), members: [musician] });
  }
  const [selected, setSelected] = useState(workspace.musicians[0]?.id || "");
  const [band, setBand] = useState(workspace.musicians[0]?.band || "");
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState(() => String(tariff(today()) / 100));
  const [id] = useState(() => crypto.randomUUID());
  const group = selected.startsWith("band:")
    ? bands.get(selected.slice(5))
    : undefined;
  const amountInOre = Math.round(Number(amount) * 100);
  return (
    <>
      <h2 id="workspace-dialog-title">Add payment</h2>
      {!workspace.musicians.length ? (
        <p>A musician must complete the registration form first.</p>
      ) : (
        <form
          onSubmit={(event) => {
            const values = { ...fields(event), id, amount: amountInOre };
            save(
              group
                ? {
                    ...values,
                    target: "band",
                    band: group.name,
                    memberIds: group.members.map(({ id }) => id),
                    kind: "Payment",
                  }
                : { ...values, musicianId: selected },
            );
          }}
        >
          <Field label="Payee">
            <select
              value={selected}
              onChange={(event) => {
                const next = event.target.value;
                setSelected(next);
                setBand(
                  workspace.musicians.find(({ id }) => id === next)?.band || "",
                );
              }}
            >
              <optgroup label="Musicians">
                {workspace.musicians.map((musician) => (
                  <option value={musician.id} key={musician.id}>
                    {musician.name}
                  </option>
                ))}
              </optgroup>
              {bands.size > 0 && (
                <optgroup label="Bands">
                  {Array.from(bands, ([key, band]) => (
                    <option value={"band:" + key} key={key}>
                      {band.name} ({band.members.length})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>
          <div className="grid">
            <Field label={group ? "Amount per member (DKK)" : "Amount (DKK)"}>
              <input
                required
                type="number"
                min="0.01"
                max="1000000"
                step="0.01"
                name="amount"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </Field>
            <Field label="Date paid">
              <input
                name="paidOn"
                type="date"
                required
                defaultValue={today()}
              />
            </Field>
            {!group && (
              <Field label="Band">
                <input
                  name="band"
                  value={band}
                  onChange={(event) => setBand(event.target.value)}
                />
              </Field>
            )}
            <Field label="Performance date">
              <input
                name="performedOn"
                type="date"
                required
                value={date}
                onChange={(event) => {
                  const next = event.target.value;
                  if (amountInOre === tariff(date))
                    setAmount(String(tariff(next) / 100));
                  setDate(next);
                }}
              />
            </Field>
            <Field label="Payment reference">
              <input
                name="reference"
                defaultValue={workspace.venue.reference}
              />
            </Field>
            {!group && (
              <Field label="Entry type">
                <select name="kind">
                  <option>Payment</option>
                  <option>Refund</option>
                </select>
              </Field>
            )}
          </div>
          <Field label="Notes (optional)">
            <textarea name="notes" rows={2} />
          </Field>
          {tariff(date) > 0 && (
            <p className="fine">
              DMF reference · {money(tariff(date))} per musician
            </p>
          )}
          {group && (
            <div className="band-total">
              <p>{group.members.map(({ name }) => name).join(", ")}</p>
              <strong>
                {group.members.length} × {money(amountInOre)} ={" "}
                {money(group.members.length * amountInOre)}
              </strong>
            </div>
          )}
          <button disabled={busy}>
            {busy ? "Saving…" : group ? "Save band payment" : "Save payment"}
          </button>
        </form>
      )}
    </>
  );
}

function MusicianEditor({
  profile,
  collectCpr,
  busy,
  save,
}: {
  profile: Musician;
  collectCpr: boolean;
  busy: boolean;
  save: (profile: object) => void;
}) {
  const [payee, setPayee] = useState(profile.payee);
  return (
    <form
      onSubmit={(event) =>
        save({ cpr: "", cvr: profile.cvr, ...fields(event) })
      }
    >
      <h2 id="workspace-dialog-title">Edit musician</h2>
      <div className="grid">
        <Field label="Legal name">
          <input
            name="name"
            defaultValue={profile.name}
            required
            minLength={2}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            name="email"
            defaultValue={profile.email}
            required
          />
        </Field>
        <Field label="Phone">
          <input type="tel" name="phone" defaultValue={profile.phone} />
        </Field>
        <Field label="Band">
          <input name="band" defaultValue={profile.band} />
        </Field>
        <Field label="Full address">
          <input
            name="address"
            defaultValue={profile.address}
            required
            minLength={5}
          />
        </Field>
        <Field label="Payment recipient">
          <select
            name="payee"
            value={payee}
            onChange={(event) =>
              setPayee(event.target.value as Musician["payee"])
            }
          >
            <option>Individual</option>
            <option>Business</option>
          </select>
        </Field>
        {payee === "Business" && (
          <Field label="CVR">
            <input
              name="cvr"
              defaultValue={profile.cvr}
              required
              inputMode="numeric"
              pattern="[0-9]{8}"
            />
          </Field>
        )}
        {collectCpr && (
          <Field label="CPR (optional)">
            <input
              name="cpr"
              defaultValue={profile.cpr}
              inputMode="numeric"
              pattern="[0-9]{6}-?[0-9]{4}"
              autoComplete="off"
            />
          </Field>
        )}
        <Field label="Bank registration number">
          <input
            name="registration"
            defaultValue={profile.registration}
            required
            inputMode="numeric"
            pattern="[0-9]{4}"
            autoComplete="off"
          />
        </Field>
        <Field label="Bank account number">
          <input
            name="account"
            defaultValue={profile.account}
            required
            inputMode="numeric"
            pattern="[0-9]{6,10}"
            autoComplete="off"
          />
        </Field>
      </div>
      <button disabled={busy}>{busy ? "Saving…" : "Save musician"}</button>
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
