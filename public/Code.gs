/**
 * Stagebook spreadsheet adapter. Bind to a dedicated spreadsheet.
 * Enable Google Sheets API under Services before running initialize.
 */
function initialize() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  const configuredId = props.getProperty("SPREADSHEET_ID");
  if (configuredId && configuredId !== spreadsheet.getId()) throw Error("This script is already bound to another workbook.");
  const names = ["Venue", "Musicians", "Payments", "Summary", "Contracts", "_Stagebook"];
  if (!configuredId && names.some(name => spreadsheet.getSheetByName(name)?.getLastRow())) {
    throw Error("Use a new workbook so existing data cannot be overwritten.");
  }
  for (const name of names) {
    if (!spreadsheet.getSheetByName(name)) spreadsheet.insertSheet(name);
  }
  spreadsheet.getSheetByName("_Stagebook").hideSheet();
  const secret = props.getProperty("API_SECRET") || Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
  props.setProperties({ SPREADSHEET_ID: spreadsheet.getId(), API_SECRET: secret });
  console.info("Stagebook initialized. Find API_SECRET under Project Settings → Script properties.");
}

function doPost(event) {
  let lock;
  let step = "checking the request";
  try {
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty("API_SECRET");
    const input = JSON.parse(event.postData.contents);
    if (!secret || typeof input.body !== "string" || input.body.length > 3000000) return respond({ok:false});
    const expected = Utilities.computeHmacSha256Signature(input.body, secret)
      .map(value => ((value + 256) % 256).toString(16).padStart(2, "0")).join("");
    if (!matches(expected, String(input.signature || ""))) {
      console.warn("Stagebook request signature did not match.");
      return respond({ok:false});
    }
    const request = JSON.parse(input.body);
    if (!Number.isFinite(request.timestamp) || Math.abs(Date.now() - request.timestamp) > 120000) return respond({ok:false});
    lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      console.warn("Stagebook could not acquire the workbook lock.");
      return respond({ok:false});
    }
    step = "opening the workbook";
    const book = SpreadsheetApp.openById(props.getProperty("SPREADSHEET_ID"));
    const storage = book.getSheetByName("_Stagebook");
    const revision = Number(storage.getRange("A1").getValue()) || 0;
    if (request.action === "write") {
      if (request.expected !== revision) return respond({ok:false,error:"CONFLICT"});
      if (request.state?.revision !== revision + 1) {
        console.warn("Stagebook received an invalid workbook revision.");
        return respond({ok:false});
      }
      step = "saving the workbook";
      writeWorkbook(book, request.state);
      return respond({ok:true});
    }
    const length = storage.getLastRow();
    const encoded = length > 1 ? storage.getRange(2,1,length-1,1).getValues().map(row=>row[0]).join("") : "";
    const state = encoded ? JSON.parse(Utilities.newBlob(Utilities.base64Decode(encoded)).getDataAsString("UTF-8")) : null;
    if (request.action === "syncBookings" || request.action === "bookingMail") {
      if (!state?.auth) return respond({ok:false});
      if (request.action === "syncBookings") {
        syncBookingRows(book,state,props);
        queueBookingReminders(state,props);
        writeBookingState(book,state);
      }
      const result = processBookingMail(book,state,props);
      refreshBookingEmailStatuses(book,state);
      return respond(result);
    }
    if (request.action === "emailContracts") {
      step = "sending contract emails";
      return respond(emailContracts(book, state, request.links, props));
    }
    if (request.action === "metadata") return respond({ok:true,initialized:Boolean(state?.auth)});
    if (request.action === "read") return respond({ok:true,state:state});
    return respond({ok:false});
  } catch (error) {
    console.error("Stagebook failed while " + step + ": " + error.message);
    return respond({ok:false,error:step === "sending contract emails" ? "MAIL_STATUS_UNAVAILABLE" : undefined});
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}
// Run once in the editor as the existing web app owner. This sends no email.
function authorizeContractEmail() {
  console.info("Contract email is authorized. Remaining recipients today: " + MailApp.getRemainingDailyQuota());
}
function emailContracts(book, state, links, props) {
  if (!state || !Array.isArray(links) || !links.length) return {ok:false};
  const delivery = {sent:0, failed:0, issues:[]};
  function failure(code) {
    delivery.failed++;
    if (!delivery.issues.includes(code)) delivery.issues.push(code);
    console.warn("Stagebook contract email: " + code);
  }
  let quota;
  try {
    quota = MailApp.getRemainingDailyQuota();
  } catch (error) {
    const code = contractEmailError(error);
    for (const item of links) failure(code);
    return {ok:true,state,delivery};
  }
  const recorded = [];
  for (const item of links) {
    const invite = state.invites.find(value => value.id === item.id);
    if (!invite?.paymentId || !invite.offer || invite.revoked || invite.signedAt ||
        invite.offer.returnBy < Utilities.formatDate(new Date(), "Europe/Copenhagen", "yyyy-MM-dd") ||
        !state.payments.some(payment => payment.id === invite.paymentId && !payment.voidReason) ||
        !/^https:\/\/dmf-eta\.vercel\.app\/register\/[a-f0-9]{64}$/.test(item.url)) {
      failure("MAIL_INACTIVE");
      continue;
    }
    if (invite.emailSentAt) {
      delivery.sent++;
      continue;
    }
    const key = "stagebook-contract-mail:" + invite.id;
    const reserved = props.getProperty(key);
    if (reserved && reserved !== "sending") {
      invite.emailSentAt = reserved;
      recorded.push(key);
      delivery.sent++;
      continue;
    }
    if (reserved || quota < 1) {
      failure(reserved ? "MAIL_UNCERTAIN" : "MAIL_QUOTA");
      continue;
    }
    const offer = invite.offer;
    props.setProperty(key, "sending");
    try {
      MailApp.sendEmail({
        to: offer.performerEmail,
        replyTo: offer.organizer.email,
        name: offer.organizer.name,
        subject: "DMF contract to sign · " + offer.performanceDate,
        body: "Please review and sign your DMF contract for " + offer.organizer.name +
          " (performance " + offer.performanceDate + ").\n\n" +
          item.url + "\n\nSigning deadline: " + offer.returnBy +
          "\nIf you have questions, reply to the venue."
      });
      quota--;
      invite.emailSentAt = new Date().toISOString();
      props.setProperty(key, invite.emailSentAt);
      recorded.push(key);
      delivery.sent++;
    } catch (error) {
      const code = contractEmailError(error);
      // Google explicitly rejected these sends. Keep reservations for unknown outcomes.
      if (code !== "MAIL_UNCERTAIN") props.deleteProperty(key);
      failure(code);
    }
  }
  if (recorded.length) {
    state.revision++;
    writeWorkbook(book,state);
    for (const key of recorded) props.deleteProperty(key);
  }
  return {ok:true,state,delivery};
}
function contractEmailError(error) {
  const message = String(error?.message || error);
  if (/authoriz|permi[st]|access denied|scope/i.test(message)) return "MAIL_PERMISSION";
  if (/quota|too many|daily limit/i.test(message)) return "MAIL_QUOTA";
  if (/invalid.*(?:address|email|recipient)|(?:address|recipient).*invalid/i.test(message)) return "MAIL_ADDRESS";
  return "MAIL_UNCERTAIN";
}
function matches(a,b) {
  let diff = a.length ^ b.length;
  for (let i=0; i<a.length; i++) diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function respond(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
function paymentNet(payment) {
  return payment.voidReason ? 0 : payment.kind === "Refund" ? -payment.amount : payment.amount;
}
function weekKey(date) {
  const day = new Date(date + "T12:00:00Z");
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year,0,1)) / 86400000 + 1) / 7);
  return year + "-W" + String(week).padStart(2,"0");
}
function rowsFor(state) {
  const v = state.venue;
  const venue = [
    ["Venue","Legal organizer","Address","CVR","Email","Phone","Default payment reference","Collect CPR"],
    [v.name,v.legalName,v.address,v.cvr,v.email,v.phone,v.reference,v.collectCpr ? "Enabled" : "Disabled"]
  ];
  const musicians = [["Musician ID","Legal name","Email","Phone","Address","Band","Recipient","CVR","CPR","Bank registration","Bank account","Registered","Updated","IBAN","Starts","Ends","Soundcheck","Sets","Minutes per set","Requests"]];
  for (const m of state.musicians) musicians.push([m.id,m.name,m.email,m.phone,m.address,m.band,m.payee,m.cvr,m.cpr,m.registration,m.account,m.createdAt,m.updatedAt,m.iban || "",m.performance?.start || "",m.performance?.end || "",m.performance?.soundcheck || "",m.performance?.sets ?? "",m.performance?.minutesPerSet ?? "",m.performance?.requests || ""]);
  const payments = [["Payment ID","Musician ID","Musician","Band at payment","Venue","Paid on","Performance date","Amount DKK","Net DKK","Type","Reference","Notes","Void reason","Recorded at","Payment type"]];
  const groups = new Map();
  for (const p of state.payments) {
    const net = paymentNet(p);
    payments.push([p.id,p.musicianId,p.name,p.band,p.venue,p.paidOn,p.performedOn,p.amount/100,net/100,p.kind,p.reference,p.notes,p.voidReason||"",p.recordedAt,p.paymentType || ""]);
    if (p.voidReason) continue;
    for (const [type,label,identifier] of [
      ["Week",weekKey(p.paidOn),""],["Month",p.paidOn.slice(0,7),""],["Year",p.paidOn.slice(0,4),""],
      ["Band",p.band||"Unspecified",""],["Musician",p.name,p.musicianId]
    ]) {
      const key = JSON.stringify([type,identifier || label]);
      const previous = groups.get(key);
      groups.set(key,[type,label,(previous ? previous[2] : 0)+net,identifier]);
    }
  }
  const summary = [["Group","Period / name","Net paid DKK","Musician ID"]];
  for (const key of Array.from(groups.keys()).sort()) {
    const [type,label,net,identifier] = groups.get(key);
    summary.push([type,label,net/100,identifier]);
  }
  const contracts = [[
    "Contract ID","Musician ID","Musician","Email","Band","Venue","Performance date",
    "Starts","Ends","Sets","Minutes per set","Fee DKK","Payment","Special agreements",
    "Organizer signer","Organizer signed at","Musician signer","Musician signed at","Template","Soundcheck","Requests","Payment type"
  ]];
  for (const c of state.contracts || []) {
    const t = c.offer;
    contracts.push([
      c.id,c.musicianId,c.performer.name,c.performer.email,c.performer.band,t.organizer.name,t.performanceDate,
      t.start,t.end,t.sets,t.minutesPerSet,t.fee/100,t.payOn || "First working day after performance",t.specialTerms,
      t.organizerSigner,t.organizerSignedAt,c.performerSigner,c.performerSignedAt,t.template.url,t.soundcheck || "",t.requests || "",t.paymentType || ""
    ]);
  }
  const bookingMembers = [["Booking ID","Performance date","Act","Musician ID","Musician","Email","Contract ID","Attendance","Payment ID","Company approved by","Performance confirmed by","Performance confirmed at","Exception"]];
  const bookingPayments = [["Booking ID","Performance date","Act","Musician","Email","Fee DKK","Payment type","Payment due","Status","Payment ID"]];
  const bookingEmails = [["Booking ID","Recipient","Kind","Status","Sent at","Issue"]];
  for (const b of state.bookings || []) for (const m of b.members) {
    bookingMembers.push([b.id,b.date,b.act,m.musicianId,m.name,m.email,m.contractId || "",m.attendance || "",m.paymentId || "",b.approvedBy || "",b.confirmedBy || "",b.confirmedAt || "",b.attendanceNote || ""]);
    const signed = (state.contracts || []).some(c=>c.id===m.contractId && c.bookingVersion===b.version);
    const status = m.paymentId ? "Paid" : b.cancelled ? "Cancelled" : b.approvedVersion!==b.version ? "Company approval needed" : !signed ? "Artist signature needed" : !b.confirmedAt ? "Performance confirmation needed" : m.attendance!=="played" ? "Performance exception" : "Ready to pay";
    bookingPayments.push([b.id,b.date,b.act,m.name,m.email,b.fee/100,m.paymentType || b.paymentType,b.dueOn,status,m.paymentId || ""]);
  }
  for (const mail of state.bookingMail || []) if (mail.kind!=="verification") bookingEmails.push([mail.bookingId,mail.to,mail.kind,mail.status,mail.sentAt || "",mail.error || ""]);
  return {Venue:venue,Musicians:musicians,Payments:payments,Summary:summary,Contracts:contracts,
    "Booking members":bookingMembers,"Booking payments":bookingPayments,"Booking emails":bookingEmails};
}
const DATE_FORMAT = {type:"DATE",pattern:"dd-mm-yyyy"};
const TIME_FORMAT = {type:"TIME",pattern:"hh:mm"};
const DATE_TIME_FORMAT = {type:"DATE_TIME",pattern:"dd-mm-yyyy hh:mm"};
const DKK_FORMAT = {type:"CURRENCY",pattern:'#,##0.00 "kr."'};
const COLUMN_FORMATS = {
  Musicians: {"Registered":DATE_TIME_FORMAT,"Updated":DATE_TIME_FORMAT,"Starts":TIME_FORMAT,"Ends":TIME_FORMAT},
  Payments: {"Paid on":DATE_FORMAT,"Performance date":DATE_FORMAT,"Amount DKK":DKK_FORMAT,
    "Net DKK":DKK_FORMAT,"Recorded at":DATE_TIME_FORMAT},
  Contracts: {"Performance date":DATE_FORMAT,"Starts":TIME_FORMAT,"Ends":TIME_FORMAT,
    "Fee DKK":DKK_FORMAT,"Payment":DATE_FORMAT,"Organizer signed at":DATE_TIME_FORMAT,
    "Musician signed at":DATE_TIME_FORMAT},
  Summary: {"Net paid DKK":DKK_FORMAT},
  "Booking members": {"Performance date":DATE_FORMAT,"Performance confirmed at":DATE_TIME_FORMAT},
  "Booking payments": {"Performance date":DATE_FORMAT,"Fee DKK":DKK_FORMAT,"Payment due":DATE_FORMAT},
  "Booking emails": {"Sent at":DATE_TIME_FORMAT}
};
function sheetValue(value, format, timeZone) {
  if (typeof value === "number") return {numberValue:value};
  const literal = String(value ?? "");
  const type = format?.type;
  if (type === "TIME" && /^([01]\d|2[0-3]):[0-5]\d$/.test(literal)) {
    const [hour,minute] = literal.split(":").map(Number);
    return {numberValue:(hour * 60 + minute) / 1440};
  }
  let dateText = literal;
  if (type === "DATE_TIME" && /^\d{4}-\d{2}-\d{2}T/.test(literal)) {
    const instant = new Date(literal);
    if (!Number.isNaN(instant.getTime())) {
      dateText = Utilities.formatDate(instant, timeZone, "yyyy-MM-dd'T'HH:mm:ss.SSS");
    }
  }
  if ((type === "DATE" || type === "DATE_TIME") &&
      /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3})?$/.test(dateText)) {
    const milliseconds = Date.parse((dateText.includes("T") ? dateText : dateText + "T00:00:00") + "Z");
    if (Number.isFinite(milliseconds)) return {numberValue:milliseconds / 86400000 + 25569};
  }
  return {stringValue:literal};
}
function currentColumnFormats(book,tables) {
  const ranges = [];
  for (const name of Object.keys(COLUMN_FORMATS)) {
    const sheet = book.getSheetByName(name);
    const last = Math.min(sheet?.getMaxRows() || 0,tables[name].length);
    if (last < 2) continue;
    tables[name][0].forEach((header,column) => {
      if (!COLUMN_FORMATS[name][header]) return;
      const letter = String.fromCharCode(65 + column);
      ranges.push((name.includes(" ") ? "'" + name + "'" : name) + "!" + letter + "2:" + letter + last);
    });
  }
  const formats = {};
  if (!ranges.length) return formats;
  const response = Sheets.Spreadsheets.get(book.getId(), {
    ranges,
    fields:"sheets.properties.title,sheets.data.startColumn,sheets.data.rowData.values.userEnteredFormat.numberFormat"
  });
  for (const sheet of response.sheets || []) {
    const name = sheet.properties.title;
    formats[name] = {};
    for (const data of sheet.data || []) {
      const column = data.startColumn || 0;
      formats[name][column] = (data.rowData || []).map(row => row.values?.[0]?.userEnteredFormat?.numberFormat?.type);
    }
  }
  return formats;
}
function applyDefaultFormats(requests,sheetId,rows,formats,existing) {
  formats.forEach((format,column) => {
    if (!format) return;
    let start = null;
    for (let row=1; row<=rows.length; row++) {
      const current = existing?.[column]?.[row-1];
      const compatible = current === format.type ||
        (format.type === "DATE_TIME" && (current === "DATE" || current === "TIME"));
      const needsFormat = row < rows.length && !compatible &&
        typeof rows[row][column].userEnteredValue.numberValue === "number";
      if (needsFormat && start === null) start = row;
      if (!needsFormat && start !== null) {
        requests.push({repeatCell:{
          range:{sheetId,startRowIndex:start,endRowIndex:row,startColumnIndex:column,endColumnIndex:column+1},
          cell:{userEnteredFormat:{numberFormat:format}},
          fields:"userEnteredFormat.numberFormat"
        }});
        start = null;
      }
    }
  });
}
function writeWorkbook(book,state) {
  const tables = rowsFor(state);
  let createdSheet = false;
  for (const name of ["Contracts","Booking members","Booking payments","Booking emails"]) {
    if (!book.getSheetByName(name)) {
      book.insertSheet(name);
      createdSheet = true;
    }
  }
  if (createdSheet) SpreadsheetApp.flush();
  const existingFormats = currentColumnFormats(book,tables);
  const timeZone = book.getSpreadsheetTimeZone();
  const encoded = Utilities.base64Encode(JSON.stringify(state), Utilities.Charset.UTF_8);
  const storage = [[state.revision]];
  for(let i=0; i<encoded.length; i+=40000) storage.push([encoded.slice(i,i+40000)]);
  tables._Stagebook = storage;
  const requests = [];
  for (const name of Object.keys(tables)) {
    const sheet = book.getSheetByName(name);
    const rows = tables[name];
    if (!sheet) throw Error("Missing required sheet: " + name + ". Run initialize first.");
    if (name === "Contracts" && sheet.getLastRow() && sheet.getRange("A1").getValue() !== rows[0][0]) {
      throw Error("Rename the existing Contracts tab to avoid overwriting unrelated data.");
    }
    const sheetId = sheet.getSheetId();
    if (sheet && rows.length > sheet.getMaxRows()) {
      requests.push({updateSheetProperties:{properties:{sheetId,gridProperties:{rowCount:rows.length}},fields:"gridProperties.rowCount"}});
    }
    const formats = rows[0].map(header => COLUMN_FORMATS[name]?.[header]);
    const values = rows.map((row,index) => row.map((value,column) => ({
      userEnteredValue:sheetValue(value,index ? formats[column] : undefined,timeZone)
    })));
    requests.push({updateCells:{
      range:{sheetId,startRowIndex:0,startColumnIndex:0,endColumnIndex:rows[0].length},
      rows:values.map(values=>({values})),
      fields:"userEnteredValue"
    }});
    applyDefaultFormats(requests,sheetId,values,formats,existingFormats[name]);
    if (name !== "_Stagebook") {
      requests.push({updateSheetProperties:{properties:{sheetId,gridProperties:{frozenRowCount:1}},fields:"gridProperties.frozenRowCount"}});
      requests.push({repeatCell:{
        range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:rows[0].length},
        cell:{userEnteredFormat:{backgroundColor:{red:.15,green:.24,blue:.2},textFormat:{bold:true,foregroundColor:{red:1,green:1,blue:1}}}},
        fields:"userEnteredFormat(backgroundColor,textFormat)"
      }});
    }
  }
  Sheets.Spreadsheets.batchUpdate({requests},book.getId());
  const bookingSheet=book.getSheetByName("Bookings");
  if ((state.bookings || []).length && bookingSheet && bookingSheet.getRange("A1").getValue()==="Dato") refreshBookingProjection(book,state);
}

