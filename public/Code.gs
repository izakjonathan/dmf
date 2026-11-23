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
      return respond({ok:false,error:"BUSY"});
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
      const checkedBookings = request.sheetBookingIds || (request.sheetBookingId ? [request.sheetBookingId] : []);
      if (checkedBookings.some(id=>!sheetBookingMatches(book,request.state,id)))
        return respond({ok:false,error:"BOOKING_SOURCE_CHANGED"});
      step = "saving the workbook";
      const previous = readStoredState(book);
      const audit = bookingAuditChanges(previous, request.state, request.actor === "staff");
      if (props.getProperty("SENSITIVE_MIGRATED")==="true") persistSensitive(request.state,props,false);
      writeWorkbook(book, request.state, audit);
      return respond({ok:true,state:request.state});
    }
    const length = storage.getLastRow();
    const encoded = length > 1 ? storage.getRange(2,1,length-1,1).getValues().map(row=>row[0]).join("") : "";
    const state = encoded ? JSON.parse(Utilities.newBlob(Utilities.base64Decode(encoded)).getDataAsString("UTF-8")) : null;
    if (request.action === "createBooking" || request.action === "ticketSales") {
      step = "updating a booking row";
      if (!state?.auth) return respond({ok:false});
      const sheet = ensureBookingSheet(book);
      if (!modernBookingSheet(sheet)) return respond({ok:false,error:"BOOKING_INPUT",message:"Upgrade the Bookings tab before using this action."});
      ensureBookingWorkflowColumns(sheet);
      if (request.action === "createBooking") appendStagebookBooking(book,sheet,request.booking);
      else {
        if (!sheetBookingMatches(book,state,request.id))
          return respond({ok:false,error:"BOOKING_SOURCE_CHANGED"});
        const booking = state.bookings.find(item=>item.id===request.id);
        if (booking.cancelled || !Number.isInteger(request.sold) || request.sold<0 || request.sold>1000000 ||
            booking.date > Utilities.formatDate(new Date(),"Europe/Copenhagen","yyyy-MM-dd"))
          return respond({ok:false,error:"BOOKING_INPUT",message:"Enter a whole number of tickets sold on or after the show date."});
        const ids = sheet.getRange(2,23,sheet.getLastRow()-1,1).getValues();
        sheet.getRange(ids.findIndex(row=>row[0]===request.id)+2,32).setValue(request.sold);
      }
      SpreadsheetApp.flush();
      syncAndQueueBookingMail(book,state,props);
      return respond({ok:true,state});
    }
    if (request.action === "sheetBookingReview") {
      if (!state?.auth || !sheetBookingMatches(book,state,request.id))
        return respond({ok:false,error:"BOOKING_SOURCE_CHANGED"});
      return respond({ok:true,state});
    }
    if (request.action === "syncBookings" || request.action === "bookingMail") {
      if (!state?.auth) return respond({ok:false});
      if (request.action === "syncBookings") {
        syncAndQueueBookingMail(book,state,props);
      }
      const result = processBookingMail(book,state,props);
      refreshBookingEmailStatuses(book,state);
      return respond(result);
    }
    if (request.action === "emailContracts") {
      step = "sending contract emails";
      return respond(emailContracts(book, state, request.links, props));
    }
    if (request.action === "health") {
      let quota = null;
      try { quota = MailApp.getRemainingDailyQuota(); } catch (error) { console.warn("Stagebook mail quota unavailable."); }
      let handlers = [];
      try { handlers = ScriptApp.getProjectTriggers().map(trigger=>trigger.getHandlerFunction()); } catch (error) { console.warn("Stagebook triggers unavailable."); }
      return respond({ok:true,version:"booking-privacy-2",quota,scheduled:handlers.includes("runBookingAutomation"),onEdit:handlers.includes("bookingSheetEdited")});
    }
    if (request.action === "sensitiveView" && state?.auth) return respond(sensitiveView(book,state,request,props));
    if (request.action === "auditView" && state?.auth) {
      Sheets.Spreadsheets.batchUpdate({requests:[auditAppend(book,[
        auditRow("Full record viewed", request.viewer, request.bookingId, request.musicianId)
      ])]},book.getId());
      return respond({ok:true});
    }
    if (request.action === "metadata") return respond({ok:true,initialized:Boolean(state?.auth)});
    if (request.action === "read") return respond({ok:true,state:state});
    return respond({ok:false});
  } catch (error) {
    console.error("Stagebook failed while " + step + ".");
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
  let pdf;
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
    const attach = offer.conditionsVersion === DMF_CONDITIONS_VERSION;
    if (attach && !pdf) {
      try { pdf = originalDmfAttachment(); }
      catch (_) { failure("MAIL_ATTACHMENT"); continue; }
    }
    props.setProperty(key, "sending");
    try {
      MailApp.sendEmail({
        to: offer.performerEmail,
        replyTo: offer.organizer.email,
        name: offer.organizer.name,
        subject: "DMF contract to sign · " + offer.performanceDate,
        ...(attach ? {attachments:[pdf]} : {}),
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
const DMF_CONDITIONS_VERSION = "dmf-red-2019-en-1";
function originalDmfAttachment() {
  const url = "https://dmf-eta.vercel.app/legal/DMF_Standardkontrakt.pdf";
  const response = UrlFetchApp.fetch(url,{followRedirects:false,muteHttpExceptions:true});
  if (response.getResponseCode()!==200) throw Error("DMF PDF unavailable.");
  const blob = response.getBlob();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,blob.getBytes())
    .map(value=>((value+256)%256).toString(16).padStart(2,"0")).join("");
  if (digest!=="ce401558fa30f68634b5dc7a19e49e22b88a682a4bc96bdae5547a191774a64d")
    throw Error("DMF PDF could not be verified.");
  return blob.setContentType("application/pdf").setName("DMF_Standardkontrakt.pdf");
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
function normalizeBand(name) { return String(name || "").trim().replace(/\s+/g," ").toLowerCase(); }
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
    const contract = (state.contracts || []).find(c=>c.id===m.contractId && c.bookingVersion===b.version);
    const payment = (state.payments || []).find(p=>p.id===m.paymentId && !p.voidReason);
    const status = pendingReason(state,b,m);
    bookingPayments.push([b.id,b.date,b.act,m.name,m.email,(payment?.amount ?? contract?.offer.fee ?? b.fee)/100,
      payment?.paymentType || contract?.offer.paymentType || m.paymentType || b.paymentType,b.dueOn,status,payment?.id || ""]);
  }
  for (const b of state.bookings || []) if (!b.cancelled && b.performance) {
    for (let i=b.members.length; i<b.expectedMembers; i++)
      bookingPayments.push([b.id,b.date,b.act,"Unregistered musician","",b.fee ? b.fee/100 : "","",b.dueOn,
        b.sourceError ? "Booking sheet needs attention" : "Registration needed",""]);
  }
  for (const mail of state.bookingMail || []) bookingEmails.push([mail.bookingId,mail.kind==="verification" ? "" : mail.to,mail.kind,mail.status,mail.sentAt || "",mail.error || ""]);
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
function writeWorkbook(book,state,audit = [],extraRequests = []) {
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
  if (audit.length) requests.push(auditAppend(book,audit));
  requests.push(...extraRequests);
  Sheets.Spreadsheets.batchUpdate({requests},book.getId());
  const bookingSheet=book.getSheetByName("Bookings");
  if ((state.bookings || []).length && bookingSheet && bookingSheet.getRange("A1").getValue()==="Dato") {
    try { refreshBookingProjection(book,state); }
    catch (error) { console.warn("Booking projection will be retried."); }
  }
}


function onOpen() {
  SpreadsheetApp.getUi().createMenu("Stagebook")
    .addItem("Open selected booking", "openSelectedBooking")
    .addItem("Confirm performance", "confirmSelectedPerformance")
    .addItem("Review and sign contracts", "reviewAndSendBookingContracts")
    .addItem("Open payment queue", "openSelectedBookingPayments")
    .addItem("Record processed payment", "recordSelectedBookingPayment")
    .addToUi();
}

function selectedStagebookBooking() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const range = book.getActiveRange();
  const sheet = range?.getSheet();
  const props = PropertiesService.getScriptProperties();
  if (book.getId() !== props.getProperty("SPREADSHEET_ID") || !sheet ||
      sheet.getName() !== "Bookings" || range.getRow() < 2 || range.getNumRows() !== 1)
    throw Error("Select a single synced row in the Stagebook Bookings tab.");
  const id = String(sheet.getRange(range.getRow(),modernBookingSheet(sheet) ? 23 : 9).getValue()).trim();
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error("The row has not synced yet. Check its Issue column.");
  return {book,props,id};
}

function openSelectedBooking() { openSelectedBookingPage("booking"); }
function openSelectedBookingPayments() { openSelectedBookingPage("bookingPayments"); }
function openSelectedBookingPage(page) {
  const ui = SpreadsheetApp.getUi();
  try {
    const selected = selectedStagebookBooking();
    const url = "https://dmf-eta.vercel.app/?"+page+"="+selected.id;
    ui.showModalDialog(HtmlService.createHtmlOutput('<p><a target="_blank" rel="noopener" href="'+url+'">Open in Stagebook</a></p>').setWidth(320).setHeight(80),"Stagebook booking");
  } catch (error) { ui.alert("Stagebook",error.message,ui.ButtonSet.OK); }
}

function recordSelectedBookingPayment() {
  const ui = SpreadsheetApp.getUi();
  try {
    const {book,props,id} = selectedStagebookBooking();
    const owner = book.getOwner()?.getEmail();
    if (!owner || Session.getActiveUser().getEmail().toLowerCase() !== owner.toLowerCase())
      throw Error("Only the workbook owner can record processed payments here.");
    const details = requestSheetApproval({action:"paymentsReview",id},props);
    const answer = ui.prompt("Record payments already made",
      details.act+" · "+details.date+"\n\n"+details.ready.map((item,i)=>
        (i+1)+". "+item.name+" · "+(item.fee/100).toFixed(2)+" DKK · "+item.method).join("\n")+
      "\n\nEnter musician number (or all), actual payment date and your full name, separated by commas. Example: 1, "+details.today+", Your Name",
      ui.ButtonSet.OK_CANCEL);
    if (answer.getSelectedButton() !== ui.Button.OK) return;
    const [selection,paidOn,...name] = answer.getResponseText().split(",").map(value=>value.trim());
    const result = requestSheetApproval({action:"recordPayment",id,review:details.review,
      signer:name.join(", ").trim(),selection:selection.toLowerCase(),paidOn,accepted:true},props);
    ui.alert("Stagebook",result.message,ui.ButtonSet.OK);
  } catch (error) { ui.alert("Stagebook",error.message,ui.ButtonSet.OK); }
}

function confirmSelectedPerformance() {
  const ui = SpreadsheetApp.getUi();
  try {
    const selected = selectedStagebookBooking();
    const owner = selected.book.getOwner()?.getEmail();
    if (!owner || Session.getActiveUser().getEmail().toLowerCase() !== owner.toLowerCase())
      throw Error("Open the booking in Stagebook to record attendance with your staff access.");
    const details = requestSheetApproval({action:"attendanceReview",id:selected.id},selected.props);
    const answer = ui.prompt("Confirm performance",
      details.act+" · "+details.date+"\n\n"+details.members.join("\n")+
      "\n\nEnter your full name to confirm that everyone listed performed as agreed. Use the booking page to record any exception.",
      ui.ButtonSet.OK_CANCEL);
    if (answer.getSelectedButton() !== ui.Button.OK) return;
    const result = requestSheetApproval({action:"attendance",id:selected.id,review:details.review,
      signer:answer.getResponseText().trim(),accepted:true},selected.props);
    ui.alert("Stagebook",result.message,ui.ButtonSet.OK);
  } catch (error) { ui.alert("Stagebook",error.message,ui.ButtonSet.OK); }
}

function reviewAndSendBookingContracts() {
  const ui = SpreadsheetApp.getUi();
  try {
    const {book,props,id} = selectedStagebookBooking();
    const owner = book.getOwner()?.getEmail();
    if (!owner || Session.getActiveUser().getEmail().toLowerCase() !== owner.toLowerCase())
      throw Error("Only the owner of this workbook can sign on behalf of the venue.");
    const details = requestSheetApproval({action:"review",id},props);
    const p = details.performance;
    const musicians = details.members.map(m=>m.name+" <"+m.email+"> · "+m.method).join("\n");
    const terms = details.act+" · "+details.date+" · "+p.start+"–"+p.end+
      "\nVenue: "+details.organizer.legalName+" (CVR "+details.organizer.cvr+")"+
      "\nSchedule: "+p.sets+" × "+p.minutesPerSet+" min · Soundcheck: "+p.soundcheck+
      (p.requests ? "\nRequests: "+p.requests : "")+
      "\nFee: "+(details.fee/100).toFixed(2)+" DKK per musician"+
      "\nPayment due: "+details.dueOn+" · Signing deadline: "+details.returnBy+
      "\n\n"+musicians+"\n\nDMF contract: "+details.template.url+
      (details.countersign
        ? "\n\nEnter your full name and choose OK to countersign these terms for the venue and email each musician a signed copy."
        : "\n\nEnter your full name and choose OK to sign for the venue and email each artist a signing request.");
    const answer = ui.prompt("Confirm, sign and send contracts",terms,ui.ButtonSet.OK_CANCEL);
    if (answer.getSelectedButton() !== ui.Button.OK) return;
    const signer = answer.getResponseText().trim();
    if (signer.length < 2 || signer.length > 300) throw Error("Enter the venue signer’s full name.");
    const result = requestSheetApproval({action:"sign",id,review:details.review,signer,accepted:true},props);
    ui.alert("Stagebook",result.message,ui.ButtonSet.OK);
  } catch (error) {
    ui.alert("Stagebook",error.message,ui.ButtonSet.OK);
  }
}

function requestSheetApproval(data,props) {
  const body = JSON.stringify({...data,timestamp:Date.now()}).replace(/[^\x00-\x7f]/g,
    character=>"\\u"+character.charCodeAt(0).toString(16).padStart(4,"0"));
  const response = UrlFetchApp.fetch("https://dmf-eta.vercel.app/api/sheet-approval",{
    method:"post",contentType:"application/json",payload:body,muteHttpExceptions:true,
    headers:{"X-Stagebook-Signature":bookingHmac("stagebook-sheet-approval:"+body,props)}
  });
  let result;
  try { result = JSON.parse(response.getContentText()); }
  catch (error) { throw Error("Stagebook could not confirm the request. Open the booking to check its status."); }
  if (response.getResponseCode() !== 200) throw Error(result.error || "Stagebook could not confirm the request.");
  return result;
}

function bookingInput(row,zone,previous,modern) {
  const date = bookingDate(row[0],zone);
  return {
    date,act:String(row[1] || "").trim(),contactEmail:String(row[2] || "").trim().toLowerCase(),
    expectedMembers:modern && previous ? previous.expectedMembers : modern && (row[3]==="" || row[3]===undefined) ? 1 : Number(row[3]),
    fee:Math.round(Number(row[4] || 0)*100),
    dueOn:row[6]==="" ? date && nextBookingWeekday(date) : bookingDate(row[6],zone),
    cancelled:["yes","true","cancelled"].includes(String(row[7] || "No").trim().toLowerCase())
  };
}

function bookingInputRow(row,modern) {
  return modern ? [row[0],row[2],row[9],row[6],row[18],row[19],row[20],row[21],row[22]] : row;
}

function sheetBookingMatches(book,state,id) {
  const booking = state.bookings?.find(item=>item.id===id);
  const sheet = book.getSheetByName("Bookings");
  if (!booking?.sourceSignature || booking.retentionArchived || booking.sourceError || !sheet || sheet.getLastRow()<2) return false;
  const modern = modernBookingSheet(sheet);
  const headers = modern ? BOOKING_OPERATIONS_HEADERS : BOOKING_HEADERS;
  const actual = sheet.getRange(1,1,1,headers.length).getValues()[0];
  if (actual.length!==headers.length || !actual.every((value,i)=>value===headers[i])) return false;
  const rows = sheet.getRange(2,1,sheet.getLastRow()-1,headers.length).getValues()
    .map(row=>bookingInputRow(row,modern)).filter(row=>String(row[8] || "").trim()===id);
  if (rows.length!==1 || !["yes","no","true","false","cancelled"].includes(String(rows[0][7] || "No").trim().toLowerCase())) return false;
  const signature = bookingSourceSignature(JSON.stringify(bookingInput(rows[0],book.getSpreadsheetTimeZone(),booking,modern)),modern);
  return signature===bookingSourceSignature(booking.sourceSignature,modern);
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
const BOOKING_WORKFLOW_HEADERS = ["Contact name","Contact phone","Tickets sold","Ticket revenue","Fees covered by tickets","Contact registration link","Stagebook booking","Starts","Sets","Minutes per set","Performance confirmation","Act bio","Press photo","Artist website"];

function bookingWorkflowEnabled(sheet) {
  return typeof sheet.getMaxColumns === "function" && sheet.getMaxColumns() >= 30 &&
    sheet.getRange("AD1").getValue() === BOOKING_WORKFLOW_HEADERS[0];
}

function ensureBookingWorkflowColumns(sheet) {
  if (typeof sheet.getMaxColumns !== "function" || typeof sheet.getSheetId !== "function") return;
  const last = 29 + BOOKING_WORKFLOW_HEADERS.length;
  if (sheet.getMaxColumns() < last)
    sheet.insertColumnsAfter(sheet.getMaxColumns(),last-sheet.getMaxColumns());
  const range = sheet.getRange(1,30,1,BOOKING_WORKFLOW_HEADERS.length);
  const old = range.getValues()[0];
  if (BOOKING_WORKFLOW_HEADERS.every((header,i)=>old[i]===header)) return;
  const dataRows = sheet.getLastRow() - 1;
  if (old.some(value=>value!=="" && value!==undefined) ||
      (dataRows > 0 && !sheet.getRange(2,30,dataRows,BOOKING_WORKFLOW_HEADERS.length).isBlank()))
    throw Error("Columns AD:AQ have existing headers. Preserve them before enabling the new workflow.");
  range.setValues([BOOKING_WORKFLOW_HEADERS]).setFontWeight("bold");
  sheet.getRange("AE:AE").setNumberFormat("@");
  sheet.getRange("AG:AG").setNumberFormat('#,##0.00 "kr."');
  sheet.getRange("AH:AH").setNumberFormat("0.00%");
  sheet.getRange("AD1").setNote("Venue input. Enter the booking contact’s name.");
  sheet.getRange("AE1").setNote("Venue input. Optional booking contact phone, stored as text.");
  sheet.getRange("AF1").setNote("Venue input after the performance. Enter total tickets sold, including zero if none.");
  sheet.getRange("X1").setNote("Contract status. Select a booking row and open the Stagebook menu to review its next step.");
}

function appendStagebookBooking(book,sheet,data) {
  const id = data.requestId;
  const last = sheet.getLastRow();
  if (last>1 && sheet.getRange(2,23,last-1,1).getValues().some(row=>row[0]===id)) return;
  const row = Array(29 + BOOKING_WORKFLOW_HEADERS.length).fill("");
  const value = sheetValue(data.date,DATE_FORMAT,book.getSpreadsheetTimeZone());
  row[0] = value.numberValue; row[2] = data.act; row[3] = data.ticketPrice/100;
  row[9] = data.contactEmail; row[11] = data.booker; row[18] = data.fee/100;
  row[22] = id; row[29] = data.contactName; row[30] = data.contactPhone || "";
  const index = last+1;
  if (index>sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),index-sheet.getMaxRows());
  sheet.getRange(index,1,1,row.length).setValues([row]);
  sheet.getRange(index,1).setNumberFormat("dd/mm/yyyy");
}

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
  sheet.getRange("G1").setNote("Updated from the lineup supplied by the artist.");
  sheet.getRange("X1").setNote("Contract status. Select a booking row and choose Stagebook → Review, sign and send contracts.");
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
  if (modernBookingSheet(sheet)) {
    ensureBookingWorkflowColumns(sheet);
    return sheet;
  }
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
    syncAndQueueBookingMail(book,state,props);
    processBookingMail(book,state,props);
    refreshBookingEmailStatuses(book,state);
  } catch (error) {
    console.error("Stagebook booking automation failed.");
    throw Error("Stagebook booking automation failed.");
  } finally { lock.releaseLock(); }
}
function syncAndQueueBookingMail(book,state,props) {
  const before = JSON.stringify([state.bookings,state.bookingMail]);
  const known = new Set((state.bookings || []).map(booking=>booking.id));
  syncBookingRows(book,state,props,true);
  queueBookingReminders(state,props);
  if (before!==JSON.stringify([state.bookings,state.bookingMail])) {
    const audit = (state.bookings || []).filter(b=>!known.has(b.id))
      .map(b=>auditRow("Booking created","admin",b.id));
    writeBookingState(book,state,audit);
  }
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
function syncBookingRows(book,state,props,requireCurrentLayout = false) {
  const sheet = ensureBookingSheet(book);
  const modern = modernBookingSheet(sheet);
  state.bookings = state.bookings || [];
  state.bookingMail = state.bookingMail || [];
  const length = sheet.getLastRow();
  const workflow = modern && bookingWorkflowEnabled(sheet);
  const rows = length < 2 ? [] : sheet.getRange(2,1,length-1,workflow ? 29+BOOKING_WORKFLOW_HEADERS.length : modern ? 28 : BOOKING_HEADERS.length).getValues();
  const zone = book.getSpreadsheetTimeZone();
  const seen = new Set();
  const occurrences = new Map();
  for (const row of rows) {
    const id = String(bookingInputRow(row,modern)[8] || "").trim();
    if (id) occurrences.set(id,(occurrences.get(id) || 0)+1);
  }
  rows.forEach((sourceRow,index) => {
    const row = bookingInputRow(sourceRow,modern);
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
    if (workflow && (!previous || previous.artistFirst) && !cancelled) {
      if (!String(sourceRow[29] || "").trim() || !String(sourceRow[11] || "").trim())
        issue = "Enter the contact name and responsible booker.";
      if (typeof sourceRow[3] !== "number" || !Number.isFinite(sourceRow[3]) || sourceRow[3] < 0)
        issue = "Enter a ticket price in DKK (0 for free entry).";
      if (feeDkk <= 0) issue = "Enter the agreed fee per musician in DKK.";
    }
    if (!["yes","no","true","false","cancelled"].includes(cancelledText)) issue = "Cancelled must be Yes or No.";
    if (id && (!/^[a-f0-9-]{36}$/i.test(id) || occurrences.get(id)>1)) issue = "Duplicate or invalid Booking ID. Keep the original row and clear the copied ID to create another booking.";
    if (!previous && requireCurrentLayout && !workflow) issue = "Upgrade the Bookings tab before adding new acts.";
    if (id) seen.add(id);
    if (previous?.retentionArchived) return;
    let booking = state.bookings.find(item => item.id === id);
    const feeChanged = !booking || booking.fee !== Math.round(feeDkk*100);
    if (issue) {
      if (booking) booking.sourceError = issue;
      sheet.getRange(index+2,modern ? 28 : 14).setValue(issue);
      sheet.getRange(index+2,modern ? 24 : 10).setValue("Booking sheet needs attention");
      return;
    }
    const input = bookingInput(row,zone,previous,modern);
    const sourceSignature = bookingSourceSignature(JSON.stringify(input),modern);
    if (!id) {
      id = Utilities.getUuid();
      sheet.getRange(index+2,modern ? 23 : 9).setValue(id);
      seen.add(id);
    }
    if (!booking) {
      booking = {...input,paymentType:"Bank transfer",id,version:1,members:[],sourceSignature,sourceVersion:1};
      if (workflow || requireCurrentLayout) booking.artistFirst = true;
      state.bookings.push(booking);
    } else if (bookingSourceSignature(booking.sourceSignature,modern) !== sourceSignature) {
      if (booking.members.some(member => member.paymentId)) {
        booking.sourceError = "This booking has processed payments. Restore the input values and create a separate booking for any new performance.";
      } else {
        const attendanceChanged = booking.date!==input.date || booking.act!==input.act || booking.cancelled!==input.cancelled;
        Object.assign(booking,input,{sourceSignature,sourceVersion:(booking.sourceVersion || 1)+1,version:booking.version+1,sourceError:undefined});
        if (attendanceChanged) Object.assign(booking,{confirmedAt:undefined,confirmedBy:undefined,attendanceNote:undefined});
        for (const member of booking.members) {
          member.contractId = undefined;
          member.exceptionResolution = undefined;
          if (attendanceChanged) member.attendance = undefined;
        }
        for (const invite of state.invites) if (invite.bookingId === id && !invite.signedAt) invite.revoked = true;
        for (const mail of state.bookingMail) if (mail.bookingId === id && mail.status === "pending") {
          mail.status = "superseded"; mail.error = "Booking changed. Use its current links.";
        }
      }
    } else { booking.sourceError = undefined; booking.sourceSignature = sourceSignature; }
    if (booking.sourceError) {
      sheet.getRange(index+2,modern ? 28 : 14).setValue(booking.sourceError);
      sheet.getRange(index+2,modern ? 24 : 10).setValue("Booking sheet needs attention");
      return;
    }
    if (modern) {
      booking.operations = {ticketPrice:sourceRow[3],entranceIncome:sourceRow[4],guestCount:sourceRow[7],booker:sourceRow[11],infoSent:sourceRow[12],prReceived:sourceRow[13],facebook:sourceRow[14],website:sourceRow[15],winterJazz:sourceRow[16],instagram:sourceRow[17]};
    }
    if (workflow) {
      booking.contactName = String(sourceRow[29] || "").trim();
      booking.contactPhone = String(sourceRow[30] || "").trim();
      const tickets = sourceRow[31];
      booking.operations.ticketsSold = Number.isInteger(tickets) && tickets>=0 ? tickets : undefined;
    }
    const url = "https://dmf-eta.vercel.app/b/"+bookingHmac("stagebook-booking:"+id,props);
    const contactUrl = bookingContactUrl(booking,props);
    const mailId = "invitation:"+id+":"+(booking.sourceVersion || 1);
    if (!cancelled && date >= Utilities.formatDate(new Date(),"Europe/Copenhagen","yyyy-MM-dd") && !state.bookingMail.some(mail=>mail.id===mailId)) {
      state.bookingMail.push({id:mailId,bookingId:id,sourceVersion:booking.sourceVersion || 1,to:contactEmail,kind:"invitation",status:"pending",createdAt:new Date().toISOString(),
        subject:"Booking details needed · "+act+" · "+date,
        body:(booking.contactName ? "Hi "+booking.contactName+",\n\n" : "")+
          "You are booked at "+state.venue.name+" on "+date+".\n\n"+
          (props.getProperty("BOOKING_VENUE_INTRO") ? props.getProperty("BOOKING_VENUE_INTRO")+"\n\n" : "")+
          (props.getProperty("BOOKING_EQUIPMENT") ? "Venue equipment:\n"+props.getProperty("BOOKING_EQUIPMENT")+"\n\n" : "")+
          "Complete the act details, schedule, lineup and promotion information using your private band contact link:\n"+contactUrl+
          "\n\nForward this musician registration link to EVERY performing musician, and submit your own details too if you are playing:\n"+url+
          "\n\nEach musician can register directly before playing. "+
          (booking.artistFirst ? "When registration is complete, each musician will receive a contract to sign." :
            "The venue will approve the agreement and send individual contracts.")+"\n\nQuestions: "+state.venue.email});
    }
    if (feeChanged) queueBookerTariffWarning(state,booking,props);
    const warning = tariffWarning(booking.date,booking.fee);
    if (workflow && typeof sheet.getSheetId === "function") sheet.getRange(index+2,19).setNote(warning);
    const methods = Array.from(new Set(booking.members.map(member => member.paymentType || booking.paymentType)));
    sheet.getRange(index+2,modern ? 20 : 6).setValue(methods.length > 1 ? "Mixed" : methods[0] || "");
    for (const mail of state.bookingMail) if (mail.bookingId===id && mail.status!=="sent" && !currentBookingMail(mail,booking)) mail.status="superseded";
    const status = sheetBookingContractStatus(state,booking);
    sheet.getRange(index+2,modern ? 24 : 10,1,5).setValues([[status,url,booking.performance ? booking.members.length+" / "+booking.expectedMembers : booking.members.length+" registered · lineup pending",
      bookingEmailStatus(state,booking),booking.sourceError || ""]]);
  });
  if (modern) {
    ensureBookingActionColumns(sheet);
    ensureBookingScheduleColumns(sheet);
    refreshBookingProjection(book,state);
  }
  for (const booking of state.bookings) if (!seen.has(booking.id)) {
    booking.sourceError = "The booking row is missing. Restore it in the sheet, or restore it and set Cancelled to Yes.";
  }
}
function writeBookingState(book,state,audit) {
  state.revision++;
  writeWorkbook(book,state,audit);
}
function sheetBookingContractStatus(state,b) {
  if (b.cancelled) return "Cancelled";
  if (b.sourceError) return "Booking sheet needs attention";
  if (b.artistFirst) {
    if (b.approvedVersion===b.version) return "All contracts signed";
    if (b.contractsVersion!==b.version) {
      if (!b.performance || b.members.length!==b.expectedMembers) return "Waiting for registrations";
      return b.fee ? "Contracts need issuing" : "Fee needed";
    }
    const signed=b.members.filter(m=>(state.contracts || []).some(c=>c.id===m.contractId && c.bookingVersion===b.version)).length;
    if (signed<b.expectedMembers) return signed+"/"+b.expectedMembers+" musicians signed";
    return !b.confirmedAt ? "Waiting for performance confirmation" :
      b.members.some(member=>member.attendance!=="played") ? "Performance exception needs review" : "Ready for venue signature";
  }
  if (b.approvedVersion!==b.version && b.performance && b.members.length===b.expectedMembers && !b.fee) return "Fee needed";
  if (b.approvedVersion!==b.version)
    return b.performance && b.members.length===b.expectedMembers ? "Ready for company signature" : "Waiting for booking details";
  const signed=b.members.filter(m=>(state.contracts || []).some(c=>c.id===m.contractId && c.bookingVersion===b.version)).length;
  return signed===b.expectedMembers ? "All contracts signed" : "Company signed · "+signed+"/"+b.expectedMembers+" artists signed";
}
function queueBookerTariffWarning(state,booking,props) {
  const to = String(props.getProperty("BOOKER_TARIFF_WARNING_EMAIL") || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || booking.cancelled || booking.date<today()) return;
  const warning = tariffWarning(booking.date, booking.fee);
  if (!warning) return;
  const id = "tariff:"+booking.id+":"+(booking.sourceVersion || 1);
  if (state.bookingMail.some(mail=>mail.id===id)) return;
  state.bookingMail.push({id,bookingId:booking.id,sourceVersion:booking.sourceVersion || 1,
    to,kind:"tariff",status:"pending",createdAt:new Date().toISOString(),
    subject:"DMF tariff reminder · "+booking.act+" · "+booking.date,
    body:warning+"\n\nOpen the booking in Stagebook:\nhttps://dmf-eta.vercel.app/?booking="+booking.id});
}
function bookingContactUrl(booking,props) {
  return "https://dmf-eta.vercel.app/b/"+bookingHmac("stagebook-booking:contact:"+booking.id+":"+(booking.sourceVersion || 1),props);
}
function queueBookingReminders(state,props) {
  const now = new Date();
  const day = Utilities.formatDate(now,"Europe/Copenhagen","yyyy-MM-dd");
  state.bookingMail = state.bookingMail || [];
  for (const booking of state.bookings || []) {
    if (booking.cancelled || booking.retentionArchived || booking.sourceError || Date.parse(booking.date+"T12:00:00Z") - now.getTime() > 7*86400000) continue;
    if (booking.approvedVersion !== booking.version && booking.contractsVersion !== booking.version) {
      if (booking.date < day) continue;
      if (booking.members.length===booking.expectedMembers && booking.performance) continue;
      const previous = state.bookingMail.filter(m=>m.bookingId===booking.id && ["invitation","reminder"].includes(m.kind) && !m.memberId && currentBookingMail(m,booking)).pop();
      if (previous && (previous.status!=="sent" || now.getTime()-Date.parse(previous.sentAt || previous.createdAt)<86400000)) continue;
      const id = "reminder:"+booking.id+":"+(booking.sourceVersion || 1)+":"+day;
      if (state.bookingMail.some(m=>m.id===id)) continue;
      state.bookingMail.push({id,bookingId:booking.id,sourceVersion:booking.sourceVersion || 1,to:booking.contactEmail,kind:"reminder",status:"pending",createdAt:now.toISOString(),
        subject:"Registration reminder · "+booking.act+" · "+booking.date,
        body:"Every performing musician must register before playing. "+booking.members.length+" of "+booking.expectedMembers+" are registered. Share the musician link:\nhttps://dmf-eta.vercel.app/b/"+bookingHmac("stagebook-booking:"+booking.id,props)+"\n\nComplete the schedule using your private link:\n"+bookingContactUrl(booking,props)});
    } else {
      for (const member of booking.members) {
        const invite = state.invites.find(i=>i.id===member.contractId && !i.revoked && !i.signedAt);
        if (!invite || invite.offer.returnBy < day) continue;
        const previous = state.bookingMail.filter(m=>m.bookingId===booking.id && m.memberId===member.id && ["contract","reminder"].includes(m.kind)).pop();
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
  const before = JSON.stringify(state.bookingMail);
  const delivery = {sent:0,failed:0};
  const completed = [];
  let pdf;
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
    if (mail.kind!=="receipt" && (!booking || booking.cancelled || booking.sourceError)) { mail.status="failed"; mail.error="Booking is cancelled or needs attention."; delivery.failed++; continue; }
    if (mail.sourceVersion && mail.sourceVersion !== (booking?.sourceVersion || 1)) { mail.status="superseded"; mail.error="Booking changed. Use its current invitation."; continue; }
    const day = Utilities.formatDate(new Date(),"Europe/Copenhagen","yyyy-MM-dd");
    if (["contract","approval","invitation","reminder","tariff"].includes(mail.kind) && booking.sourceSignature &&
        !sheetBookingMatches(book,state,booking.id)) {
      mail.error="Waiting for the current booking row to sync.";
      delivery.failed++;
      continue;
    }
    if (mail.kind==="reminder" && !mail.memberId &&
        (booking.date < day || (booking.performance && booking.members.length===booking.expectedMembers))) {
      mail.status="superseded"; mail.error="Booking changed. Registration reminder is no longer needed."; continue;
    }
    if (mail.kind==="approval" &&
        (booking.approvedVersion===booking.version || !booking.performance || booking.members.length!==booking.expectedMembers)) {
      mail.status="superseded"; mail.error="Booking changed. Approval reminder is no longer needed."; continue;
    }
    if (mail.kind==="reminder" && mail.memberId) {
      const member = booking.members.find(m=>m.id===mail.memberId);
      const invite = member && state.invites.find(i=>i.id===member.contractId && !i.revoked && !i.signedAt && i.bookingVersion===booking.version);
      if (!invite || (invite.offer && invite.offer.returnBy < day)) { mail.status="superseded"; mail.error="Signature no longer needed."; continue; }
    }
    if (mail.kind==="contract") {
      const invite = state.invites.find(i=>i.id===mail.id.slice(9));
      if (!invite || invite.revoked || invite.signedAt || invite.bookingVersion!==booking.version || (invite.offer && invite.offer.returnBy < day)) { mail.status="superseded"; mail.error="Agreement is no longer awaiting signature."; continue; }
    }
    const contractForReceipt = mail.kind==="receipt" && state.contracts?.find(c=>
      c.id===mail.id.slice(8) && !c.retentionArchived && c.offer.organizerSignedAt &&
      c.offer.performerEmail===mail.to && (c.bookingId || c.paymentId)===mail.bookingId);
    if (mail.kind==="receipt" && !contractForReceipt) {
      mail.status="superseded"; mail.error="Signed receipt unavailable."; continue;
    }
    if (mail.kind==="verification" && Date.now()-Date.parse(mail.createdAt)>30*60000) { mail.status="failed"; mail.error="Verification expired. Request a new link."; delivery.failed++; continue; }
    const key="stagebook-booking-mail:"+mail.id;
    const reserved=props.getProperty(key);
    if (reserved && reserved!=="sending") {
      mail.status="sent"; mail.sentAt=reserved; completed.push(key); delivery.sent++; continue;
    }
    if (reserved) { mail.status="uncertain"; mail.error="Google did not confirm sending. Copy the link to share manually."; delivery.failed++; continue; }
    if (quota<1) { mail.error="Email quota or permission unavailable. Automatic delivery will retry."; delivery.failed++; continue; }
    const contractOffer = contractForReceipt?.offer || (mail.kind==="contract" &&
      state.invites.find(i=>i.id===mail.id.slice(9))?.offer);
    const attach = contractOffer?.conditionsVersion===DMF_CONDITIONS_VERSION;
    if (attach && !pdf) {
      try { pdf = originalDmfAttachment(); }
      catch (_) { mail.error="MAIL_ATTACHMENT"; delivery.failed++; continue; }
    }
    props.setProperty(key,"sending");
    try {
      MailApp.sendEmail({to:mail.to,replyTo:state.venue.email,name:state.venue.name,subject:mail.subject,body:mail.body,
        ...(attach ? {attachments:[pdf]} : {})});
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
  if (before!==JSON.stringify(state.bookingMail)) writeBookingState(book,state);
  for (const key of completed) props.deleteProperty(key);
  return {ok:true,state,delivery};
}

function currentBookingMail(mail,booking) {
  return mail.status!=="superseded" &&
    (!mail.sourceVersion || mail.sourceVersion===(booking.sourceVersion || 1)) &&
    (!(mail.kind==="invitation" || (mail.kind==="reminder" && !mail.memberId)) || mail.to===booking.contactEmail) &&
    !/^(Booking changed\.|Signature no longer needed\.|Agreement is no longer awaiting signature\.)/.test(mail.error || "");
}
function bookingEmailStatus(state,booking) {
  if (booking.cancelled) return "Cancelled";
  const emails=(state.bookingMail || []).filter(mail=>mail.bookingId===booking.id && currentBookingMail(mail,booking));
  if (emails.some(mail=>["failed","uncertain"].includes(mail.status) || (mail.status==="pending" && mail.error))) return "Needs attention";
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
  const workflow=bookingWorkflowEnabled(sheet);
  const actions=workflow && sheet.getMaxColumns() >= 45 &&
    sheet.getRange("AR1").getValue() === "Workflow status";
  const scheduleColumns=actions && sheet.getMaxColumns()>=51 && sheet.getRange("AT1").getValue()==="Genre";
  const rows=sheet.getRange(2,1,sheet.getLastRow()-1,workflow ? 29+BOOKING_WORKFLOW_HEADERS.length : 28).getValues();
  rows.forEach((row,index)=>{
    const booking=(state.bookings || []).find(b=>b.id===String(row[22]));
    if (!booking) return;
    if (actions) {
      const stage = bookingStage(state,booking);
      const next = {
        confirm:["Confirm performance","booking"],
        sign:["Review and sign","review"],
        pay:["Mark paid","bookingPayments"],
        issue:["Issue signing requests","booking"],
        details:["Review issue","booking"]
      }[stage.action];
      const url = next ? "https://dmf-eta.vercel.app/?"+next[1]+"="+booking.id : "";
      const label = stage.label+(stage.reason ? " · "+stage.reason : "");
      sheet.getRange(index+2,44).setValue(label);
      const cell = sheet.getRange(index+2,45);
      if (url && /^[a-f0-9-]{36}$/i.test(booking.id))
        cell.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(next[0]).setLinkUrl(url).build());
      else cell.clearContent();
    }
    if (scheduleColumns) {
      const p = booking.performance;
      const safe = text => String(text || "").startsWith("=") ? "'"+text : text || "";
      const time = value => value ? sheetValue(value,TIME_FORMAT,"").numberValue : "";
      sheet.getRange(index+2,46,1,6).setValues([[
        safe(p?.genre), time(p?.getIn), p?.soundcheck || "", time(p?.soundcheckTime),
        time(p?.end), safe(p?.technicalNotes)
      ]]);
    }
    const paid=booking.members.length===booking.expectedMembers && booking.members.length>0 && booking.members.every(m=>m.paymentId && (state.payments || []).some(p=>p.id===m.paymentId && !p.voidReason));
    const total=booking.fee && (!booking.artistFirst || booking.performance) ?
      booking.fee*booking.expectedMembers/100 : "";
    const entrance=row[4]==="" ? null : Number(row[4]);
    const ratio=entrance!==null && Number.isFinite(entrance) && total>0 ? entrance/total : "";
    const contact=(state.musicians || []).find(m=>m.email.toLowerCase()===booking.contactEmail.toLowerCase() && booking.members.some(member=>member.musicianId===m.id));
    sheet.getRange(index+2,2).setValue(paid);
    sheet.getRange(index+2,6,1,2).setValues([[total,booking.performance ? booking.expectedMembers : ""]]);
    sheet.getRange(index+2,9).setValue(ratio);
    const phone = String(booking.contactPhone || contact?.phone || "");
    if (workflow) {
      const tickets=row[31];
      const ticketPrice=row[3];
      const revenue=Number.isInteger(tickets) && tickets>=0 && typeof ticketPrice==="number" && ticketPrice>=0
        ? Math.round(tickets*ticketPrice*100)/100 : "";
      const text = value => String(value || "").startsWith("=") ? "'"+value : value || "";
      const projection = [
        revenue,revenue!=="" && total>0 ? revenue/total : "",
        booking.retentionArchived ? "" : bookingContactUrl(booking,PropertiesService.getScriptProperties()),
        "https://dmf-eta.vercel.app/?booking="+booking.id,
        booking.performance?.start || "",booking.performance?.sets || "",booking.performance?.minutesPerSet || "",
        booking.confirmedAt ? "Confirmed by "+booking.confirmedBy : "Awaiting confirmation",
        text(booking.promotion?.bio),text(booking.promotion?.photoUrl),text(booking.promotion?.website)
      ];
      sheet.getRange(index+2,33,1,projection.length).setValues([projection]);
    }
    sheet.getRange(index+2,11).setValue(/^[+\d][\d()+ .-]*$/.test(phone) ? phone : "");
    if (!booking.sourceError) {
      sheet.getRange(index+2,24).setValue(sheetBookingContractStatus(state,booking));
      sheet.getRange(index+2,26).setValue(booking.performance ? booking.members.length+" / "+booking.expectedMembers : booking.members.length+" registered · lineup pending");
    }
  });
}

function ensureBookingActionColumns(sheet) {
  if (!bookingWorkflowEnabled(sheet) || typeof sheet.getSheetId !== "function") return;
  const width = sheet.getMaxColumns();
  if (width < 45) sheet.insertColumnsAfter(width,45-width);
  const headers = sheet.getRange(1,44,1,2);
  const current = headers.getValues()[0];
  if (current[0] === "Workflow status" && current[1] === "Next action") return;
  if (current.some(Boolean) || (sheet.getLastRow() > 1 && !sheet.getRange(2,44,sheet.getLastRow()-1,2).isBlank()))
    throw Error("Preserve the existing contents in AR:AS before adding workflow columns.");
  headers.setValues([["Workflow status","Next action"]]).setFontWeight("bold");
}

function ensureBookingScheduleColumns(sheet) {
  if (!bookingWorkflowEnabled(sheet) || typeof sheet.getSheetId !== "function") return;
  if (sheet.getMaxColumns()<51) sheet.insertColumnsAfter(sheet.getMaxColumns(),51-sheet.getMaxColumns());
  const values = ["Genre","Get-in","Soundcheck","Soundcheck time","Ends","Technical notes"];
  const headers = sheet.getRange(1,46,1,values.length);
  const existing = headers.getValues()[0];
  if (existing.join("|")===values.join("|")) return;
  if (existing.some(Boolean) || (sheet.getLastRow()>1 && !sheet.getRange(2,46,sheet.getLastRow()-1,values.length).isBlank()))
    throw Error("Preserve the existing contents in AT:AY before adding the technical schedule.");
  headers.setValues([values]).setFontWeight("bold");
  sheet.getRange("AU:AU").setNumberFormat("hh:mm");
  sheet.getRange("AW:AX").setNumberFormat("hh:mm");
}

const AUDIT_HEADERS = ["Timestamp","Action","Actor","Booking ID","Musician ID"];
function auditRow(action,actor,bookingId,musicianId) {
  const id = value => /^[a-f0-9-]{36}$/i.test(value || "") ? value : "";
  const name = String(actor || "admin");
  // Staff link names are entered by the venue. Reject emails, numbers and URLs.
  const safeActor = !/^[a-f0-9]{32,}$/i.test(name) && /^[\p{L} .’'\-]{1,100}$/u.test(name) ? name : "staff";
  return [new Date().toISOString(),action,safeActor,id(bookingId),id(musicianId)];
}
function auditAppend(book,rows) {
  let sheet = book.getSheetByName("AuditLog");
  if (!sheet) {
    sheet = book.insertSheet("AuditLog");
    SpreadsheetApp.flush();
  }
  if (sheet.getLastRow() === 0) rows = [AUDIT_HEADERS,...rows];
  else if (sheet.getRange(1,1,1,AUDIT_HEADERS.length).getValues()[0].join("|") !== AUDIT_HEADERS.join("|"))
    throw Error("Preserve the existing AuditLog tab under a different name before continuing.");
  return {appendCells:{sheetId:sheet.getSheetId(),fields:"userEnteredValue",rows:rows.map(row=>({
    values:row.map(stringValue=>({userEnteredValue:{stringValue}}))
  }))}};
}
function bookingAuditChanges(previous,state,staff) {
  const rows = [];
  const add = (action,actor,booking,musician) => rows.push(auditRow(action,actor,booking,musician));
  const byId = list => new Map((list || []).map(item=>[item.id,item]));
  const bookings = byId(previous?.bookings);
  const musicians = byId(previous?.musicians);
  const contracts = byId(previous?.contracts);
  const invites = byId(previous?.invites);
  const payments = byId(previous?.payments);
  const memberBookings = new Map();
  const nextMusicians = byId(state.musicians);
  for (const b of state.bookings || []) {
    const old = bookings.get(b.id);
    if (!old) add("Booking created","admin",b.id);
    if (b.contactPrivacyAcknowledgement?.acknowledgedAt &&
        b.contactPrivacyAcknowledgement.acknowledgedAt !== old?.contactPrivacyAcknowledgement?.acknowledgedAt)
      add("Contact form submitted","contact",b.id);
    if (b.confirmedAt && b.confirmedAt !== old?.confirmedAt)
      add("Attendance recorded",staff ? b.confirmedBy : "admin",b.id);
    for (const m of b.members) {
      const profile = nextMusicians.get(m.musicianId);
      if (profile?.privacyAcknowledgement?.acknowledgedAt &&
          (profile.privacyAcknowledgement.acknowledgedAt !== musicians.get(m.musicianId)?.privacyAcknowledgement?.acknowledgedAt) &&
          m.privacyAcknowledgement?.acknowledgedAt === profile.privacyAcknowledgement.acknowledgedAt)
        memberBookings.set(m.musicianId,b.id);
    }
  }
  for (const m of state.musicians || [])
    if (m.privacyAcknowledgement?.acknowledgedAt &&
        m.privacyAcknowledgement.acknowledgedAt !== musicians.get(m.id)?.privacyAcknowledgement?.acknowledgedAt)
      add("Musician form submitted","musician",memberBookings.get(m.id),m.id);
  for (const invite of state.invites || []) if (invite.offer && !invites.has(invite.id)) {
    add("Contract issued","admin",invite.bookingId,invite.musicianId);
    if (invite.offer.organizerSignedAt) add("Venue signed contract","admin",invite.bookingId,invite.musicianId);
  }
  for (const contract of state.contracts || []) {
    const before = contracts.get(contract.id);
    if (!before) add("Musician signed contract","musician",contract.bookingId,contract.musicianId);
    if (before && !before.offer.organizerSignedAt && contract.offer.organizerSignedAt)
      add("Venue signed contract","admin",contract.bookingId,contract.musicianId);
  }
  for (const p of state.payments || []) if (!payments.has(p.id))
    add("Payment recorded","admin",p.bookingId,p.musicianId);
  return rows;
}

function retentionYears(props) {
  const value = Number(props.getProperty("RETENTION_YEARS") || "5");
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw Error("RETENTION_YEARS must be a whole number between 1 and 100.");
  return value;
}
function enableStagebookRetention() {
  const props = PropertiesService.getScriptProperties();
  retentionYears(props);
  const book = SpreadsheetApp.openById(props.getProperty("SPREADSHEET_ID"));
  if (book.getOwner()?.getEmail() !== Session.getActiveUser().getEmail())
    throw Error("Only the owner can enable the retention job.");
  if (!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==="runStagebookRetention"))
    ScriptApp.newTrigger("runStagebookRetention").timeBased().everyDays(1).atHour(4).inTimezone("Europe/Copenhagen").create();
  props.setProperty("RETENTION_ENABLED","true");
}
function disableStagebookRetention() {
  PropertiesService.getScriptProperties().deleteProperty("RETENTION_ENABLED");
  for (const trigger of ScriptApp.getProjectTriggers())
    if (trigger.getHandlerFunction()==="runStagebookRetention") ScriptApp.deleteTrigger(trigger);
}
function dryRunStagebookRetention() { return stagebookRetention(true); }
function runStagebookRetention() { return stagebookRetention(false); }
function stagebookRetention(dryRun) {
  const props = PropertiesService.getScriptProperties();
  if (!dryRun && props.getProperty("RETENTION_ENABLED")!=="true") return;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const book = SpreadsheetApp.openById(props.getProperty("SPREADSHEET_ID"));
    const state = readStoredState(book);
    if (!state) return;
    const date = today();
    const plan = retentionPlan(state, Number(date.slice(0,4)) - retentionYears(props));
    console.info(JSON.stringify(plan.counts));
    if (dryRun) return plan.counts;
    const audit = [auditRow("Retention run","system")];
    if (!plan.ids.size) {
      Sheets.Spreadsheets.batchUpdate({requests:[auditAppend(book,audit)]},book.getId());
      return plan.counts;
    }
    anonymiseRetainedMusicians(state,plan,new Date().toISOString());
    const extra = retentionSheetRequests(book,state,plan);
    removeExpiredSensitiveRows(props,plan.ids);
    state.revision++;
    writeWorkbook(book,state,audit,extra);
    return plan.counts;
  } catch (_) {
    throw Error("Stagebook retention failed. Check the workbook configuration.");
  } finally { lock.releaseLock(); }
}
function retentionPlan(state, cutoffYear) {
  const byId = new Map(state.musicians.map(m=>[m.id,m]));
  const family = m => {
    const seen = new Set();
    while (m?.mergedInto && byId.has(m.mergedInto) && !seen.has(m.id)) {
      seen.add(m.id);
      m = byId.get(m.mergedInto);
    }
    return m?.email?.trim().toLowerCase() || m?.id || "";
  };
  const latest = new Map();
  const update = (key,date) => {
    const year = /^\d{4}-\d{2}-\d{2}/.test(date || "") ? Number(date.slice(0,4)) : 0;
    if (key && year) latest.set(key,Math.max(latest.get(key) || 0,year));
  };
  for (const b of state.bookings || []) {
    update(b.contactEmail?.toLowerCase(),b.date);
    for (const m of b.members) {
      update(family(byId.get(m.musicianId)),b.date);
      update(m.email?.toLowerCase(),b.date);
    }
  }
  for (const p of state.payments) {
    update(family(byId.get(p.musicianId)),p.performedOn);
    update(family(byId.get(p.musicianId)),p.paidOn);
  }
  for (const c of state.contracts || []) update(family(byId.get(c.musicianId)),c.offer.performanceDate);
  for (const i of state.invites) update(family(byId.get(i.musicianId)),i.offer?.performanceDate);
  for (const m of state.musicians) {
    const key = family(m);
    if (key && !latest.has(key)) update(key,m.createdAt);
  }
  const eligible = state.musicians.filter(m=>!m.retainedAnonymouslyAt && latest.has(family(m)) && latest.get(family(m)) < cutoffYear &&
    (!m.email || !latest.has(m.email.toLowerCase()) || latest.get(m.email.toLowerCase()) < cutoffYear));
  const eligibleFamilies = new Set(eligible.map(family));
  const held = new Set();
  for (const b of state.bookings || []) {
    if (b.cancelled || !b.members.some(m=>!m.exceptionResolution && !m.paymentId &&
      !eligibleFamilies.has(family(byId.get(m.musicianId))))) continue;
    for (const m of b.members) held.add(family(byId.get(m.musicianId)));
    held.add(b.contactEmail?.toLowerCase());
  }
  const expired = eligible.filter(m=>!held.has(family(m)));
  const ids = new Set(expired.map(m=>m.id));
  const emails = new Set(expired.map(m=>m.email?.toLowerCase()).filter(Boolean));
  const bookings = (state.bookings || []).filter(b=>b.members.some(m=>ids.has(m.musicianId)) || emails.has(b.contactEmail?.toLowerCase()));
  const contacts = new Set(bookings.filter(b=>emails.has(b.contactEmail?.toLowerCase())).map(b=>b.id));
  const members = new Set(bookings.flatMap(b=>b.members.filter(m=>ids.has(m.musicianId)).map(m=>m.id)));
  const contracts = new Set((state.contracts || []).filter(c=>ids.has(c.musicianId)).map(c=>c.id));
  const mail = (state.bookingMail || []).filter(m=>members.has(m.memberId) || emails.has(m.to?.toLowerCase()) || (contacts.has(m.bookingId) && !m.memberId));
  return {ids,emails,contacts,members,contracts,bookings:new Set(bookings.map(b=>b.id)),mail:new Set(mail.map(m=>m.id)),
    counts:{musicians:ids.size,bookings:bookings.length,members:members.size,contracts:contracts.size,
      payments:state.payments.filter(p=>ids.has(p.musicianId)).length,emails:mail.length,deferred:eligible.length-expired.length}};
}
function anonymiseRetainedMusicians(state,plan,at) {
  const label = "Anonymised musician";
  const names = new Set(state.musicians.filter(m=>plan.ids.has(m.id)).map(m=>m.name?.trim().toLowerCase()).filter(Boolean));
  const deidentifyAct = value => names.has(value?.trim().toLowerCase()) ? "Anonymised act" : value;
  for (const m of state.musicians) if (plan.ids.has(m.id)) {
    Object.assign(m,{name:label,email:"",phone:"",address:"",band:"",cpr:"",cvr:"",registration:"",account:"",iban:"",
      retainedAnonymouslyAt:at,deletedAt:at,updatedAt:at});
    for (const key of ["mobilepay","mobilePay","mobilePayNumber","sensitiveRef","performance","privacyAcknowledgement"])
      delete m[key];
  }
  for (const b of state.bookings || []) if (plan.bookings.has(b.id)) {
    for (const m of b.members) if (plan.members.has(m.id)) {
      m.name = label; m.email = "";
      for (const key of ["payout","performer","sensitiveRef","privacyAcknowledgement","exceptionResolution"]) delete m[key];
    }
    b.act = deidentifyAct(b.act);
    delete b.promotion;
    delete b.attendanceNote;
    delete b.correction;
    delete b.approvedBy;
    if (b.performance) { b.performance.requests = ""; b.performance.technicalNotes = ""; }
    if (plan.contacts.has(b.id)) {
      b.contactEmail = ""; b.contactName = ""; b.contactPhone = "";
      delete b.contactPrivacyAcknowledgement;
    }
    // A historical row containing retired personal details must not be reimported.
    b.retentionArchived = true;
    delete b.sourceSignature;
  }
  for (const p of state.payments) if (plan.ids.has(p.musicianId)) {
    p.name = label;
    p.band = deidentifyAct(p.band);
    p.notes = ""; p.reference = "";
    if (p.voidReason) p.voidReason = "Voided";
  }
  const eraseOffer = offer => {
    offer.performerEmail = ""; offer.organizerSigner = "";
    offer.specialTerms = ""; offer.requests = "";
    offer.bookingAct = deidentifyAct(offer.bookingAct);
  };
  for (const c of state.contracts || []) if (plan.contracts.has(c.id)) {
    c.performer = {name:label,email:"",phone:"",address:"",band:"",cvr:"",payee:c.performer.payee};
    c.performerSigner = "";
    c.retentionArchived = true;
    eraseOffer(c.offer);
  }
  state.invites = state.invites.filter(i=>!plan.ids.has(i.musicianId) && !plan.contracts.has(i.id) &&
    !plan.members.has(i.memberId) && !plan.emails.has(i.offer?.performerEmail?.toLowerCase()));
  if (state.bookingMail) state.bookingMail = state.bookingMail.filter(m=>!plan.mail.has(m.id));
  if (state.bookingVerifications) state.bookingVerifications = state.bookingVerifications.filter(v=>!plan.emails.has(v.email?.toLowerCase()));
}
function retentionSheetRequests(book,state,plan) {
  const sheet = book.getSheetByName("Bookings");
  if (!sheet || sheet.getLastRow()<2) return [];
  const modern = modernBookingSheet(sheet);
  const workflow = modern && bookingWorkflowEnabled(sheet);
  const ids = sheet.getRange(2,modern ? 23 : 9,sheet.getLastRow()-1,1).getValues();
  const requests = [];
  const bookings = new Map((state.bookings || []).map(b=>[b.id,b]));
  ids.forEach(([id],i)=>{
    if (!plan.bookings.has(id)) return;
    // Source row fields that are not part of writeWorkbook's generated tables.
    const act = bookings.get(id).act;
    const actColumn = modern ? 2 : 1;
    if (act === "Anonymised act") requests.push({updateCells:{
      start:{sheetId:sheet.getSheetId(),rowIndex:i+1,columnIndex:actColumn},
      rows:[{values:[{userEnteredValue:{stringValue:act}}]}],
      fields:"userEnteredValue"
    }});
    const cols = modern ? [24] : [10];
    if (plan.contacts.has(id)) cols.push(...(modern ? [9,10] : [2]));
    if (workflow) cols.push(34,40,41,42,...(plan.contacts.has(id) ? [29,30] : []));
    for (const column of cols) requests.push({updateCells:{range:{
      sheetId:sheet.getSheetId(),startRowIndex:i+1,endRowIndex:i+2,startColumnIndex:column,endColumnIndex:column+1
    },rows:[],fields:"userEnteredValue,textFormatRuns"}});
  });
  return requests;
}

const SENSITIVE_FIELDS = ["cpr","registration","account","iban","mobilePayNumber"];
const SENSITIVE_HEADERS = ["Reference","Musician ID","Details"];
function sensitiveStorage(props,create) {
  const id = props.getProperty("SENSITIVE_SPREADSHEET_ID");
  if (!id || id === props.getProperty("SPREADSHEET_ID"))
    throw Error("Configure a separate owner-only sensitive workbook.");
  const book = SpreadsheetApp.openById(id);
  const owner = book.getOwner()?.getEmail();
  if (!owner || owner !== Session.getEffectiveUser().getEmail() ||
      book.getEditors().some(user=>user.getEmail()!==owner) || book.getViewers().length)
    throw Error("The sensitive workbook must be owned by the deployment owner and restricted.");
  let sheet = book.getSheetByName("Sensitive");
  if (!sheet && create) sheet = book.insertSheet("Sensitive");
  if (!sheet) throw Error("Set up the sensitive workbook.");
  if (!sheet.getLastRow() && create) sheet.getRange(1,1,1,3).setValues([SENSITIVE_HEADERS]);
  if (sheet.getRange(1,1,1,3).getValues()[0].join("|") !== SENSITIVE_HEADERS.join("|"))
    throw Error("Preserve the existing Sensitive tab before proceeding.");
  return {book,sheet};
}
function sensitiveData(value) {
  return Object.fromEntries(SENSITIVE_FIELDS.map(key=>[key,String(value?.[key] || "")]));
}
function sensitiveRows(store) {
  const last = store.sheet.getLastRow();
  return last < 2 ? [] : store.sheet.getRange(2,1,last-1,3).getValues();
}
function sensitiveMask(value) {
  const text = String(value || "");
  return text ? "••••" + (text.length > 4 ? text.slice(-4) : "") : "";
}
function sensitiveView(book,state,request,props) {
  const booking = request.bookingId && (state.bookings || []).find(b=>b.id===request.bookingId);
  const member = booking && request.memberId && booking.members.find(m=>m.id===request.memberId);
  const targets = request.bookingId
    ? (request.memberId ? (member ? [member] : []) : booking?.members || [])
    : state.musicians.filter(m=>m.id===request.musicianId && !m.retainedAnonymouslyAt);
  if (!targets.length) return {ok:false};
  const members = new Map(state.musicians.map(m=>[m.id,m]));
  const needed = new Set(targets.map(t=>t.sensitiveRef).filter(Boolean));
  const refs = new Map();
  if (needed.size && props.getProperty("SENSITIVE_MIGRATED")==="true")
    for (const [ref,,payload] of sensitiveRows(sensitiveStorage(props,false))) if (needed.has(ref)) refs.set(ref,payload);
  const reveal = request.mode==="reveal";
  const records = targets.map(target=>{
    const musician = "musicianId" in target ? members.get(target.musicianId) : target;
    const ref = "musicianId" in target ? target.sensitiveRef : musician?.sensitiveRef;
    const fallback = target.payout || musician;
    const raw = ref ? sensitiveData(refs.has(ref) ? JSON.parse(refs.get(ref)) : null) : sensitiveData(fallback);
    if (!ref && (target.paymentType || musician?.preferredPaymentType)==="Mobilepay")
      raw.mobilePayNumber = raw.mobilePayNumber || fallback?.phone || "";
    return {id:target.id,...Object.fromEntries(SENSITIVE_FIELDS.map(key=>[key,reveal ? raw[key] : sensitiveMask(raw[key])]))};
  });
  if (reveal) {
    const rows = targets.map(target=>auditRow("Sensitive fields revealed","admin",booking?.id,target.musicianId || target.id));
    Sheets.Spreadsheets.batchUpdate({requests:[auditAppend(book,rows)]},book.getId());
  }
  return {ok:true,records};
}
function persistSensitive(state,props,migrating) {
  const profiles = new Map(state.musicians.map(m=>[m.id,m]));
  const rawPresent = value => SENSITIVE_FIELDS.some(key=>Boolean(value?.[key]));
  if (!migrating && !state.musicians.some(rawPresent) &&
      !(state.bookings || []).some(b=>b.members.some(m=>rawPresent(m.payout)))) return;
  if (!migrating && props.getProperty("SENSITIVE_MIGRATED")!=="true")
    throw Error("Complete the sensitive workbook migration before accepting new payout details.");
  const store = sensitiveStorage(props,migrating);
  const rows = sensitiveRows(store);
  const records = new Map(rows.map(([ref,,payload])=>[ref,payload]));
  const toWrite = [];
  const clearedContactPhones = new Set();
  function keep(value,ownerId,prior,method) {
    const current = records.has(prior) ? JSON.parse(records.get(prior)) : {};
    const details = sensitiveData(value);
    if (details.iban || details.registration || details.account) {
      if (!migrating && !(details.iban || (details.registration && details.account)))
        throw Error("Enter the complete bank details.");
    } else if (method==="Bank transfer") {
      details.registration = current.registration || "";
      details.account = current.account || "";
      details.iban = current.iban || "";
    }
    details.cpr = details.cpr || current.cpr || "";
    if (method==="Mobilepay") details.mobilePayNumber = details.mobilePayNumber || current.mobilePayNumber || "";
    const payload = JSON.stringify(details);
    if (!Object.values(details).some(Boolean)) return undefined;
    if (records.get(prior)===payload) return prior;
    const ref = bookingHmac("stagebook-sensitive:" + ownerId + ":" + payload,props);
    if (!records.has(ref)) {
      records.set(ref,payload);
      toWrite.push([ref,ownerId,payload]);
    }
    return ref;
  }
  for (const musician of state.musicians) {
    if (migrating && !musician.sensitiveRef && musician.preferredPaymentType==="Mobilepay" && !musician.mobilePayNumber) {
      musician.mobilePayNumber = musician.phone;
      for (const contract of [...(state.contracts || []),...state.invites])
        if (contract.musicianId===musician.id && contract.performer?.phone===musician.phone) contract.performer.phone = "";
      musician.phone = "";
    }
    if (rawPresent(musician)) musician.sensitiveRef = keep(musician,musician.id,musician.sensitiveRef,musician.preferredPaymentType || "Bank transfer");
    for (const key of SENSITIVE_FIELDS) delete musician[key];
  }
  for (const booking of state.bookings || []) for (const member of booking.members) {
    const profile = profiles.get(member.musicianId);
    const method = member.paymentType || booking.paymentType;
    if (migrating && method==="Mobilepay") {
      const old = member.payout?.phone || member.performer?.phone;
      if (old) {
        member.payout = member.payout || {};
        if (!member.payout.mobilePayNumber) member.payout.mobilePayNumber = old;
        if (member.performer?.phone===old) member.performer.phone = "";
        if (booking.contactPhone===old && booking.contactEmail===member.email) {
          booking.contactPhone = "";
          clearedContactPhones.add(booking.id);
        }
        for (const contract of [...(state.contracts || []),...state.invites])
          if (contract.memberId===member.id && contract.performer?.phone===old) contract.performer.phone = "";
      }
    }
    if (rawPresent(member.payout))
      member.sensitiveRef = keep(member.payout,member.musicianId,member.sensitiveRef || profile?.sensitiveRef,method);
    else if (migrating || !member.sensitiveRef) member.sensitiveRef = member.sensitiveRef || profile?.sensitiveRef;
    if (member.payout) {
      for (const key of SENSITIVE_FIELDS) delete member.payout[key];
      delete member.payout.phone;
    }
  }
  if (toWrite.length) Sheets.Spreadsheets.batchUpdate({requests:[{
    appendCells:{sheetId:store.sheet.getSheetId(),fields:"userEnteredValue",rows:toWrite.map(row=>({
      values:row.map(stringValue=>({userEnteredValue:{stringValue}}))
    }))}
  }]},store.book.getId());
  return clearedContactPhones;
}
function clearMigratedContactPhones(book,ids) {
  const sheet = book.getSheetByName("Bookings");
  if (!ids.size || !sheet || sheet.getLastRow() < 2 || !bookingWorkflowEnabled(sheet)) return [];
  return sheet.getRange(2,23,sheet.getLastRow()-1,1).getValues().flatMap(([id],index)=>ids.has(id) ? [{
    updateCells:{range:{sheetId:sheet.getSheetId(),startRowIndex:index+1,endRowIndex:index+2,
      startColumnIndex:30,endColumnIndex:31},rows:[],fields:"userEnteredValue"}
  }] : []);
}
function migrateStagebookSensitiveData() {
  const props = PropertiesService.getScriptProperties();
  const book = SpreadsheetApp.openById(props.getProperty("SPREADSHEET_ID"));
  const owner = book.getOwner()?.getEmail();
  const backupId = props.getProperty("SENSITIVE_BACKUP_ID");
  if (!owner || owner !== Session.getActiveUser().getEmail())
    throw Error("Only the workbook owner can migrate payout data.");
  if (props.getProperty("SENSITIVE_MIGRATED")==="true") return;
  if (!backupId || backupId===book.getId() || backupId===props.getProperty("SENSITIVE_SPREADSHEET_ID"))
    throw Error("Create a separate restricted backup and set SENSITIVE_BACKUP_ID.");
  const backup = SpreadsheetApp.openById(backupId);
  if (backup.getOwner()?.getEmail()!==owner || !backup.getSheetByName("_Stagebook") ||
      backup.getEditors().some(user=>user.getEmail()!==owner) || backup.getViewers().length)
    throw Error("Use a restricted backup of the main workbook.");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const state = readStoredState(book);
    if (!state) throw Error("The Stagebook workspace is missing.");
    const clearedPhones = persistSensitive(state,props,true);
    state.revision++;
    writeWorkbook(book,state,[],clearMigratedContactPhones(book,clearedPhones));
    props.setProperty("SENSITIVE_MIGRATED","true");
  } finally { lock.releaseLock(); }
}
function removeExpiredSensitiveRows(props,ids) {
  if (props.getProperty("SENSITIVE_MIGRATED")!=="true") return;
  const store = sensitiveStorage(props,false);
  const ranges = sensitiveRows(store).flatMap(([,id],index)=>ids.has(id) ? [{
    updateCells:{range:{sheetId:store.sheet.getSheetId(),startRowIndex:index+1,endRowIndex:index+2,
      startColumnIndex:0,endColumnIndex:3},rows:[],fields:"userEnteredValue"}
  }] : []);
  if (ranges.length) Sheets.Spreadsheets.batchUpdate({requests:ranges},store.book.getId());
}

// Shared booking workflow. Regenerate with npm run sync:booking-workflow.
function today() { return Utilities.formatDate(new Date(),"Europe/Copenhagen","yyyy-MM-dd"); }
function bookingRegistrationClosed(b) { return b.approvedVersion===b.version || b.contractsVersion===b.version; }
function hasOtherPaymentPath(state,v,manual) { return (state.payments || []).some(p=>!p.voidReason && p.kind==="Payment" && Boolean(p.bookingId)===manual && p.musicianId===v.musicianId && p.performedOn===v.performedOn && normalizeBand(p.band)===normalizeBand(v.band)); }
function tariff(date) {
    if (date < "2026-04-01")
        return 0;
    return date >= "2027-04-01" ? 320000 : 315000;
}
function tariffWarning(date, fee) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(fee) || fee <= 0)
        return "";
    const minimum = tariff(date);
    return fee < minimum
        ? "This fee is below DMF's minimum tariff of " +
            (minimum / 100).toLocaleString("en-GB") +
            " kr per musician."
        : "";
}
function deriveBookingStage(f) {
    if (f.cancelled)
        return { label: "Cancelled", action: "none" };
    if (f.sourceError)
        return {
            label: "Needs attention",
            action: "details",
            reason: f.sourceError,
        };
    const complete = f.venueSigned &&
        f.confirmed &&
        f.paymentStates.length > 0 &&
        f.paymentStates.every((s) => s === "Paid" || s === "Exception resolved");
    if (complete && !f.mailIssue)
        return { label: "Complete", action: "none" };
    if (!f.scheduled || f.registered !== f.expected) {
        if (f.mailIssue)
            return {
                label: "Needs attention",
                action: "details",
                reason: f.mailIssue,
            };
        return {
            label: f.invited ? "Waiting for registrations" : "Booked",
            action: "none",
        };
    }
    if (!f.fee)
        return {
            label: "Needs attention",
            action: "details",
            reason: "Enter the agreed fee.",
        };
    if (f.legacyApproval)
        return { label: "Ready to sign", action: "sign" };
    if (!f.issued)
        return {
            label: "Needs attention",
            action: "issue",
            reason: "Signing requests need issuing.",
        };
    if (f.signed < f.signatureTarget) {
        if (f.mailIssue)
            return {
                label: "Needs attention",
                action: "details",
                reason: f.mailIssue,
            };
        return { label: "Waiting for signatures", action: "none" };
    }
    if (!f.confirmed)
        return {
            label: f.canConfirm ? "Ready to confirm" : "Booked",
            action: f.canConfirm ? "confirm" : "none",
            reason: f.canConfirm
                ? undefined
                : "Performance is confirmed on or after the booking date.",
        };
    if (!f.venueSigned && f.signatureTarget > 0)
        return { label: "Ready to sign", action: "sign" };
    if (f.paymentStates.includes("Ready to pay"))
        return { label: "Ready to pay", action: "pay" };
    if (f.mailIssue)
        return {
            label: "Needs attention",
            action: "details",
            reason: f.mailIssue,
        };
    if (complete)
        return { label: "Complete", action: "none" };
    return {
        label: "Needs attention",
        action: "details",
        reason: f.paymentStates.find((s) => !["Paid", "Exception resolved"].includes(s)) || "Review the performance exception.",
    };
}
function pendingReason(state, booking, member) {
    if ((state.payments || []).some((p) => p.id === member.paymentId && !p.voidReason))
        return "Paid";
    if (booking.cancelled)
        return "Cancelled";
    if (booking.sourceError)
        return "Booking sheet needs attention";
    if (member.exceptionResolution)
        return "Exception resolved";
    if (booking.confirmedAt && member.attendance === "absent")
        return "Artist absent";
    if (booking.artistFirst && booking.contractsVersion !== booking.version)
        return "Registration or contract details needed";
    if (!booking.artistFirst && booking.approvedVersion !== booking.version)
        return "Company approval needed";
    const contract = state.contracts?.find((item) => item.id === member.contractId && item.bookingVersion === booking.version);
    if (!contract)
        return "Artist signature needed";
    if (!booking.confirmedAt)
        return "Performance confirmation needed";
    if (!member.attendance)
        return "Attendance not recorded";
    if (member.attendance !== "played")
        return "Performance issue";
    if (!contract.offer.organizerSignedAt)
        return "Venue signature needed";
    if (hasOtherPaymentPath(state, {
        musicianId: member.musicianId,
        performedOn: booking.date,
        band: booking.act,
    }, false))
        return "Manual payment needs reconciliation";
    return "Ready to pay";
}
function bookingStage(state, booking) {
    const mail = (state.bookingMail || []).filter((m) => m.bookingId === booking.id && currentBookingMail(m, booking));
    const issue = mail.find((m) => ["invitation", "contract", "receipt"].includes(m.kind) &&
        ["pending", "failed", "uncertain"].includes(m.status) &&
        (m.error || m.status !== "pending") &&
        (m.kind !== "contract" ||
            booking.members.some((member) => !member.exceptionResolution &&
                (!booking.confirmedAt || member.attendance === "played") &&
                m.id === "contract:" + member.contractId &&
                !state.contracts?.some((c) => c.id === member.contractId))));
    const targets = booking.artistFirst && booking.confirmedAt
        ? booking.members.filter((member) => member.attendance === "played")
        : booking.members;
    const paymentStates = booking.members.map((member) => pendingReason(state, booking, member));
    const expiredRequest = targets.some((member) => state.invites.some((invite) => invite.id === member.contractId &&
        !invite.signedAt &&
        (invite.revoked || (invite.offer && invite.offer.returnBy < today()))));
    return deriveBookingStage({
        cancelled: Boolean(booking.cancelled),
        sourceError: booking.sourceError,
        mailIssue: issue?.error ||
            (issue ? "Check " + issue.kind + " delivery." : undefined) ||
            (expiredRequest
                ? "A signing link has expired or been revoked."
                : undefined),
        invited: mail.some((m) => m.kind === "invitation" && m.status === "sent"),
        registered: booking.members.length,
        expected: booking.expectedMembers,
        scheduled: Boolean(booking.performance),
        fee: booking.fee,
        issued: bookingRegistrationClosed(booking),
        signed: targets.filter((member) => state.contracts?.some((c) => c.id === member.contractId && c.bookingVersion === booking.version)).length,
        signatureTarget: targets.length,
        legacyApproval: !booking.artistFirst && booking.approvedVersion !== booking.version,
        venueSigned: booking.approvedVersion === booking.version ||
            (Boolean(booking.confirmedAt) && targets.length === 0),
        confirmed: Boolean(booking.confirmedAt),
        canConfirm: booking.date <= today(),
        paymentStates,
    });
}
