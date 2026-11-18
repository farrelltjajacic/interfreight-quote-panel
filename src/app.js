// Interfreight Quotation panel — a Lark Base extension.
// Everything is read and written through the Base the panel is opened in, as the
// signed-in Lark user; no tokens or IDs are stored here.

import { bitable, FieldType } from '@lark-base-open/js-sdk';
import html2pdf from 'html2pdf.js';
import { quotationHtml, costingHtml, PDF_STYLE, num, esc, money, fmtDate } from './templates.js';

const TABLES = { quotes: 'Quotations', lines: 'Quote Charges', jobs: 'Shipments' };

// Quote fields the panel edits (everything else on the quote is formula/system)
const QUOTE_EDIT = [
  'Status', 'Document Type', 'Account', 'Company', 'Customer Name', 'Customer Email', 'Customer WhatsApp',
  'Direction', 'Service Type', 'Origin', 'Destination', 'Cargo Details', 'Packages', 'Chargeable Weight (kg)',
  'Volume (CBM)', 'Declared Value', 'Transit Days', 'Issued', 'Valid Until', 'Exchange Rate (USD to IDR)',
  'Margin %', 'Price Format', 'All-in Price', 'All-in Description', 'VAT Rate', 'Currency', 'Payment Terms',
  "What's Included", "What's Not Included", 'Handled By', 'Internal Notes',
];
const LINE_EDIT = ['Section', 'Charge', 'Details', 'Cost Currency', 'Qty', 'Unit', 'Cost Rate', 'Unit Price'];

const DEFAULTS = {
  Status: 'Draft', 'Document Type': 'Quotation', Currency: 'IDR', 'Price Format': 'All-in', 'VAT Rate': 0.011,
  'Margin %': 0.1, 'Payment Terms': '100% before delivery',
  "What's Included": '  - Freight\n  - Origin & destination handling\n  - Customs clearance',
  "What's Not Included": '  - Import duties and taxes\n  - Storage/demurrage beyond free time\n  - Insurance (available on request)',
};

const state = {
  tables: {}, meta: {}, quotes: [], q: null, lines: [], removed: [], userId: null, logo: '', busy: false, dirty: false,
};

// ---------- small helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const app = () => $('#app');
const fieldMeta = (t, name) => state.meta[t][name];
const fid = (t, name) => {
  const m = fieldMeta(t, name);
  if (!m) throw new Error(`Field "${name}" is missing from the ${TABLES[t]} table.`);
  return m.id;
};
const options = (t, name) => ((fieldMeta(t, name) || {}).property || {}).options || [];

function toast(msg, kind = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = 'toast'), kind === 'error' ? 9000 : 4000);
}

// Lark cell value -> plain JS value
function plain(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    if (typeof v[0] === 'number' || typeof v[0] === 'string') return v[0];
    if (v[0] && typeof v[0] === 'object' && 'text' in v[0] && !('id' in v[0]) && !('token' in v[0])) {
      return v.map((s) => s.text).join('');
    }
    return v; // users, attachments, multi-select
  }
  if ('recordIds' in v) return v.recordIds;
  if ('id' in v && 'text' in v) return v.text; // single select
  if ('value' in v) return v.value;            // auto number
  if ('text' in v) return v.text;
  return v;
}

// plain JS value -> Lark cell value, by field type
function cell(t, name, val) {
  const m = fieldMeta(t, name);
  const empty = val === null || val === undefined || val === '';
  switch (m.type) {
    case FieldType.Number:
      return empty ? null : Number(val);
    case FieldType.SingleSelect: {
      if (empty) return null;
      const o = options(t, name).find((x) => x.name === val);
      if (!o) throw new Error(`"${val}" is not an option of ${name} in ${TABLES[t]}.`);
      return { id: o.id, text: o.name };
    }
    case FieldType.DateTime:
      return empty ? null : Number(val);
    case FieldType.User:
      return empty ? null : (Array.isArray(val) ? val : [val]).map((u) => ({ id: u.id || u }));
    case FieldType.SingleLink:
    case FieldType.DuplexLink:
      return { recordIds: empty ? [] : val, tableId: m.property.tableId, text: '', type: 'text' };
    case FieldType.Text:
      return empty ? null : [{ type: 'text', text: String(val) }];
    default:
      return empty ? null : String(val); // email / phone / url style text fields
  }
}

