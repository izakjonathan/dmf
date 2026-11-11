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
  const musicians = [["Musician ID","Legal name","Email","Phone","Address","Band","Recipient","CVR","CPR","Bank registration","Bank account","Registered","Updated","IBAN"]];
  for (const m of state.musicians) musicians.push([m.id,m.name,m.email,m.phone,m.address,m.band,m.payee,m.cvr,m.cpr,m.registration,m.account,m.createdAt,m.updatedAt,m.iban || ""]);
  const payments = [["Payment ID","Musician ID","Musician","Band at payment","Venue","Paid on","Performance date","Amount DKK","Net DKK","Type","Reference","Notes","Void reason","Recorded at"]];
  const groups = new Map();
  for (const p of state.payments) {
    const net = paymentNet(p);
    payments.push([p.id,p.musicianId,p.name,p.band,p.venue,p.paidOn,p.performedOn,p.amount/100,net/100,p.kind,p.reference,p.notes,p.voidReason||"",p.recordedAt]);
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
    "Organizer signer","Organizer signed at","Musician signer","Musician signed at","Template"
  ]];
  for (const c of state.contracts || []) {
    const t = c.offer;
    contracts.push([
      c.id,c.musicianId,c.performer.name,c.performer.email,c.performer.band,t.organizer.name,t.performanceDate,
      t.start,t.end,t.sets,t.minutesPerSet,t.fee/100,t.payOn || "First working day after performance",t.specialTerms,
      t.organizerSigner,t.organizerSignedAt,c.performerSigner,c.performerSignedAt,t.template.url
    ]);
  }
  return {Venue:venue,Musicians:musicians,Payments:payments,Summary:summary,Contracts:contracts};
}
function writeWorkbook(book,state) {
  const tables = rowsFor(state);
  const encoded = Utilities.base64Encode(JSON.stringify(state), Utilities.Charset.UTF_8);
  const storage = [[state.revision]];
  for(let i=0; i<encoded.length; i+=40000) storage.push([encoded.slice(i,i+40000)]);
  tables._Stagebook = storage;
  const requests = [];
  for (const name of Object.keys(tables)) {
    const sheet = book.getSheetByName(name);
    const rows = tables[name];
    let sheetId;
    if (!sheet && name === "Contracts") {
      const used = new Set(book.getSheets().map(item => item.getSheetId()));
      sheetId = 1;
      while (used.has(sheetId)) sheetId++;
      requests.push({addSheet:{properties:{sheetId,title:name,gridProperties:{rowCount:Math.max(1000,rows.length),columnCount:26}}}});
    } else {
      if (name === "Contracts" && sheet.getLastRow() && sheet.getRange("A1").getValue() !== rows[0][0]) {
        throw Error("Rename the existing Contracts tab to avoid overwriting unrelated data.");
      }
      sheetId = sheet.getSheetId();
    }
    if (sheet && rows.length > sheet.getMaxRows()) {
      requests.push({updateSheetProperties:{properties:{sheetId,gridProperties:{rowCount:rows.length}},fields:"gridProperties.rowCount"}});
    }
    requests.push({updateCells:{
      range:{sheetId,startRowIndex:0,startColumnIndex:0,endColumnIndex:rows[0].length},
      rows:rows.map(row=>({values:row.map(value=>({userEnteredValue:typeof value==="number"?{numberValue:value}:{stringValue:String(value??"")}}))})),
      fields:"userEnteredValue"
    }});
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
}
