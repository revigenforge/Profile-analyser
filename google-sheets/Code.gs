/**
 * RevigenForge Profile Analyser → Google Sheet connector.
 *
 * Setup (once):
 *  1. Create a Google Sheet (e.g. "RevigenForge Creator Connections").
 *  2. Extensions → Apps Script. Replace the editor contents with this file. Save.
 *  3. Project Settings (gear icon) → Script Properties → Add property:
 *       SECRET = <a long random string>   (use the same value as GOOGLE_SHEETS_SECRET on Vercel)
 *  4. Deploy → New deployment → type "Web app".
 *       Execute as: Me      Who has access: Anyone
 *     Authorise when asked, then copy the Web app URL (ends in /exec).
 *  5. On Vercel set GOOGLE_SHEETS_WEBHOOK_URL = that URL and GOOGLE_SHEETS_SECRET = the same secret.
 *
 * If you edit this script later: Deploy → Manage deployments → Edit → Version: New version.
 */

const SHEET_NAME = 'Connections';
const HEADERS = ['Submitted at', 'Name', 'Email', 'Handle', 'Platform', 'Interests', 'Score', 'Message'];

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || payload.secret !== secret) return json({ ok: false, error: 'unauthorised' });

    const entry = payload.entry || {};
    const sheet = getSheet();
    sheet.appendRow([
      entry.createdAt ? new Date(entry.createdAt) : new Date(),
      clean(entry.name),
      clean(entry.email),
      clean(entry.handle),
      clean(entry.platform),
      (entry.interests || []).map(clean).join(', '),
      typeof entry.score === 'number' ? entry.score : '',
      clean(entry.goals),
    ]);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Prevent spreadsheet formula injection from user-supplied text.
function clean(value) {
  const s = String(value == null ? '' : value);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