async function allRecords(t) {
  const table = state.tables[t];
  const out = [];
  let pageToken;
  do {
    const res = await table.getRecordsByPage({ pageSize: 200, pageToken });
    out.push(...res.records);
    pageToken = res.hasMore ? res.pageToken : undefined;
  } while (pageToken !== undefined);
  return out;
}

function toPlain(t, rec) {
  const o = { recordId: rec.recordId };
  for (const [name, m] of Object.entries(state.meta[t])) o[name] = plain(rec.fields[m.id]);
  return o;
}

// ---------- calculations (mirror the Base formulas) ----------
function calc() {
  const q = state.q;
  const rate = num(q['Exchange Rate (USD to IDR)']);
  const margin = num(q['Margin %']);
  let cost = 0, sub = 0;
  for (const l of state.lines) {
    const qty = l.Qty === '' || l.Qty === null || l.Qty === undefined ? 0 : num(l.Qty);
    l.costIdr = qty * num(l['Cost Rate']) * (l['Cost Currency'] === 'USD' ? rate : 1);
    const override = l['Unit Price'] !== '' && l['Unit Price'] !== null && l['Unit Price'] !== undefined;
    l.sell = override ? qty * num(l['Unit Price']) : l.costIdr * (1 + margin);
    cost += l.costIdr;
    sub += l.sell;
  }
  const allIn = q['All-in Price'];
  const base = q['Price Format'] === 'Breakdown' || allIn === '' || allIn === null || allIn === undefined ? sub : num(allIn);
  const vat = base * num(q['VAT Rate']);
  return { cost, sub, base, vat, total: base + vat, profit: cost > 0 ? base - cost : 0 };
}

// ---------- loading ----------
async function loadQuotes() {
  state.quotes = (await allRecords('quotes')).map((r) => toPlain('quotes', r))
    .sort((a, b) => String(b.Reference || '').localeCompare(String(a.Reference || '')));
}

async function openQuote(recordId) {
  if (!recordId) return newQuote();
  const q = state.quotes.find((x) => x.recordId === recordId);
  if (!q) return;
  state.q = { ...q };
  const lineIds = Array.isArray(q.Charges) ? q.Charges : [];
  state.lines = lineIds.length
    ? (await state.tables.lines.getRecordsByIds(lineIds)).map((r, i) => ({ ...toPlain('lines', { recordId: lineIds[i], fields: r.fields }) }))
    : [];
  state.removed = [];
  state.dirty = false;
  render();
}

function newQuote() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  state.q = {
    recordId: null, ...DEFAULTS,
    Issued: today.getTime(), 'Valid Until': today.getTime() + 14 * 86400000,
    'Handled By': state.userId ? [{ id: state.userId }] : null,
  };
  state.lines = [];
  state.removed = [];
  state.dirty = true;
  addLine();
  render();
}

function addLine(section = 'A - Origin Cost') {
  state.lines.push({ recordId: null, Section: section, Charge: '', Details: '', 'Cost Currency': 'IDR', Qty: 1, Unit: '', 'Cost Rate': '', 'Unit Price': '' });
}

