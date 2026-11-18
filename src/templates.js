// Costing sheet and customer quotation templates.
// Ported from the desktop generator (generate-quote.js) so PDFs made in the
// Lark panel look the same as the ones made on the PC.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const SERVICE_LABEL = { 'Air': 'Air Freight', 'Sea FCL': 'Sea Freight FCL', 'Sea LCL': 'Sea Freight LCL', 'Trucking': 'Trucking' };

export const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
export function money(v, cur) {
  const n = num(v);
  if (cur === 'USD') return 'US$ ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return 'Rp ' + Math.round(n).toLocaleString('en-US');
}
const bullets = (text) => String(text || '').split('\n').map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
const pctText = (f) => (num(f) * 100).toFixed(1).replace(/\.0$/, '') + '%';

// Scoped under .pdfdoc so the panel's own styles are untouched.
export const PDF_STYLE = `
  .pdfdoc { width: 182mm; font-family: "Segoe UI", Arial, sans-serif; color: #1f2430; font-size: 10pt; background: #fff; }
  .pdfdoc * { box-sizing: border-box; }
  .pdfdoc header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #f26b1d; padding-bottom: 10px; }
  .pdfdoc header img { height: 40px; }
  .pdfdoc header h1 { margin: 0; color: #1b2a8c; font-size: 22pt; font-weight: 700; }
  .pdfdoc .note { background: #fff4ec; border-left: 4px solid #f26b1d; padding: 7px 10px; margin: 12px 0; font-size: 9.5pt; }
  .pdfdoc .meta { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid #dfe3ee; border-radius: 6px; margin-top: 12px; }
  .pdfdoc .meta > div { padding: 7px 10px; border-right: 1px solid #dfe3ee; }
  .pdfdoc .meta > div:last-child { border-right: 0; }
  .pdfdoc .label { font-size: 8pt; letter-spacing: .06em; text-transform: uppercase; color: #6b7285; }
  .pdfdoc .val { font-weight: 600; margin-top: 2px; }
  .pdfdoc .two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px; }
  .pdfdoc h2 { color: #1b2a8c; font-size: 11pt; margin: 11px 0 4px; }
  .pdfdoc .two h2 { margin-top: 0; }
  .pdfdoc .summary { display: grid; grid-template-columns: repeat(4, 1fr); background: #f4f6fb; border-radius: 6px; }
  .pdfdoc .summary > div { padding: 6px 10px; }
  .pdfdoc table { width: 100%; border-collapse: collapse; }
  .pdfdoc th { text-align: left; font-size: 8pt; letter-spacing: .06em; color: #6b7285; border-bottom: 1px solid #dfe3ee; padding: 6px 8px; }
  .pdfdoc td { padding: 5px 8px; border-bottom: 1px solid #dfe3ee; vertical-align: top; }
  .pdfdoc .amt { text-align: right; white-space: nowrap; }
  .pdfdoc tr.sub td { font-weight: 600; }
  .pdfdoc tr.total td { background: #1b2a8c; color: #fff; font-weight: 700; border: 0; }
  .pdfdoc tr.profit td { background: #e9f7ef; font-weight: 700; }
  .pdfdoc ul { margin: 4px 0 0; padding-left: 18px; } .pdfdoc li { margin: 2px 0; }
  .pdfdoc .terms td { border: 0; padding: 3px 0; }
  .pdfdoc .internal { color: #b42318; font-weight: 700; font-size: 9pt; letter-spacing: .08em; }
  .pdfdoc footer { margin-top: 12px; border-top: 1px solid #dfe3ee; padding-top: 8px; font-size: 8.5pt; color: #6b7285; text-align: center; }
  .pdfdoc tr, .pdfdoc .two, .pdfdoc .summary, .pdfdoc footer { break-inside: avoid; }`;

