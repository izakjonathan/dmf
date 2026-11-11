/**
 * Stagebook spreadsheet adapter. Bind to a dedicated spreadsheet.
 * Enable Google Sheets API under Services before running initialize.
 */
function initialize() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  const configuredId = props.getProperty("SPREADSHEET_ID");
  if (configuredId && configuredId !== spreadsheet.getId()) throw Error("This script is already bound to another workbook.");
  const names = ["Venue", "Musicians", "Payments", "Summary", "_Stagebook"];
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
  try {
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty("API_SECRET");
    const input = JSON.parse(event.postData.contents);
    if (!secret || typeof input.body !== "string" || input.body.length > 3000000) return respond({ok:false});
    const expected = Utilities.computeHmacSha256Signature(input.body, secret)
      .map(value => ((value + 256) % 256).toString(16).padStart(2, "0")).join("");
    if (!matches(expected, String(input.signature || ""))) return respond({ok:false});
    const request = JSON.parse(input.body);
    if (!Number.isFinite(request.timestamp) || Math.abs(Date.now() - request.timestamp) > 120000) return respond({ok:false});
    lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return respond({ok:false});
    const book = SpreadsheetApp.openById(props.getProperty("SPREADSHEET_ID"));
    const storage = book.getSheetByName("_Stagebook");
    const revision = Number(storage.getRange("A1").getValue()) || 0;
    if (request.action === "write") {
      if (request.expected !== revision) return respond({ok:false,error:"CONFLICT"});
      if (request.state?.revision !== revision + 1) return respond({ok:false});
      writeWorkbook(book, request.state);
      return respond({ok:true});
    }
    const length = storage.getLastRow();
    const encoded = length > 1 ? storage.getRange(2,1,length-1,1).getValues().map(row=>row[0]).join("") : "";
    const state = encoded ? JSON.parse(Utilities.newBlob(Utilities.base64Decode(encoded)).getDataAsString("UTF-8")) : null;
    if (request.action === "metadata") return respond({ok:true,initialized:Boolean(state?.auth)});
    if (request.action === "read") return respond({ok:true,state:state});
    return respond({ok:false});
  } catch (_) {
    return respond({ok:false});
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
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
  const musicians = [["Musician ID","Legal name","Email","Phone","Address","Band","Recipient","CVR","CPR","Bank registration","Bank account","Registered","Updated"]];
  for (const m of state.musicians) musicians.push([m.id,m.name,m.email,m.phone,m.address,m.band,m.payee,m.cvr,m.cpr,m.registration,m.account,m.createdAt,m.updatedAt]);
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
  return {Venue:venue,Musicians:musicians,Payments:payments,Summary:summary};
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
    const sheetId = sheet.getSheetId();
    if (rows.length > sheet.getMaxRows()) {
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
