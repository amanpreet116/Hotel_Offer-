/**
 * End-to-end smoke test for the Temporal layer.
 *
 * Requires all three pieces to be up: a Temporal server, the worker
 * (`npm run dev:worker`) and the API process hosting the mock suppliers
 * (`npm run dev`). Run it with `npm run verify`.
 */
import { config } from '../config/index.js';
import { closeTemporalClient, runGetHotelsWorkflow } from '../temporal/client.js';
import type { HotelOffer } from '../domain/types.js';

const EXPECTED_DELHI: Readonly<Record<string, string>> = {
  Holtin: 'Supplier B@4950',
  Radison: 'Supplier A@6100',
  'Leela Palace': 'Supplier A@9800',
  'Taj Mahal Hotel': 'Supplier B@11900',
  'The Imperial': 'Supplier A@8700',
  'Bloomrooms Janpath': 'Supplier A@3100',
  'Hyatt Regency': 'Supplier B@7250',
  'Andaz Delhi': 'Supplier B@10500',
};

async function main(): Promise<void> {
  console.log(`Temporal   : ${config.temporal.address} (${config.temporal.namespace})`);
  console.log(`Supplier A : ${config.suppliers.a.url}`);
  console.log(`Supplier B : ${config.suppliers.b.url}\n`);

  const failures: string[] = [];

  const delhi = await timed('delhi', () => runGetHotelsWorkflow('delhi'));
  print(delhi.offers);
  const actual = Object.fromEntries(delhi.offers.map((o) => [o.name, `${o.supplier}@${o.price}`]));

  for (const [name, expected] of Object.entries(EXPECTED_DELHI)) {
    const got = actual[name];
    if (got !== expected) failures.push(`delhi/${name}: expected ${expected}, got ${got ?? '<missing>'}`);
  }
  if (delhi.offers.length !== Object.keys(EXPECTED_DELHI).length) {
    failures.push(`delhi: expected ${Object.keys(EXPECTED_DELHI).length} offers, got ${delhi.offers.length}`);
  }

  const mumbai = await timed('mumbai', () => runGetHotelsWorkflow('mumbai'));
  print(mumbai.offers);

  const jaipur = await timed('jaipur (unknown city)', () => runGetHotelsWorkflow('jaipur'));
  if (jaipur.offers.length !== 0) failures.push(`jaipur: expected 0 offers, got ${jaipur.offers.length}`);

  if (failures.length > 0) {
    console.error('\nFAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll checks passed.');
}

async function timed(label: string, run: () => Promise<HotelOffer[]>): Promise<{ offers: HotelOffer[] }> {
  const startedAt = Date.now();
  const offers = await run();
  console.log(`--- ${label}: ${offers.length} offers in ${Date.now() - startedAt}ms ---`);
  return { offers };
}

function print(offers: HotelOffer[]): void {
  for (const offer of offers) {
    console.log(
      `  ${offer.name.padEnd(22)} ${String(offer.price).padStart(6)}  ${offer.supplier}  ${offer.commissionPct}%`,
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error('\nVerification failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeTemporalClient());