// q: plain quote object (field name -> plain value), lines: plain line objects,
// t: totals from calc(), ctx: { logo, ownerName, ownerEmail }
export function quotationHtml(q, lines, t, ctx) {
  const cur = q.Currency || 'IDR';
  const format = q['Price Format'] || 'All-in';
  const docType = q['Document Type'] || 'Quotation';
  const isEstimate = docType === 'Cost Estimation';
  const service = SERVICE_LABEL[q['Service Type']] || q['Service Type'] || '';
  let rows = '';
  if (format === 'Breakdown') {
    for (const l of lines) {
      const qty = num(l.Qty || 1);
      // qty × unit price only adds information when more than one unit is charged
      const unitSell = qty ? l.sell / qty : 0;
      const detail = [l.Details, qty !== 1 ? `${qty} ${l.Unit || ''} × ${money(unitSell, cur)}` : ''].filter(Boolean).join(' · ');
      rows += `<tr><td>${esc(l.Charge)}</td><td>${esc(detail)}</td><td class="amt">${money(l.sell, cur)}</td></tr>`;
    }
    rows += `<tr class="sub"><td>Subtotal</td><td></td><td class="amt">${money(t.base, cur)}</td></tr>`;
  } else {
    rows += `<tr><td>${isEstimate ? 'Base' : 'All-in price'}</td><td>${esc(q['All-in Description'])}</td><td class="amt">${money(t.base, cur)}</td></tr>`;
  }
  rows += `<tr><td>VAT</td><td>${pctText(q['VAT Rate'])} of base</td><td class="amt">${money(t.vat, cur)}</td></tr>`;
  rows += `<tr class="total"><td>${isEstimate ? 'ESTIMATED TOTAL' : 'TOTAL'}</td><td>${isEstimate ? 'Subject to confirmation' : ''}</td><td class="amt">${money(t.total, cur)}</td></tr>`;

  const declared = num(q['Declared Value']) ? money(q['Declared Value'], cur) : 'N/A';
  const volume = num(q['Volume (CBM)']) ? `${q['Volume (CBM)']} CBM` : 'N/A';
  const weight = num(q['Chargeable Weight (kg)']) ? `${q['Chargeable Weight (kg)']} kg` : 'N/A';
  const transit = num(q['Transit Days']) ? `Approx. ${q['Transit Days']} days transit` : '';

  return `<div class="pdfdoc">
<header><img src="${ctx.logo}" alt="Interfreight"><h1>${esc(docType)}</h1></header>
${isEstimate ? '<div class="note">This is an estimation. Final pricing will be confirmed once shipment details are finalized.</div>' : ''}
<div class="meta">
  <div><div class="label">Reference</div><div class="val">${esc(q.Reference)}</div></div>
  <div><div class="label">Issued</div><div class="val">${fmtDate(q.Issued)}</div></div>
  <div><div class="label">Valid until</div><div class="val">${fmtDate(q['Valid Until'])}</div></div>
  <div><div class="label">Currency</div><div class="val">${esc(cur)}</div></div>
</div>
<div class="two">
  <div><h2>Prepared for</h2>
    <div class="val">${esc(q['Customer Name'] || q.Company || '—')}</div>
    ${q.Company && q.Company !== q['Customer Name'] ? `<div>${esc(q.Company)}</div>` : ''}
    ${q['Customer Email'] ? `<div>${esc(q['Customer Email'])}</div>` : ''}
    <div>${esc(q['Customer WhatsApp'] || '')}</div></div>
  <div><h2>Route</h2>
    <div class="val">${esc(q.Origin || '—')} &nbsp;→&nbsp; ${esc(q.Destination || '—')}</div>
    <div>${esc(service)}</div>
    <div>${esc(transit)}</div></div>
</div>
<h2>Shipment summary</h2>
<div class="summary">
  <div><div class="label">Packages</div><div class="val">${num(q.Packages) || 'N/A'}</div></div>
  <div><div class="label">Chargeable weight</div><div class="val">${weight}</div></div>
  <div><div class="label">Declared value</div><div class="val">${declared}</div></div>
  <div><div class="label">Volume</div><div class="val">${volume}</div></div>
</div>
<h2>Pricing ${format === 'Breakdown' ? 'breakdown' : ''}</h2>
<table><thead><tr><th style="width:24%">ITEM</th><th>DETAILS</th><th class="amt">AMOUNT</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Payment terms${isEstimate ? ' (indicative)' : ''}</h2>
<table class="terms"><tr><td>${esc(q['Payment Terms'] || '')}</td><td class="amt">${money(t.total, cur)}</td></tr></table>
<div style="font-size:9pt;color:#6b7285;margin-top:4px">Payment methods: Indonesian bank transfer, Stripe (cards, GBP/USD) · International bank transfer on request.</div>
<div class="two" style="margin-top:16px">
  <div><h2>What's included</h2><ul>${bullets(q["What's Included"]).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>
  <div><h2>What's not included</h2><ul>${bullets(q["What's Not Included"]).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>
</div>
<h2>Next steps</h2>
<div>${isEstimate
    ? "Once you've finalized your shipment details — final weight, dimensions, collection date — we'll send a firm quote for your confirmation. Any questions in the meantime, just reply to this email or WhatsApp us."
    : 'To proceed, simply reply to confirm this quotation and share your collection details. Any questions, just reply to this email or WhatsApp us.'}</div>
<h2>Prepared by</h2>
<div class="val">${esc(ctx.ownerName || '')} — Interfreight</div>
<div>${esc(ctx.ownerEmail || '')}</div>
<footer>Interfreight · Delivering Across Borders · www.interfreight-cargo.com<br>
${isEstimate ? 'Estimation based on stated details. Final pricing subject to actual weight and volume verified at collection.' : `Quotation valid until ${fmtDate(q['Valid Until'])}. Rates subject to space and equipment availability.`}</footer>
</div>`;
}