// ---------- saving ----------
async function save({ quiet = false } = {}) {
  const q = state.q;
  const qt = state.tables.quotes;
  const fields = {};
  for (const name of QUOTE_EDIT) if (fieldMeta('quotes', name)) fields[fid('quotes', name)] = cell('quotes', name, q[name]);
  if (q.recordId) await qt.setRecord(q.recordId, { fields });
  else q.recordId = await qt.addRecord({ fields });

  const lt = state.tables.lines;
  const link = cell('lines', 'Quotation', [q.recordId]);
  const updates = [], adds = [], addIdx = [];
  state.lines.forEach((l, i) => {
    const f = { [fid('lines', 'Quotation')]: link };
    for (const name of LINE_EDIT) f[fid('lines', name)] = cell('lines', name, l[name]);
    if (l.recordId) updates.push({ recordId: l.recordId, fields: f });
    else { adds.push({ fields: f }); addIdx.push(i); }
  });
  if (updates.length) await lt.setRecords(updates);
  if (adds.length) (await lt.addRecords(adds)).forEach((id, k) => (state.lines[addIdx[k]].recordId = id));
  if (state.removed.length) { await lt.deleteRecords(state.removed); state.removed = []; }

  await loadQuotes();
  const fresh = state.quotes.find((x) => x.recordId === q.recordId);
  if (fresh) Object.assign(state.q, { Reference: fresh.Reference, 'Quote PDF': fresh['Quote PDF'], 'Costing PDF': fresh['Costing PDF'], 'Shipment Job': fresh['Shipment Job'] });
  state.dirty = false;
  if (!quiet) toast(`Saved ${state.q.Reference || ''}`, 'ok');
}

async function setStatus(status, extra = {}) {
  const fields = { [fid('quotes', 'Status')]: cell('quotes', 'Status', status) };
  for (const [k, v] of Object.entries(extra)) fields[fid('quotes', k)] = cell('quotes', k, v);
  await state.tables.quotes.setRecord(state.q.recordId, { fields });
  state.q.Status = status;
  Object.assign(state.q, extra);
}

// ---------- PDFs ----------
async function htmlToPdf(html) {
  const holder = document.createElement('div');
  holder.className = 'pdf-holder';
  holder.innerHTML = html;
  document.body.appendChild(holder);
  await Promise.all([...holder.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
  try {
    return await html2pdf().set({
      margin: [12, 14, 12, 14],
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, backgroundColor: '#ffffff', useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] },
    }).from(holder.firstElementChild).outputPdf('blob');
  } finally {
    holder.remove();
  }
}

async function generate() {
  await save({ quiet: true });
  const q = state.q;
  const t = calc();
  const owner = Array.isArray(q['Handled By']) ? q['Handled By'][0] : null;
  const ctx = { logo: state.logo, ownerName: owner ? owner.name : '', ownerEmail: owner ? owner.email || '' : '' };
  const lines = state.lines.filter((l) => l.Charge || num(l['Cost Rate']));
  const safe = String(q.Company || q['Customer Name'] || 'Customer').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');

  const quoteBlob = await htmlToPdf(quotationHtml(q, lines, t, ctx));
  const costBlob = await htmlToPdf(costingHtml(q, lines, t, ctx));
  const quoteFile = new File([quoteBlob], `${q.Reference}_${safe}.pdf`, { type: 'application/pdf' });
  const costFile = new File([costBlob], `${q.Reference}_${safe}_COSTING.pdf`, { type: 'application/pdf' });

  const quotePdfField = await state.tables.quotes.getFieldById(fid('quotes', 'Quote PDF'));
  const costPdfField = await state.tables.quotes.getFieldById(fid('quotes', 'Costing PDF'));
  await quotePdfField.setValue(q.recordId, quoteFile);   // replaces the previous PDF
  await costPdfField.setValue(q.recordId, costFile);
  await setStatus('Review');

  state.previews = { quote: URL.createObjectURL(quoteBlob), costing: URL.createObjectURL(costBlob) };
  await loadQuotes();
  render();
  toast('PDFs attached to the quote. Check both, then send the quotation.', 'ok');
}

