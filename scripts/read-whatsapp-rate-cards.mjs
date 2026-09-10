// Read-only importer: prints official Meta list prices for review; never edits the rate snapshot.
const source =
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing?locale=en_US';
const html = await (await fetch(source)).text();
const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  .map((m) => ({ url: m[1].replace(/&amp;/g, '&'), text: m[2].replace(/<[^>]*>/g, '') }))
  .filter((link) => /^[A-Z]{3} rates$/.test(link.text));
const currencies = new Set();
const cards = {};
function parseCsv(csv) {
  const rows = [];
  let row = [],
    value = '',
    quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (quoted && csv[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n')) {
      row.push(value.trim());
      value = '';
      if (ch === '\n') {
        rows.push(row);
        row = [];
      }
    } else value += ch;
  }
  row.push(value.trim());
  rows.push(row);
  return rows;
}
for (const link of links) {
  const currency = link.text.slice(0, 3);
  if (currencies.has(currency)) continue;
  currencies.add(currency);
  const url = new URL(link.url).searchParams.get('u') ?? link.url;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Rate card download failed: ${currency}`);
  const csv = await response.text();
  if (!csv.includes('effective July 1, 2026'))
    throw new Error(`Review the new effective date: ${currency}`);
  const rows = parseCsv(csv)
    .filter((row) => row[1] === currency)
    .map((row) => [row[0], Number(row[2].replaceAll(',', '')), Number(row[3].replaceAll(',', ''))]);
  if (
    rows.length !== 38 ||
    rows.some((row) => !row[0] || !Number.isFinite(row[1]) || !Number.isFinite(row[2]))
  )
    throw new Error(`Unexpected rate card format: ${currency}`);
  cards[currency] = Object.fromEntries(
    rows.map(([market, marketing, utility]) => [market, { marketing, utility }]),
  );
}
if (currencies.size !== 16) throw new Error('Expected all 16 Meta billing currencies.');
console.log(
  JSON.stringify({
    source,
    verifiedAt: new Date().toISOString().slice(0, 10),
    effectiveFrom: '2026-07-01',
    effectiveUntil: '2026-10-01',
    cards,
  }),
);