// Internal costing sheet, mirroring the "Actual Cost" spreadsheet.
export function costingHtml(q, lines, t, ctx) {
  const service = SERVICE_LABEL[q['Service Type']] || q['Service Type'] || '';
  const rate = num(q['Exchange Rate (USD to IDR)']);
  const sections = {};
  for (const l of lines) (sections[l.Section || 'Unsorted'] = sections[l.Section || 'Unsorted'] || []).push(l);
  let body = '';
  for (const name of Object.keys(sections).sort()) {
    const ls = sections[name];
    let usd = 0, idr = 0, rows = '';
    ls.forEach((l, i) => {
      const ccy = l['Cost Currency'] || 'IDR';
      const orig = num(l.Qty || 1) * num(l['Cost Rate']);
      if (ccy === 'USD') usd += orig; else idr += orig;
      const qtyTxt = num(l.Qty || 1) !== 1 ? `${num(l.Qty)} ${l.Unit || ''} × ${money(l['Cost Rate'], ccy)}` : '';
      rows += `<tr><td>${i + 1}</td><td>${esc(l.Charge)}${l.Details ? ` <span style="color:#6b7285">· ${esc(l.Details)}</span>` : ''}</td>
        <td>${esc(qtyTxt)}</td><td class="amt">${money(orig, ccy)}</td><td class="amt">${money(l.costIdr, 'IDR')}</td><td class="amt">${money(l.sell, 'IDR')}</td></tr>`;
    });
    const sectionIdr = ls.reduce((s, l) => s + l.costIdr, 0);
    const totals = [usd ? money(usd, 'USD') : '', idr ? money(idr, 'IDR') : ''].filter(Boolean).join(' + ');
    body += `<h2>${esc(name)}</h2><table><thead><tr><th style="width:5%">#</th><th>COST ITEM</th><th>QTY × RATE</th><th class="amt">COST</th><th class="amt">COST (IDR)</th><th class="amt">SELL (IDR)</th></tr></thead>
      <tbody>${rows}<tr class="sub"><td></td><td>Total</td><td></td><td class="amt">${totals}</td><td class="amt">${money(sectionIdr, 'IDR')}</td><td></td></tr></tbody></table>`;
  }
  const pct = t.cost ? ((t.profit / t.cost) * 100).toFixed(1) + '%' : '—';

  return `<div class="pdfdoc">
<header><img src="${ctx.logo}" alt="Interfreight"><h1>Actual Cost</h1></header>
<div class="note"><span class="internal">INTERNAL — DO NOT SEND TO CUSTOMER</span></div>
<div class="meta">
  <div><div class="label">Quote reference</div><div class="val">${esc(q.Reference)}</div></div>
  <div><div class="label">Customer</div><div class="val">${esc(q.Company || q['Customer Name'] || '—')}</div></div>
  <div><div class="label">Date</div><div class="val">${fmtDate(q.Issued)}</div></div>
  <div><div class="label">Exchange rate</div><div class="val">${rate ? 'Rp ' + rate.toLocaleString('en-US') + ' / USD' : '—'}</div></div>
</div>
<div class="two">
  <div><h2>Shipment</h2>
    <div class="val">${esc(service)} · ${esc(q.Origin || '—')} → ${esc(q.Destination || '—')}</div>
    <div>${esc(q['Cargo Details'] || '')}</div></div>
  <div><h2>Selling as</h2>
    <div class="val">${esc(q['Price Format'] || 'All-in')} · margin ${(num(q['Margin %']) * 100).toFixed(0)}% on cost</div>
    <div>Prepared by ${esc(ctx.ownerName || '')}</div></div>
</div>
${body || '<div class="note">No cost lines entered for this quote.</div>'}
<h2>Summary</h2>
<table>
  <tr class="sub"><td>Grand total cost</td><td class="amt">${money(t.cost, 'IDR')}</td></tr>
  <tr><td>Selling price (before VAT)</td><td class="amt">${money(t.base, 'IDR')}</td></tr>
  <tr class="profit"><td>Margin / profit (${pct} on cost)</td><td class="amt">${money(t.profit, 'IDR')}</td></tr>
  <tr><td>VAT ${pctText(q['VAT Rate'])}</td><td class="amt">${money(t.vat, 'IDR')}</td></tr>
  <tr class="total"><td>Total billed to customer</td><td class="amt">${money(t.total, 'IDR')}</td></tr>
</table>
${q['Internal Notes'] ? `<h2>Internal notes</h2><div>${esc(q['Internal Notes'])}</div>` : ''}
<footer>Interfreight · internal costing for ${esc(q.Reference)}</footer>
</div>`;
}