// ---------- accepted -> shipment job ----------
async function createJob() {
  const q = state.q;
  if (q['Shipment Job']) { toast(`This quote already has job ${q['Shipment Job']}.`); return; }
  if (!q.Account || !q.Direction || !q['Service Type']) throw new Error('Set Account, Direction and Service Type before accepting, so the job lands on the right board.');
  const jt = state.tables.jobs;
  const f = {};
  const put = (name, val) => { if (fieldMeta('jobs', name) && val !== null && val !== undefined && val !== '') f[fid('jobs', name)] = cell('jobs', name, val); };
  put('Account', q.Account);
  put('Direction', q.Direction);
  put('Mode', q['Service Type']);
  put('Status', 'Booked');
  put('Origin', q.Origin);
  put('Destination', q.Destination);
  put('Handled By', q['Handled By']);
  put('Source Message', `Quotation ${q.Reference}`);
  put('Notes', `Created from accepted quotation ${q.Reference}${q.Company ? ` for ${q.Company}` : ''}.${q['Cargo Details'] ? ` Cargo: ${q['Cargo Details']}` : ''}`);
  const jobId = await jt.addRecord({ fields: f });
  const jobNo = plain(await jt.getCellValue(fid('jobs', 'Job No.'), jobId)) || jobId;
  await setStatus('Accepted', { 'Shipment Job': String(jobNo) });
  await loadQuotes();
  render();
  toast(`Accepted. Job ${jobNo} created on the ${q.Direction} board (Booked).`, 'ok');
}

// ---------- rendering ----------
const opt = (t, name, cur) => `<option value=""></option>` + options(t, name)
  .map((o) => `<option ${o.name === cur ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
const dateVal = (ts) => (ts ? new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '');

function fieldHtml(label, name, kind = 'text', extra = '') {
  const v = state.q[name];
  let input;
  if (kind === 'select') input = `<select data-q="${esc(name)}">${opt('quotes', name, v)}</select>`;
  else if (kind === 'date') input = `<input type="date" data-q="${esc(name)}" data-kind="date" value="${dateVal(v)}">`;
  else if (kind === 'pct') input = `<input type="number" step="any" data-q="${esc(name)}" data-kind="pct" value="${v === null || v === undefined || v === '' ? '' : +(num(v) * 100).toFixed(4)}">`;
  else if (kind === 'num') input = `<input type="number" step="any" data-q="${esc(name)}" data-kind="num" value="${v ?? ''}" ${extra}>`;
  else if (kind === 'area') input = `<textarea rows="3" data-q="${esc(name)}">${esc(v ?? '')}</textarea>`;
  else input = `<input type="text" data-q="${esc(name)}" value="${esc(v ?? '')}" ${extra}>`;
  return `<label class="f"><span>${esc(label)}</span>${input}</label>`;
}

function lineHtml(l, i) {
  const sel = (name, cur) => `<select data-l="${i}" data-k="${esc(name)}" aria-label="${esc(name)}">${options('lines', name).map((o) => `<option ${o.name === cur ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`;
  const inp = (name, ph, kind = 'text') => `<input data-l="${i}" data-k="${esc(name)}" ${kind === 'num' ? 'type="number" step="any" data-kind="num"' : 'type="text"'} placeholder="${esc(ph)}" aria-label="${esc(ph)}" value="${esc(l[name] ?? '')}">`;
  return `<div class="line" data-row="${i}">
    <div class="c-section">${sel('Section', l.Section)}</div>
    <div class="c-charge">${inp('Charge', 'Charge')}</div>
    <div class="c-details">${inp('Details', 'Details')}</div>
    <div class="c-ccy">${sel('Cost Currency', l['Cost Currency'])}</div>
    <div class="c-qty">${inp('Qty', 'Qty', 'num')}</div>
    <div class="c-unit">${inp('Unit', 'Unit')}</div>
    <div class="c-rate">${inp('Cost Rate', 'Cost rate', 'num')}</div>
    <div class="c-cost ro" data-out="cost"></div>
    <div class="c-price">${inp('Unit Price', 'Sell/unit (auto)', 'num')}</div>
    <div class="c-sell ro" data-out="sell"></div>
    <div class="c-del"><button class="icon" data-del="${i}" title="Remove line" aria-label="Remove line">✕</button></div>
  </div>`;
}

const FOLLOW_UP_DAYS = [3, 7, 10, 14];
function followUpHtml(q) {
  if (q.Status !== 'Sent' || !q['Sent Date']) return '';
  const sent = new Date(q['Sent Date']); sent.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - sent) / 86400000);
  const next = FOLLOW_UP_DAYS.find((d) => d >= days);
  const due = FOLLOW_UP_DAYS.includes(days);
  const nextText = next === undefined ? 'all follow-ups done — update to Accepted or Lost'
    : due ? `<b>day ${days} follow-up is due today</b>`
    : `next follow-up on day ${next} (${fmtDate(sent.getTime() + next * 86400000)})`;
  return `<p class="followup${due ? ' due' : ''}">Sent ${fmtDate(sent.getTime())} · ${days} day${days === 1 ? '' : 's'} ago · ${nextText}</p>`;
}

