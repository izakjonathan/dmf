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

Keep the workbook and script editor restricted to the people authorized to handle payment data. The workbook includes bank details and any CPR supplied with the optional CPR field enabled. Its hidden state tab is part of the data store. Edit records through the app because saves regenerate the workbook tabs. Before collecting CPR, confirm the venue’s need and applicable processing requirements.

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

Keep the workbook owner-only while it still holds payout data. The app's AuditLog
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
