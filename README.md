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

## Development

Run `npm ci`, `npm test` and `npm run build`. The demo works without a workbook and keeps its sample data in memory.
