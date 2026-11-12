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