function render() {
  const q = state.q;
  const status = q.Status || 'Draft';
  const quoteOpts = state.quotes.map((x) => `<option value="${x.recordId}" ${x.recordId === q.recordId ? 'selected' : ''}>${esc(x.Reference || '(new)')} · ${esc(x.Company || x['Customer Name'] || '—')} · ${esc(x.Status || '')}</option>`).join('');
  const pdfLinks = state.previews && state.previews.quote
    ? `<div class="previews"><a href="${state.previews.quote}" target="_blank" rel="noopener">Open quotation PDF</a><a href="${state.previews.costing}" target="_blank" rel="noopener">Open costing PDF</a></div>` : '';

  app().innerHTML = `
  <div class="top">
    <select id="pick" aria-label="Open quote"><option value="">+ New quote</option>${quoteOpts}</select>
    <button id="new" class="ghost">New</button>
  </div>
  <div class="title">
    <h1>${esc(q.Reference || 'New quote')}</h1>
    <span class="pill s-${esc(status.toLowerCase())}">${esc(status)}</span>
    ${q['Shipment Job'] ? `<span class="pill s-job">Job ${esc(q['Shipment Job'])}</span>` : ''}
  </div>
  ${followUpHtml(q)}

  <section><h2>Customer</h2><div class="grid">
    ${fieldHtml('Account', 'Account', 'select')}${fieldHtml('Company', 'Company')}
    ${fieldHtml('Contact name', 'Customer Name')}${fieldHtml('Email', 'Customer Email')}
    ${fieldHtml('WhatsApp', 'Customer WhatsApp')}${fieldHtml('Document', 'Document Type', 'select')}
  </div></section>

  <section><h2>Shipment</h2><div class="grid">
    ${fieldHtml('Direction', 'Direction', 'select')}${fieldHtml('Service', 'Service Type', 'select')}
    ${fieldHtml('Origin', 'Origin')}${fieldHtml('Destination', 'Destination')}
    ${fieldHtml('Cargo details', 'Cargo Details')}${fieldHtml('Packages', 'Packages', 'num')}
    ${fieldHtml('Chargeable weight (kg)', 'Chargeable Weight (kg)', 'num')}${fieldHtml('Volume (CBM)', 'Volume (CBM)', 'num')}
    ${fieldHtml('Declared value', 'Declared Value', 'num')}${fieldHtml('Transit days', 'Transit Days', 'num')}
    ${fieldHtml('Issued', 'Issued', 'date')}${fieldHtml('Valid until', 'Valid Until', 'date')}
  </div></section>

  <section class="costing"><h2>Costing</h2>
    <div class="grid">${fieldHtml('Exchange rate (Rp per USD)', 'Exchange Rate (USD to IDR)', 'num')}${fieldHtml('Margin %', 'Margin %', 'pct')}</div>
    <div class="sheet">
      <div class="line head"><div class="c-section">Section</div><div class="c-charge">Charge</div><div class="c-details">Details</div><div class="c-ccy">Ccy</div><div class="c-qty">Qty</div><div class="c-unit">Unit</div><div class="c-rate">Cost rate</div><div class="c-cost">Cost (IDR)</div><div class="c-price">Sell/unit</div><div class="c-sell">Sell (IDR)</div><div class="c-del"></div></div>
      ${state.lines.map(lineHtml).join('')}
    </div>
    <div class="row-actions"><button id="addA" class="ghost">+ Origin cost</button><button id="addB" class="ghost">+ Clearance / destination</button><button id="addC" class="ghost">+ Other</button></div>
    <p class="hint">Leave <b>Sell/unit</b> blank to sell at cost + margin. USD costs convert at the exchange rate.</p>
  </section>

  <section><h2>Selling</h2>
    <div class="seg" role="radiogroup" aria-label="Price format">
      ${['All-in', 'Breakdown'].map((f) => `<label><input type="radio" name="fmt" value="${f}" ${q['Price Format'] === f ? 'checked' : ''}> ${f === 'All-in' ? 'All-in price' : 'Breakdown of charges'}</label>`).join('')}
    </div>
    <div class="grid">
      ${q['Price Format'] !== 'Breakdown' ? fieldHtml('All-in price (blank = cost + margin)', 'All-in Price', 'num', 'id="allin"') + fieldHtml('All-in description', 'All-in Description') : ''}
      ${fieldHtml('VAT %', 'VAT Rate', 'pct')}${fieldHtml('Payment terms', 'Payment Terms')}
    </div>
    <div class="grid">${fieldHtml("What's included", "What's Included", 'area')}${fieldHtml("What's not included", "What's Not Included", 'area')}</div>
    <div class="grid">${fieldHtml('Internal notes (costing only)', 'Internal Notes', 'area')}</div>
  </section>

  <div class="totals" id="totals"></div>

  <section class="actions">
    <button id="save" class="ghost">Save</button>
    <button id="gen" class="primary">Generate costing + quotation</button>
    ${['Review', 'Sent'].includes(status) ? '<button id="sent" class="ghost">Mark as sent</button>' : ''}
    ${['Review', 'Sent'].includes(status) && !q['Shipment Job'] ? '<button id="accept" class="primary green">Customer accepted → create job</button><button id="lost" class="ghost">Lost</button>' : ''}
    ${pdfLinks}
    <p class="hint">PDFs are attached to the quote in Lark (Quote PDF / Costing PDF).</p>
  </section>`;
  refreshNumbers();
}

