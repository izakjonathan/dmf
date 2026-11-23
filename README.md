# Stagebook

A Next.js app for musician registration and payment records. The venue enters its organizer information once. Musicians register from a shareable link. The venue can add a payment directly from a musician’s profile.

The app saves to a dedicated Google Sheet on every successful change. It creates Venue, Musicians, Payments and Summary tabs. Reports use actual payment dates and the band saved with each payment. The app records payments already made.

## Connect a Google Sheet

1. Create a dedicated, private workbook and open **Extensions → Apps Script**.
2. Paste [Code.gs](public/Code.gs). In **Services**, add **Google Sheets API**.
3. Run **initialize** and authorize it. In **Project Settings → Script properties**, copy the value of **API_SECRET**.
4. Deploy a **Web app** that runs as the owner and accepts requests from **Anyone**. The endpoint verifies a server signature on every request. Copy the **/exec** URL.
5. In the Vercel project, set **GOOGLE_SCRIPT_URL**, **GOOGLE_SCRIPT_SECRET** and **GOOGLE_SPREADSHEET_ID** for Production. Redeploy. **AUTH_SECRET** and **SETUP_TOKEN** must also contain distinct random secrets of at least 32 characters.
6. Open the app and create your administrator login with the setup token. Enter your own information under **Venue**.

Keep both workbooks and the script editor restricted. After the payout migration, the owner-only payout workbook holds CPR and payment details. The hidden state tab in the main workbook holds opaque payout references. Edit records through the app because saves regenerate the workbook tabs. Before collecting CPR, confirm the venue’s need and applicable processing requirements.

## Contracts and international accounts

Use **Get registration link** to collect artist and bank details. When recording a payment, leave **Email a DMF contract for signing** checked, enter the performance terms and sign for the organizer. Each recipient, including each paid band member, receives a separate signing link. Find delivery status and manual sharing under **Google Sheet → Signing requests**, and receipts under **Signed contracts**.

For automatic delivery, replace the bound Apps Script with the latest [Code.gs](public/Code.gs). Run **authorizeContractEmail** once in the editor as the deployment owner and approve the email permission. It does not send a message. Then go to **Deploy → Manage deployments**, edit the existing web app and deploy a **New version** to retain the same endpoint URL. Email is sent through the script owner's Google account with the venue email set as Reply-To.

## Sheet display formats

The Apps Script writes native dates, times and DKK amounts to the generated tabs. Timestamps use the workbook time zone. Change their display in Google Sheets using **Format → Number**. Compatible formats already applied to data cells are preserved. Existing rows are converted on the next successful save after deploying the updated script.

## Development

Run `npm ci`, `npm test` and `npm run build`. The demo works without a workbook and keeps its sample data in memory.

## Privacy and data

The registration and act forms require acknowledgement of the notice. Every new
submission records its notice version and a server timestamp. Earlier registrations
carry no acknowledgement until submitted again. Edit the wording and version in
[lib/privacy.ts](lib/privacy.ts).

Keep the main workbook and its historical versions restricted. The app's AuditLog
records booking, form, contract, attendance and payment events, plus full record
views through the app. It uses event labels, booking and musician IDs and an actor.
It does not cover direct Google Sheets access or downloads. A dry run does not write
an audit row.

### Retention (disabled by default)

Confirm the period with the venue's accountant before enabling the job. Version
history, earlier workbook copies, previously delivered email, and any exports need
to be handled separately. A change to the current workbook does not erase those copies.

1. Update the existing Apps Script web app with a new version of
   [public/Code.gs](public/Code.gs), keeping its existing deployment URL. Then deploy
   the corresponding Vercel build. This update adds no Vercel environment variables
   and requires no data migration for the acknowledgement or audit log.
2. Optionally set the script property `RETENTION_YEARS` (the default is 5).
   Run `dryRunStagebookRetention` in the Apps Script editor. Review the counts
   in the execution log. This neither changes the workbook nor sends mail.
3. After the accountant confirms the period, the owner can run
   `enableStagebookRetention` to start the daily job. The function manages
   `RETENTION_ENABLED`; leave that property unset until then. Use
   `disableStagebookRetention` to remove the trigger and disable future runs.