// Run once after deploying this version. Adds the booking sheet and email triggers.
function setupBookingAutomation() {
  initialize();
  const props = PropertiesService.getScriptProperties();
  const book = SpreadsheetApp.openById(props.getProperty("SPREADSHEET_ID"));
  ensureBookingSheet(book);
  MailApp.getRemainingDailyQuota();
  const names = ["bookingSheetEdited", "runBookingAutomation"];
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (names.includes(trigger.getHandlerFunction())) ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger("bookingSheetEdited").forSpreadsheet(book).onEdit().create();
  ScriptApp.newTrigger("runBookingAutomation").timeBased().everyMinutes(5).create();
  runBookingAutomation();
  console.info("Booking automation enabled. Add acts in the Bookings sheet. Every musician must register individually.");
}
const BOOKING_HEADERS = ["Performance date","Act","Contact email","Musicians","Fee per musician DKK","Payment type","Payment due","Cancelled","Booking ID","Status","Registration link","Registration progress","Email status","Issue"];
const BOOKING_OPERATIONS_HEADERS = ["Dato","Payment complete","Bandnavn","Billet pris","Entre  indtægt","Honorar  udgifter","Antal musikere","Antal Gæster","Døren udgør % betaling","Mail","Telefon","Ansvarlig Booker","Info sendt","PR Modtaget","Offentliggjort på Facebook","Offentliggjort på hjemmeside","Offentliggjort på Vinter Jazz","Offentliggjort på Instagram","Fee per musician DKK","Payment type","Payment due","Cancelled","Booking ID","Status","Registration link","Registration progress","Email status","Issue"];
function modernBookingSheet(sheet) { return sheet.getRange("A1").getValue() === "Dato"; }
function bookingRowFromLegacy(row) {
  const next = Array(28).fill("");
  for (const pair of [[0,0],[1,2],[2,9],[3,6],[4,18],[5,19],[6,20],[7,21],[8,22],[9,23],[10,24],[11,25],[12,26],[13,27]]) next[pair[1]]=row[pair[0]] || "";
  return next;
}
// Run once after installing the new script. The original tab is retained as a backup.
function upgradeBookingSheet() {
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw Error("Booking automation is busy. Try again shortly.");
  try {
    const props=PropertiesService.getScriptProperties();
    const book=SpreadsheetApp.openById(props.getProperty("SPREADSHEET_ID"));
    const current=book.getSheetByName("Bookings");
    if (!current) throw Error("The current Bookings tab is missing.");
    if (modernBookingSheet(current)) { console.info("The booking layout is already upgraded."); return; }
    if (current.getRange("A1").getValue()!==BOOKING_HEADERS[0]) throw Error("The Bookings headers are not recognised.");
    const state=readStoredState(book);
    if (!state || !state.auth) throw Error("Complete Stagebook setup first.");
    const staged=book.getSheetByName("Bookings v2") || book.insertSheet("Bookings v2");
    if (staged.getLastRow() && !modernBookingSheet(staged)) throw Error("Rename the unrelated Bookings v2 tab before upgrading.");
    const prepared=staged.getLastRow()>1 ? staged.getRange(2,1,staged.getLastRow()-1,28).getValues() : [];
    const existing=new Map(prepared.filter(r=>r[22]).map(r=>[String(r[22]),r]));
    const legacy=current.getLastRow()>1 ? current.getRange(2,1,current.getLastRow()-1,14).getValues() : [];
    const mapped=legacy.filter(r=>r.slice(0,9).some(v=>v!=="" && v!==false)).map(row=>{
      const next=bookingRowFromLegacy(row);
      const old=existing.get(String(row[8]));
      if (old) for (const col of [3,4,7,11,12,13,14,15,16,17]) next[col]=old[col];
      return next;
    });
    for (const preparedRow of prepared) if ((!preparedRow[22] || !mapped.some(row=>String(row[22])===String(preparedRow[22]))) && preparedRow[0] && preparedRow[2] && preparedRow[9]) mapped.push(preparedRow);
    if (staged.getMaxColumns()<28) staged.insertColumnsAfter(staged.getMaxColumns(),28-staged.getMaxColumns());
    if (staged.getMaxRows()<mapped.length+1) staged.insertRowsAfter(staged.getMaxRows(),mapped.length+1-staged.getMaxRows());
    staged.getRange(1,1,1,28).setValues([BOOKING_OPERATIONS_HEADERS]);
    if (mapped.length) staged.getRange(2,1,mapped.length,28).setValues(mapped);
    if (prepared.length>mapped.length) staged.getRange(mapped.length+2,1,prepared.length-mapped.length,28).clearContent();
    const backup="Bookings legacy "+Utilities.formatDate(new Date(),"Europe/Copenhagen","yyyyMMdd-HHmmss");
    current.setName(backup);
    try { staged.setName("Bookings"); }
    catch(error) { current.setName("Bookings"); throw error; }
    configureModernBookingSheet(staged);
    syncBookingRows(book,state,props);
    writeBookingState(book,state);
    console.info("Booking columns upgraded. Original rows are kept in "+backup+". Existing links are unchanged.");
  } finally { lock.releaseLock(); }
}
function configureModernBookingSheet(sheet) {
  sheet.setFrozenRows(1);
  sheet.getRange("A1:AB1").setBackground("#444444").setFontColor("#ffffff").setFontWeight("bold");
  for (const range of ["D1:E1","H1","L1:R1"]) sheet.getRange(range).setBackground("#1f2d48").setNote("Staff input. Stagebook never overwrites these values.");
  sheet.getRange("A1").setNote("Enter the performance date to create a booking.");
  sheet.getRange("C1").setNote("Enter the act name to create a booking.");
  sheet.getRange("J1").setNote("Enter the contact email. The registration link is sent here automatically.");
  sheet.getRange("G1").setNote("Updated from the lineup supplied by the artist. Defaults to one until the artist confirms the lineup.");
  sheet.getRange("B1").setNote("Automatic: true only when every booked musician has a recorded, non-void payment. Editing this cell never processes a payment.");
  sheet.getRange("F1").setNote("Automatic: agreed fee per musician multiplied by the booked musician count, in DKK.");
  sheet.getRange("I1").setNote("Automatic: entrance income divided by total agreed fees. Blank when no fee is agreed.");
  sheet.getRange("S1").setNote("Optional venue fee per musician. Leave blank to let the artist provide the agreed fee. Fees from the artist are included in column F.");
  sheet.getRange("A2:A"+sheet.getMaxRows()).setNumberFormat("dd/mm/yyyy");
  sheet.getRange("U2:U"+sheet.getMaxRows()).setNumberFormat("dd/mm/yyyy");
  for (const range of ["D2:F","S2:S"]) sheet.getRange(range+sheet.getMaxRows()).setNumberFormat('#,##0.00 "kr."');
  sheet.getRange("I2:I"+sheet.getMaxRows()).setNumberFormat("0.00%");
  const checkbox=SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange("B2:B"+sheet.getMaxRows()).setDataValidation(checkbox);
  sheet.getRange("N2:R"+sheet.getMaxRows()).setDataValidation(checkbox);
  sheet.getRange("L2:L"+sheet.getMaxRows()).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(["Ebbe","Bertil"],true).setAllowInvalid(true).build());
}
function ensureBookingSheet(book) {
  let sheet = book.getSheetByName("Bookings");
  if (!sheet) sheet = book.insertSheet("Bookings");
  if (modernBookingSheet(sheet)) return sheet;
  if (sheet.getLastRow() && sheet.getRange("A1").getValue() !== BOOKING_HEADERS[0]) {
    throw Error("Rename the existing Bookings tab before enabling Stagebook bookings.");
  }
  sheet.getRange(1,1,1,BOOKING_HEADERS.length).setValues([BOOKING_HEADERS]);
  sheet.setFrozenRows(1);
  sheet.getRange("A:A").setNumberFormat("dd-mm-yyyy");
  sheet.getRange("G:G").setNumberFormat("dd-mm-yyyy");
  sheet.getRange("E:E").setNumberFormat('#,##0.00 "kr."');
  sheet.getRange("A1:H1").setBackground("#1f2d48").setFontColor("#ffffff").setFontWeight("bold");
  sheet.getRange("I1:N1").setBackground("#444444").setFontColor("#ffffff").setFontWeight("bold");
  sheet.getRange("F2:F" + sheet.getMaxRows()).clearDataValidations();
  sheet.getRange("F1").setNote("Stagebook fills this from the artists’ payment method selections. Mixed means band members chose different methods.");
  sheet.getRange("A1:H1").setNote("Enter one act per row. Required: date, act name, contact email and number of musicians. Fees are DKK per musician. Artists choose their payment method in the booking form. Stagebook manages column F. Cancelled accepts Yes or No. Stagebook manages columns I:N.");
  return sheet;
}
function bookingSheetEdited(event) {
  if (!event?.range || event.range.getSheet().getName() !== "Bookings" || event.range.getRow() < 2) return;
  runBookingAutomation();
}
function bookingHmac(message,props) {
  return Utilities.computeHmacSha256Signature(message,props.getProperty("API_SECRET"))
    .map(value => ((value+256)%256).toString(16).padStart(2,"0")).join("");
}
function readStoredState(book) {
  const sheet = book.getSheetByName("_Stagebook");
  const length = sheet.getLastRow();
  if (length < 2) return null;
  const encoded = sheet.getRange(2,1,length-1,1).getValues().map(row=>row[0]).join("");
  return JSON.parse(Utilities.newBlob(Utilities.base64Decode(encoded)).getDataAsString("UTF-8"));
}
function runBookingAutomation() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const book = SpreadsheetApp.openById(props.getProperty("SPREADSHEET_ID"));
    const state = readStoredState(book);
    if (!state?.auth) return;
    syncBookingRows(book,state,props);
    queueBookingReminders(state,props);
    writeBookingState(book,state);
    processBookingMail(book,state,props);
    refreshBookingEmailStatuses(book,state);
  } catch (error) {
    console.error("Stagebook booking automation: " + error.message);
    throw error;
  } finally { lock.releaseLock(); }
}
function bookingDate(value,zone) {
  if (value instanceof Date && !isNaN(value.getTime())) return Utilities.formatDate(value,zone,"yyyy-MM-dd");
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(text+"T12:00:00Z");
  return !isNaN(date.getTime()) && date.toISOString().slice(0,10) === text ? text : "";
}
function nextBookingWeekday(date) {
  const day = new Date(date+"T12:00:00Z");
  do { day.setUTCDate(day.getUTCDate()+1); } while ([0,6].includes(day.getUTCDay()));
  return day.toISOString().slice(0,10);
}
function bookingSourceSignature(value,modern) {
  if (!value) return value;
  try { const input = JSON.parse(value); delete input.paymentType; if (modern) delete input.expectedMembers; return JSON.stringify(input); }
  catch (error) { return value; }
}
function syncBookingRows(book,state,props) {
  const sheet = ensureBookingSheet(book);
  const modern = modernBookingSheet(sheet);
  state.bookings = state.bookings || [];
  state.bookingMail = state.bookingMail || [];
  const length = sheet.getLastRow();
  const rows = length < 2 ? [] : sheet.getRange(2,1,length-1,modern ? 28 : BOOKING_HEADERS.length).getValues();
  const zone = book.getSpreadsheetTimeZone();
  const seen = new Set();
  rows.forEach((sourceRow,index) => {
    const row = modern ? [sourceRow[0],sourceRow[2],sourceRow[9],sourceRow[6],sourceRow[18],sourceRow[19],sourceRow[20],sourceRow[21],sourceRow[22],sourceRow[23],sourceRow[24],sourceRow[25],sourceRow[26],sourceRow[27]] : sourceRow;
    if (modern ? [row[0],row[1],row[2],row[8]].every(value=>value==="" || value===undefined) : row.slice(0,9).every(value => value === "")) return;
    let id = String(row[8] || "").trim();
    let issue = "";
    const date = bookingDate(row[0],zone);
    const act = String(row[1] || "").trim();
    const contactEmail = String(row[2] || "").trim().toLowerCase();
    const previous = state.bookings.find(item=>item.id===id);
    const expectedMembers = modern && previous ? previous.expectedMembers : modern && (row[3]==="" || row[3]===undefined) ? 1 : Number(row[3]);
    const feeDkk = row[4] === "" ? 0 : Number(row[4]);
    const dueOn = row[6] === "" ? date && nextBookingWeekday(date) : bookingDate(row[6],zone);
    const cancelledText = String(row[7] || "No").trim().toLowerCase();
    const cancelled = ["yes","true","cancelled"].includes(cancelledText);
    if (!date || !act || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) issue = "Enter a valid date, act and contact email.";
    if (!Number.isInteger(expectedMembers) || expectedMembers < 1 || expectedMembers > 100) issue = "Musicians must be a whole number between 1 and 100.";
    if (!Number.isFinite(feeDkk) || feeDkk < 0 || feeDkk > 1000000) issue = "Enter a valid fee in DKK per musician.";
    if (!dueOn) issue = "Enter a valid payment due date.";
    if (!["yes","no","true","false","cancelled"].includes(cancelledText)) issue = "Cancelled must be Yes or No.";
    if (id && (!/^[a-f0-9-]{36}$/i.test(id) || seen.has(id))) issue = "Duplicate or invalid Booking ID. Keep the original row and clear the copied ID to create another booking.";
    if (id) seen.add(id);
    let booking = state.bookings.find(item => item.id === id);
    if (issue) {
      if (booking) booking.sourceError = issue;
      sheet.getRange(index+2,modern ? 28 : 14).setValue(issue);
      return;
    }
    const input = {date,act,contactEmail,expectedMembers,fee:Math.round(feeDkk*100),dueOn,cancelled};
    const sourceSignature = bookingSourceSignature(JSON.stringify(input),modern);
    if (!id) {
      id = Utilities.getUuid();
      sheet.getRange(index+2,modern ? 23 : 9).setValue(id);
      seen.add(id);
    }
    if (!booking) {
      booking = {...input,paymentType:"Bank transfer",id,version:1,members:[],sourceSignature,sourceVersion:1};
      state.bookings.push(booking);
    } else if (bookingSourceSignature(booking.sourceSignature,modern) !== sourceSignature) {
      if (booking.members.some(member => member.paymentId)) {
        booking.sourceError = "This booking has processed payments. Restore the input values and create a separate booking for any new performance.";
      } else {
        Object.assign(booking,input,{sourceSignature,sourceVersion:(booking.sourceVersion || 1)+1,version:booking.version+1,confirmedAt:undefined,confirmedBy:undefined,attendanceNote:undefined,sourceError:undefined});
        for (const member of booking.members) { member.contractId = undefined; member.attendance = undefined; }
        for (const invite of state.invites) if (invite.bookingId === id && !invite.signedAt) invite.revoked = true;
        for (const mail of state.bookingMail) if (mail.bookingId === id && mail.status === "pending") {
          mail.status = "superseded"; mail.error = "Booking changed. Use its current links.";
        }
      }
    } else { booking.sourceError = undefined; booking.sourceSignature = sourceSignature; }
    if (booking.sourceError) { sheet.getRange(index+2,modern ? 28 : 14).setValue(booking.sourceError); return; }
    if (modern) {
      booking.operations = {ticketPrice:sourceRow[3],entranceIncome:sourceRow[4],guestCount:sourceRow[7],booker:sourceRow[11],infoSent:sourceRow[12],prReceived:sourceRow[13],facebook:sourceRow[14],website:sourceRow[15],winterJazz:sourceRow[16],instagram:sourceRow[17]};
    }
    const url = "https://dmf-eta.vercel.app/b/"+bookingHmac("stagebook-booking:"+id,props);
    const contactUrl = bookingContactUrl(booking,props);
    const mailId = "invitation:"+id+":"+(booking.sourceVersion || 1);
    if (!cancelled && date >= Utilities.formatDate(new Date(),"Europe/Copenhagen","yyyy-MM-dd") && !state.bookingMail.some(mail=>mail.id===mailId)) {
      state.bookingMail.push({id:mailId,bookingId:id,sourceVersion:booking.sourceVersion || 1,to:contactEmail,kind:"invitation",status:"pending",createdAt:new Date().toISOString(),
        subject:"Booking details needed · "+act+" · "+date,
        body:"You are booked at "+state.venue.name+" on "+date+".\n\nComplete the schedule, lineup and fee using your private band contact link:\n"+contactUrl+
          "\n\nForward this musician registration link to EVERY performing musician, and submit your own details too if you are playing:\n"+url+
          "\n\nEach musician can register directly before playing. The venue will approve the agreement and send individual contracts.\n\nQuestions: "+state.venue.email});
    }
    const methods = Array.from(new Set(booking.members.map(member => member.paymentType || booking.paymentType)));
    sheet.getRange(index+2,modern ? 20 : 6).setValue(methods.length > 1 ? "Mixed" : methods[0] || "");
    for (const mail of state.bookingMail) if (mail.bookingId===id && mail.status!=="sent" && !currentBookingMail(mail,booking)) mail.status="superseded";
    const status = booking.cancelled ? "Cancelled" : booking.confirmedAt ? "Performance confirmed" : booking.approvedVersion===booking.version ? "Company signed" : booking.members.length===booking.expectedMembers && booking.performance ? "Ready for approval" : "Collecting details";
    sheet.getRange(index+2,modern ? 24 : 10,1,5).setValues([[status,url,booking.members.length+" / "+booking.expectedMembers,
      bookingEmailStatus(state,booking),booking.sourceError || ""]]);
  });
  if (modern) refreshBookingProjection(book,state);
  for (const booking of state.bookings) if (!seen.has(booking.id)) {
    booking.sourceError = "The booking row is missing. Restore it in the sheet, or restore it and set Cancelled to Yes.";
  }
}
function writeBookingState(book,state) {
  state.revision++;
  writeWorkbook(book,state);
}
function bookingContactUrl(booking,props) {
  return "https://dmf-eta.vercel.app/b/"+bookingHmac("stagebook-booking:contact:"+booking.id+":"+(booking.sourceVersion || 1),props);
}
function queueBookingReminders(state,props) {
  const now = new Date();
  const day = Utilities.formatDate(now,"Europe/Copenhagen","yyyy-MM-dd");
  state.bookingMail = state.bookingMail || [];
  for (const booking of state.bookings || []) {
    if (booking.cancelled || booking.sourceError || Date.parse(booking.date+"T12:00:00Z") - now.getTime() > 7*86400000) continue;
    if (booking.approvedVersion !== booking.version) {
      if (booking.date < day) continue;
      if (booking.members.length===booking.expectedMembers && booking.performance) continue;
      const previous = state.bookingMail.filter(m=>m.bookingId===booking.id && ["invitation","reminder"].includes(m.kind) && !m.memberId).pop();
      if (previous && (previous.status!=="sent" || now.getTime()-Date.parse(previous.sentAt || previous.createdAt)<86400000)) continue;
      const id = "reminder:"+booking.id+":"+day;
      if (state.bookingMail.some(m=>m.id===id)) continue;
      state.bookingMail.push({id,bookingId:booking.id,to:booking.contactEmail,kind:"reminder",status:"pending",createdAt:now.toISOString(),
        subject:"Registration reminder · "+booking.act+" · "+booking.date,
        body:"Every performing musician must register before playing. "+booking.members.length+" of "+booking.expectedMembers+" are registered. Share the musician link:\nhttps://dmf-eta.vercel.app/b/"+bookingHmac("stagebook-booking:"+booking.id,props)+"\n\nComplete the schedule using your private link:\n"+bookingContactUrl(booking,props)});
    } else {
      for (const member of booking.members) {
        const invite = state.invites.find(i=>i.id===member.contractId && !i.revoked && !i.signedAt);
        if (!invite || invite.offer.returnBy < day) continue;
        const previous = state.bookingMail.filter(m=>m.bookingId===booking.id && m.memberId===member.id).pop();
        if (previous && (previous.status!=="sent" || now.getTime()-Date.parse(previous.sentAt || previous.createdAt)<86400000)) continue;
        const id = "sign-reminder:"+invite.id+":"+day;
        if (state.bookingMail.some(m=>m.id===id)) continue;
        state.bookingMail.push({id,bookingId:booking.id,memberId:member.id,to:member.email,kind:"reminder",status:"pending",createdAt:now.toISOString(),
          subject:"Please sign your contract · "+booking.act+" · "+booking.date,
          body:"Please review and sign your agreement by "+invite.offer.returnBy+".\n\nhttps://dmf-eta.vercel.app/register/"+bookingHmac("stagebook-booking-contract:"+invite.id,props)});
      }
    }
  }
}
function processBookingMail(book,state,props) {
  const delivery = {sent:0,failed:0};
  const completed = [];
  let quota;
  try { quota = MailApp.getRemainingDailyQuota(); }
  catch (error) { quota = 0; }
  for (const mail of state.bookingMail || []) {
    const currentBooking = (state.bookings || []).find(b=>b.id===mail.bookingId);
    if (currentBooking && mail.status!=="sent" && !currentBookingMail(mail,currentBooking)) mail.status="superseded";
    if (mail.status!=="pending") continue;
    // Let a sheet row settle before sending its first invitation while it is being entered.
    if (mail.kind==="invitation" && Date.now()-Date.parse(mail.createdAt)<60000) continue;
    const booking = (state.bookings || []).find(b=>b.id===mail.bookingId);
    if (!booking || booking.cancelled || booking.sourceError) { mail.status="failed"; mail.error="Booking is cancelled or needs attention."; delivery.failed++; continue; }
    if (mail.sourceVersion && mail.sourceVersion !== (booking.sourceVersion || 1)) { mail.status="superseded"; mail.error="Booking changed. Use its current invitation."; continue; }
    const day = Utilities.formatDate(new Date(),"Europe/Copenhagen","yyyy-MM-dd");
    if (mail.kind==="reminder" && mail.memberId) {
      const member = booking.members.find(m=>m.id===mail.memberId);
      const invite = member && state.invites.find(i=>i.id===member.contractId && !i.revoked && !i.signedAt && i.bookingVersion===booking.version);
      if (!invite || (invite.offer && invite.offer.returnBy < day)) { mail.status="superseded"; mail.error="Signature no longer needed."; continue; }
    }
    if (mail.kind==="contract") {
      const invite = state.invites.find(i=>i.id===mail.id.slice(9));
      if (!invite || invite.revoked || invite.signedAt || invite.bookingVersion!==booking.version || (invite.offer && invite.offer.returnBy < day)) { mail.status="superseded"; mail.error="Agreement is no longer awaiting signature."; continue; }
    }
    if (mail.kind==="verification" && Date.now()-Date.parse(mail.createdAt)>30*60000) { mail.status="failed"; mail.error="Verification expired. Request a new link."; delivery.failed++; continue; }
    const key="stagebook-booking-mail:"+mail.id;
    const reserved=props.getProperty(key);
    if (reserved && reserved!=="sending") {
      mail.status="sent"; mail.sentAt=reserved; completed.push(key); delivery.sent++; continue;
    }
    if (reserved) { mail.status="uncertain"; mail.error="Google did not confirm sending. Copy the link to share manually."; delivery.failed++; continue; }
    if (quota<1) { mail.error="Email quota or permission unavailable. Automatic delivery will retry."; delivery.failed++; continue; }
    props.setProperty(key,"sending");
    try {
      MailApp.sendEmail({to:mail.to,replyTo:state.venue.email,name:state.venue.name,subject:mail.subject,body:mail.body});
      mail.status="sent"; mail.sentAt=new Date().toISOString(); mail.error=undefined; quota--; delivery.sent++;
      props.setProperty(key,mail.sentAt); completed.push(key);
      if (mail.kind==="contract") {
        const invite=state.invites.find(i=>i.id===mail.id.slice(9));
        if (invite) invite.emailSentAt=mail.sentAt;
      }
    } catch (error) {
      const code=contractEmailError(error);
      mail.status=code==="MAIL_UNCERTAIN" ? "uncertain" : "failed";
      mail.error=code; delivery.failed++;
      if (code!=="MAIL_UNCERTAIN") props.deleteProperty(key);
    }
  }
  writeBookingState(book,state);
  for (const key of completed) props.deleteProperty(key);
  return {ok:true,state,delivery};
}