function refreshNumbers() {
  const t = calc();
  state.lines.forEach((l, i) => {
    const row = $(`.line[data-row="${i}"]`);
    if (!row) return;
    row.querySelector('[data-out="cost"]').textContent = money(l.costIdr, 'IDR');
    row.querySelector('[data-out="sell"]').textContent = money(l.sell, 'IDR');
  });
  const allin = $('#allin');
  if (allin) allin.placeholder = `auto: ${Math.round(t.sub).toLocaleString('en-US')}`;
  $('#totals').innerHTML = `
    <div><span>Cost</span><b>${money(t.cost, 'IDR')}</b></div>
    <div><span>Sell</span><b>${money(t.base, 'IDR')}</b></div>
    <div class="${t.profit < 0 ? 'neg' : 'pos'}"><span>Profit</span><b>${money(t.profit, 'IDR')}${t.cost ? ` · ${((t.profit / t.cost) * 100).toFixed(1)}%` : ''}</b></div>
    <div><span>Total incl. VAT</span><b>${money(t.total, 'IDR')}</b></div>`;
}

// ---------- events ----------
function readInput(el) {
  const kind = el.dataset.kind;
  if (kind === 'date') return el.value ? new Date(el.value + 'T00:00:00').getTime() : null;
  if (kind === 'pct') return el.value === '' ? null : Number(el.value) / 100;
  if (kind === 'num') return el.value === '' ? '' : Number(el.value);
  return el.value;
}

async function run(btn, fn) {
  if (state.busy) return;
  state.busy = true;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Working…';
  try { await fn(); } catch (e) { console.error(e); toast(e.message || String(e), 'error'); render(); }
  finally { state.busy = false; btn.disabled = false; btn.textContent = label; }
}