The job keeps records through the end of the cutoff year. For example, with a
five-year period, a last booking and payment in 2020 becomes eligible on
1 January 2026. Stagebook uses the later booking or payment year and falls back to
registration year for musicians who were never booked or paid. It also considers
related profiles, linked contracts and future bookings. A historical booking with
another musician’s unsettled payment defers anonymisation of its eligible musicians until
that payment is resolved. The job removes direct identifiers and payout fields
from eligible records and their linked copies and keeps pseudonymous IDs, dates,
attendance, and payment amounts. It removes associated pending and historical
outbox entries. It archives affected bookings so old registration links and
historic worksheet rows cannot restore the removed data.

### Separate payout workbook

Set up two files before switching the live app:

1. In the deployment owner's Google Drive, create a blank spreadsheet and make
   its **General access** Restricted with the owner as the only person. Create a
   separate restricted copy of the existing main workbook as the rollback backup.
   The copy contains sensitive information, so keep it owner-only.
2. Set `SENSITIVE_SPREADSHEET_ID` to the blank file's spreadsheet ID and
   `SENSITIVE_BACKUP_ID` to the backup's spreadsheet ID in Apps Script properties.
   Deploy a new version at the existing Apps Script URL. Run
   `migrateStagebookSensitiveData` in the editor as the owner. It copies the
   private details first, replaces them with references in the main workbook,
   clears the generated columns, and then marks `SENSITIVE_MIGRATED` true.
   Re-running the function after a successful migration is a no-op.
3. Deploy the matching Vercel build. The main workbook still holds booking and
   musician contact information. The separate workbook holds CPR, bank
   registration and account numbers, IBAN, and MobilePay numbers. MobilePay is
   a separate field. Where a legacy record reused its contact phone as a
   MobilePay number, the migration keeps it in the private payout record and
   clears that duplicate contact-phone value. The app displays masked values.
   An admin can explicitly reveal the full details, and the action is audited.
4. Check the new main workbook version and the Stagebook admin views with
   synthetic records. Preserve the backup according to the venue's agreed
   policy and remove its script property once the backup is no longer needed.

Google Sheets version history can still contain older values. For an optional
sanitized replacement, after verifying the migration, make an owner-only fresh
copy of the **current** sanitized workbook and check that the copy contains only
approved tabs and data. A copied bound script has a separate deployment. Set up
its properties, keep the established signing secret to preserve existing links,
install the necessary booking triggers, deploy it, and switch the workbook ID
and script URL in Vercel together. Disable the old project's triggers at cutover
and keep the original workbook restricted. If other people can edit the main
workbook, use the replacement before granting edit access. Never share the
backup or the previous workbook as the sanitized copy.

### Original Danish contract

The original template is [public/legal/DMF_Standardkontrakt.pdf](public/legal/DMF_Standardkontrakt.pdf).
Apps Script fetches this public, blank PDF from the production Vercel site and
verifies its checksum before attaching it to signing requests and final receipt
emails for newly issued terms. The signed agreement is still delivered through
the private receipt link. Deploy the Vercel build containing the PDF before
sending any emails that need the attachment. If the PDF cannot be fetched or
verified, the send remains pending or reports an attachment error.

**Pending legal review by DMF or a lawyer:** the sentence that says the Danish
original prevails if the two versions differ. The English conditions and this
sentence are versioned on newly issued contracts. Older signed receipts retain
the wording from their existing version.

### Booking workflow

Create a booking in Stagebook or on the current **Bookings** layout. Both paths
use the same Apps Script import and start new bookings with musicians signing
first. Older engagements retain their original signing order. The contact
email contains the act form and a shareable booking registration link. The
contact provides the schedule and lineup count. Each musician provides their
own registration, then receives an individual contract when the roster and
schedule are complete. Signing records the typed name, agreement checkbox and
timestamp. Signing links expire and cannot sign twice. Individual email
verification links expire after 30 minutes and are consumed on registration.
The shareable booking link closes to submissions once contracts are issued and
expires after the day following the performance. The generic venue registration
link remains shareable and expires after 90 days.

Date-scoped staff links show act logistics only. Technicians confirm the act
or report a deviation. The venue resolves individual attendance where needed
and countersigns after the show. The booking payment queue enables recording
payment only after the relevant attendance and signatures are in place.
