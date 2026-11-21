# Booking sheet layout

The first 18 columns match the venue's original booking sheet. The active Stagebook tab is `Bookings`.

## Activate once

1. Replace the Apps Script editor contents with `public/Code.gs` and save.
2. Update the existing web-app deployment using **Manage deployments → Edit → New version → Deploy**. Keep its existing URL, API secret and workbook binding.
3. Reload the workbook in a desktop browser. **Stagebook → Review, sign and send contracts** appears in the menu bar. The workbook owner may be asked to authorize the new menu action on first use. Run `upgradeBookingSheet` only if the active tab still starts with the legacy header `Performance date`.
4. In Stagebook, open **Contracts → Check email setup** to verify the deployed adapter version, trigger status and mail quota.

The upgrade takes the workbook lock, reads the latest active rows, carries over staff fields from the prepared tab, and retains the original tab as a timestamped backup. It preserves booking IDs and existing invitation links. It does not send emails or mark any payments as processed. Existing on-edit and scheduled triggers continue to work. Running the upgrade again is safe. Do not manually rename or rearrange the active tab before upgrading.

## Review from a booking row

Use **Review contract** in column AC to open that booking in Stagebook. Sign in to Stagebook if prompted. Review the terms, enter the company signer’s name and confirm before sending. On older Apps Script versions, Stagebook syncs the booking row before saving the signature. If the terms changed, it asks you to review them again.

## Confirm, sign and send from the Sheets menu

Select a single row on **Bookings**. Once the schedule, fee and all registrations are complete, open **Stagebook → Review, sign and send contracts**. Review the terms, enter the venue signer's full name and choose **OK**. Closing the dialog makes no change. The menu requires the workbook owner's Google account. The artist emails each contain their own signature link. Column X tracks the contract status, and Stagebook shows individual email and signature status.

Attendance is a separate step. It stays in the Stagebook night view, and booking payments require a signed agreement and confirmed attendance. If the row or agreement changes during review, reopen it before signing.

## In Stagebook

- The booking contact completes the schedule and forwards the musician link. Each performer can register directly. Returning musicians can request a private link to reuse saved details.
- In **Bookings → Manage bookings**, open the date and use **Staff access for this night**. The link is scoped to that date, can be replaced or revoked, and belongs to the named staff member.
- Record who performed on the night. Check the booking checklist and reissue expired or revoked unsigned agreements as needed.
- In **Payments**, use the grouped queue and verify the selected musicians before recording money already transferred or paid out.

## Columns

| Column | Header | Responsibility |
| --- | --- | --- |
| A | Dato | Venue enters the booked performance date. |
| B | Payment complete | Automatic. All booked members must have actual non-void payments. |
| C | Bandnavn | Venue enters the act name. |
| D | Billet pris | Staff input, DKK. |
| E | Entre indtægt | Staff input, DKK. |
| F | Honorar udgifter | Automatic. Agreed fee per musician × booked lineup. Blank until a fee is entered. |
| G | Antal musikere | Artist-supplied lineup size. Waits for the band contact’s schedule and confirmed musician count. |
| H | Antal Gæster | Staff input. Never derived from income or ticket price. |
| I | Døren udgør % betaling | Entrance income ÷ total agreed fees. Blank when no fee is agreed. |
| J | Mail | Venue enters the booking contact email. Stagebook emails a private schedule link and a shareable musician registration link. |
| K | Telefon | From the registered booking contact's musician profile, if available. |
| L | Ansvarlig Booker | Staff input. Suggested values: Ebbe or Bertil; other names accepted. |
| M | Info sendt | Staff input. Independent of Stagebook's email-delivery log. |
| N | PR Modtaget | Staff checkbox. |
| O | Offentliggjort på Facebook | Staff checkbox. |
| P | Offentliggjort på hjemmeside | Staff checkbox. |
| Q | Offentliggjort på Vinter Jazz | Staff checkbox. |
| R | Offentliggjort på Instagram | Staff checkbox. |
| S | Fee per musician DKK | Optional venue-agreed fee; leave blank for the artist to supply. |
| T | Payment type | Automatic artist payment-method summary. |
| U | Payment due | Optional venue input; defaults to the next weekday after the performance. |
| V | Cancelled | Optional venue input, Yes or No. |
| W | Booking ID | Managed by Stagebook. Never change or copy to create a new booking. |
| X | Status | Contract status for the booking. |
| Y | Registration link | Managed by Stagebook. |
| Z | Registration progress | Managed by Stagebook. |
| AA | Email status | Managed by Stagebook. |
| AB | Issue | Managed by Stagebook. |

Staff edits to D, E, H and L–R are preserved and do not revoke contracts or queue new invitations. Payment completion is an output only: checking its cell cannot create a payment. Changing agreed booking inputs still requires renewed approval as before. Hiding columns remains supported; changing their order or headers is not supported.

After saves and the next scheduled sync, financial and registration projections update. Money is numeric DKK, dates are native date values, and the door share is numeric percentage. Existing legacy layouts remain supported until the explicit upgrade.