function currentBookingMail(mail,booking) {
  return mail.status!=="superseded" &&
    (!mail.sourceVersion || mail.sourceVersion===(booking.sourceVersion || 1)) &&
    !/^(Booking changed\.|Signature no longer needed\.|Agreement is no longer awaiting signature\.)/.test(mail.error || "");
}
function bookingEmailStatus(state,booking) {
  if (booking.cancelled) return "Cancelled";
  const emails=(state.bookingMail || []).filter(mail=>mail.bookingId===booking.id && mail.kind!=="verification" && currentBookingMail(mail,booking));
  if (emails.some(mail=>["failed","uncertain"].includes(mail.status))) return "Needs attention";
  if (emails.some(mail=>mail.status==="pending")) return "Queued";
  return emails.length ? "Sent" : "No email pending";
}
function refreshBookingEmailStatuses(book,state) {
  const sheet=book.getSheetByName("Bookings");
  if (!sheet || sheet.getLastRow()<2) return;
  const modern=modernBookingSheet(sheet);
  const ids=sheet.getRange(2,modern ? 23 : 9,sheet.getLastRow()-1,1).getValues();
  const values=ids.map(row=>{
    const booking=(state.bookings || []).find(item=>item.id===String(row[0]));
    return [booking ? bookingEmailStatus(state,booking) : ""];
  });
  sheet.getRange(2,modern ? 27 : 13,values.length,1).setValues(values);
}

