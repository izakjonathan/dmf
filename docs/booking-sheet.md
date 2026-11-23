# Booking sheet layout

The first 18 columns match the venue's original booking sheet. The active Stagebook tab is `Bookings`.

## Activate the workflow

Deploy the application before updating the existing Apps Script web app with `public/Code.gs`. Use **Manage deployments → Edit → New version → Deploy** to keep the current web app URL. Reload the workbook to show the Stagebook menu. Approve the Google authorization prompt as the owner when needed. Existing booking triggers continue to run. **Bookings → Manage bookings → Update bookings** refreshes the sheet and its columns. For a legacy layout headed `Performance date`, run `upgradeBookingSheet` first. The upgrade keeps the original tab as a backup.

## Daily workflow

Each booking shows its **Workflow status** and, when staff can act, a **Next action**. In Sheets these are columns AR and AS. The link opens the exact booking, payment queue or contract review in Stagebook and works from a phone browser. Contract review remains under **Contracts**. The desktop Sheets menu remains available.

A confirmed performance with an absent musician can proceed to countersigning and payment for the musicians who performed and signed. Keep the affected musician's exception open until its fee has been handled separately or no fee is due. Record the reason and your name under **Details → Resolve performance exception**. Stagebook retains the original attendance and signed records. The booking stays open until outstanding payments and exceptions are resolved.

The **Payment complete** checkbox in column B is a technical output. Record processed payments through the booking's action. If delivery is uncertain, open the affected booking's email details and verify delivery before sharing a replacement link.

## Work from either surface

| Task | Google Sheets | Stagebook |
| --- | --- | --- |
| Add a booking | Fill the booking row with A, C, D, J, L, S and AD. Optional contact phone goes in AE. | **Bookings → New booking** saves to the same sheet. |
| Check registration and emails | Columns X–AB and AI show registration and email progress and the two event links. | **Manage bookings** shows the schedule, registration count, promotion details and email history. |
| Confirm performance | Select the row and choose **Stagebook → Confirm performance**. For exceptions, choose **Open selected booking**. | Open the date in **Bookings** or use a date-scoped staff link. |
| Countersign after the show | Select the row and choose **Stagebook → Review and sign contracts**. | Open **Contracts → Booking contracts → Review and countersign**. |
| View and record payments | Read **Booking payments**, or select the booking and choose **Stagebook → Open payment queue** or **Record processed payment**. | **Payments** shows why each payment is pending and lets an admin record money already paid. |
| Add tickets sold | Enter the count in AF after the show. | Open **Manage bookings**, select the act, then save ticket sales. |

New bookings require the agreed fee and ticket price (use 0 for free entry). The contact email includes a private form for schedule, musician count and promotion details plus a shareable form for individual musician registration. Add venue introduction and equipment copy later through the optional Apps Script properties `BOOKING_VENUE_INTRO` and `BOOKING_EQUIPMENT`.

After everyone registers and the schedule is complete, the system queues an individual signing request for each musician. Confirm the performance and collect all musician signatures before the venue countersigns. Countersigning emails private links to both-signed copies and clears the final payment gate. Existing bookings keep their original signing order. Payment entries record funds already paid. Keep the workbook restricted to authorized staff.

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
| S | Fee per musician DKK | Venue enters the agreed fee for new bookings. Legacy bookings retain the previous rules. |
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

## Appended columns

| Column | Responsibility |
| --- | --- |
| AC | Existing contract review column. |
| AD | Contact name, entered by the venue. |
| AE | Optional contact phone, entered by the venue. Column K displays the contact phone where available. |
| AF | Tickets sold, entered after the show. |
| AG | Ticket price × tickets sold. |
| AH | Ticket revenue ÷ total agreed fees. |
| AI | Private contact registration form for this booking. |
| AJ | Open this act in Stagebook. |
| AK–AM | Start time, sets and minutes per set. |
| AN | Performance confirmation. |
| AO–AQ | Act bio, press photo and artist website. |

The new ticket calculation has its own columns. The original manual entrance income and guest count fields can still be used.

| Column | Technical schedule field | Source |
| --- | --- | --- |
| AT | Genre | Band contact |
| AU | Get-in | Band contact or venue override, stored as a time |
| AV | Soundcheck | Yes or No |
| AW | Soundcheck time | Only when Yes, stored as a time |
| AX | Ends | Stored as a time; an end earlier than the start is next day |
| AY | Technical notes | Notes supplied for the venue technician |

These columns are appended after the existing booking action columns during
booking sync. Enter changes in Stagebook while contract terms are open. If an
agreement has already been issued, use the existing correction workflow before
changing its schedule. Use same-day clock times before the performance start for
get-in and soundcheck.

A fee below the applicable DMF tariff shows an advisory note on the fee cell in
column S. It does not stop booking or contract processing. Set
`BOOKER_TARIFF_WARNING_EMAIL` in Apps Script to opt in and route below-tariff
creation and fee-change notices to the booker's address. Leave it unset to keep
these warnings on screen and in the workbook only.