function bind() {
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.q) {
      state.q[el.dataset.q] = readInput(el);
      state.dirty = true;
      refreshNumbers();
    } else if (el.dataset.l !== undefined) {
      state.lines[+el.dataset.l][el.dataset.k] = readInput(el);
      state.dirty = true;
      refreshNumbers();
    }
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.name === 'fmt') { state.q['Price Format'] = el.value; state.dirty = true; render(); }
    if (el.id === 'pick') {
      if (state.dirty && !state.confirmLeave) {
        toast('You have unsaved changes. Save first, or pick again to discard them.');
        state.confirmLeave = true;
        el.value = state.q.recordId || '';
        return;
      }
      state.confirmLeave = false;
      state.previews = null;
      openQuote(el.value);
    }
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.del !== undefined) {
      const [l] = state.lines.splice(+b.dataset.del, 1);
      if (l.recordId) state.removed.push(l.recordId);
      state.dirty = true;
      render();
      return;
    }
    const map = {
      new: () => { state.previews = null; newQuote(); },
      addA: () => { addLine('A - Origin Cost'); render(); },
      addB: () => { addLine('B - Customs Clearance / Destination'); render(); },
      addC: () => { addLine('C - Other'); render(); },
      save: () => run(b, () => save()),
      gen: () => run(b, generate),
      sent: () => run(b, async () => {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        await setStatus('Sent', { 'Sent Date': today.getTime() });
        await loadQuotes(); render();
        toast('Marked as sent. Follow-up reminders will come on day 3, 7, 10 and 14.', 'ok');
      }),
      accept: () => run(b, createJob),
      lost: () => run(b, async () => { await setStatus('Lost'); await loadQuotes(); render(); toast('Marked as lost.'); }),
    };
    if (map[b.id]) map[b.id]();
  });
}

// ---------- start ----------
async function loadLogo() {
  const res = await fetch('logo.png');
  const blob = await res.blob();
  return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
}

async function start() {
  const style = document.createElement('style');
  style.textContent = PDF_STYLE;
  document.head.appendChild(style);
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('not-in-lark')), 6000));
    await Promise.race([bitable.base.getTableList(), timeout]);
  } catch (e) {
    app().innerHTML = `<div class="empty"><h1>Interfreight Quotation</h1><p>Open this page inside Lark: in your Base, click <b>Extensions → Customize</b> and add this page's link.</p></div>`;
    return;
  }
  try {
    for (const [k, name] of Object.entries(TABLES)) {
      state.tables[k] = await bitable.base.getTableByName(name);
      state.meta[k] = Object.fromEntries((await state.tables[k].getFieldMetaList()).map((m) => [m.name, m]));
    }
    try { state.userId = await bitable.bridge.getUserId(); } catch (e) { /* default owner is optional */ }
    try { if ((await bitable.bridge.getTheme()) === 'DARK') document.documentElement.dataset.theme = 'dark'; } catch (e) { /* light by default */ }
    bitable.bridge.onThemeChange((ev) => { document.documentElement.dataset.theme = ev.data.theme === 'DARK' ? 'dark' : 'light'; });
    state.logo = await loadLogo();
    await loadQuotes();
    bind();

    // follow the quote the user clicks in the Quotations table
    const quotesId = await bitable.base.getTableIdByName(TABLES.quotes);
    const sel = await bitable.base.getSelection();
    if (sel.tableId === quotesId && sel.recordId) await openQuote(sel.recordId); else newQuote();
    bitable.base.onSelectionChange(async (ev) => {
      const s = ev.data;
      if (s.tableId !== quotesId || !s.recordId || s.recordId === (state.q && state.q.recordId)) return;
      if (state.dirty) { toast('Unsaved changes here — save before switching quotes.'); return; }
      await loadQuotes();
      state.previews = null;
      await openQuote(s.recordId);
    });
  } catch (e) {
    console.error(e);
    app().innerHTML = `<div class="empty"><h1>Couldn't load</h1><p>${esc(e.message || String(e))}</p><p>This panel needs the Quotations, Quote Charges and Shipments tables.</p></div>`;
  }
}

start();