function refreshBookingProjection(book,state) {
  const sheet=book.getSheetByName("Bookings");
  if (!sheet || !modernBookingSheet(sheet) || sheet.getLastRow()<2) return;
  const rows=sheet.getRange(2,1,sheet.getLastRow()-1,28).getValues();
  rows.forEach((row,index)=>{
    const booking=(state.bookings || []).find(b=>b.id===String(row[22]));
    if (!booking) return;
    const paid=booking.members.length===booking.expectedMembers && booking.members.length>0 && booking.members.every(m=>m.paymentId && (state.payments || []).some(p=>p.id===m.paymentId && !p.voidReason));
    const total=booking.fee ? booking.fee*booking.expectedMembers/100 : "";
    const entrance=row[4]==="" ? null : Number(row[4]);
    const ratio=entrance!==null && Number.isFinite(entrance) && total>0 ? entrance/total : "";
    const contact=(state.musicians || []).find(m=>m.email.toLowerCase()===booking.contactEmail.toLowerCase() && booking.members.some(member=>member.musicianId===m.id));
    sheet.getRange(index+2,2).setValue(paid);
    sheet.getRange(index+2,6,1,2).setValues([[total,booking.performance ? booking.expectedMembers : ""]]);
    sheet.getRange(index+2,9).setValue(ratio);
    sheet.getRange(index+2,11).setValue(contact?.phone ? String(contact.phone) : "");
  });
}
