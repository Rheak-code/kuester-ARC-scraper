/**
 * kuester-arc-scraper / fetch-arc-requests.js
 *
 * Logs into the Kuester Management portal, opens the ARC Review queue,
 * and either (a) lists all open/pending requests, or (b) pulls the full
 * detail (fields + notes + attachments) for one request, saving everything
 * to ./output/<homeowner-slug>/ so it can be fed to the arc-review-assistant
 * Claude skill.
 *
 * Credentials are read from environment variables — never hardcode them
 * and never pass them on the command line (they'd end up in shell history).
 *
 *   KUESTER_EMAIL     - portal login email
 *   KUESTER_PASSWORD  - portal login password
 *
 * Usage:
 *   npm install
 *   KUESTER_EMAIL=you@example.com KUESTER_PASSWORD=secret npm run list
 *   KUESTER_EMAIL=you@example.com KUESTER_PASSWORD=secret node fetch-arc-requests.js --homeowner "Vyom Chadha"
 *   node fetch-arc-requests.js --row 2        # 0-indexed row on the current filtered page
 *
 * This script only reads data and downloads files. It does NOT write notes
 * or decisions back into Kuester — that stays a manual, confirmed step.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const LOGIN_URL = 'https://kmg.cincwebaxis.com/account/loginmodernthemes';
const OUTPUT_ROOT = path.resolve('./output');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { list: args.includes('--list') };
  const homeownerIdx = args.indexOf('--homeowner');
  if (homeownerIdx !== -1) out.homeowner = args[homeownerIdx + 1];
  const rowIdx = args.indexOf('--row');
  if (rowIdx !== -1) out.row = parseInt(args[rowIdx + 1], 10);
  return out;
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function login(page) {
  const email = process.env.KUESTER_EMAIL;
  const password = process.env.KUESTER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Set KUESTER_EMAIL and KUESTER_PASSWORD environment variables before running this script.'
    );
  }

  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  await page.locator('#UserName').fill(process.env.KUESTER_EMAIL);
  await page.locator('#Password').fill(process.env.KUESTER_PASSWORD);
  await page.locator('#btnLogin').click();

  // Wait for the dashboard to load (adjust if your account lands elsewhere)
  await page.waitForSelector('text=Welcome,', { timeout: 15000 }).catch(() => {
    // Some accounts may skip the welcome banner; fall back to nav check
  });
}

async function goToArcReview(page) {
// 2. Hover over "Committees and Board" to reveal the submenu (don't click it)
  await page.locator('a[href*="committees-and-board"]').hover();

// 3. Now click the revealed "Architectural Review" link
  await page.getByText(/architectural review/i).waitFor({ state: 'visible' });
  await page.getByText(/architectural review/i).click();

  // Make sure we're on Open/Pending (this is the default, but be explicit)
  const openPending = page.getByRole('radio', { name: 'Open/Pending' });
  if (await openPending.isVisible()) {
    await openPending.check();
  }

  // Advanced Search toggle
  await page.click('span.slider.round');
  await page.waitForSelector('input[name="RadioGroup2"][value="2"]', { state: 'visible' });

// "Between" radio
  await page.check('input[name="RadioGroup2"][value="2"]');
  await page.waitForSelector('#StartDate:not([disabled])');

// Dates
  await page.fill('#StartDate', '2026-07-15');   // ← your fixed start date, YYYY-MM-DD
  await page.fill('#EndDate', new Date().toISOString().split('T')[0]);  // today

  const refreshBtn = page.getByRole('button', { name: 'Refresh' });
  if (await refreshBtn.isVisible()) {
    await refreshBtn.click();
    await page.waitForTimeout(1000);
  }
}

async function listRequests(page) {
  // DevExpress grid: data cells are GridBoardACCList_tccell{row}_{col}.
  // Enumerate rows via the homeowner cells (col 1), then read siblings by id.
  const homeownerCells = page.locator('[id^="GridBoardACCList_tccell"][id$="_1"]');
  const count = await homeownerCells.count();
  const results = [];

  for (let i = 0; i < count; i++) {
    const id = await homeownerCells.nth(i).getAttribute('id');
    const rowNum = id.match(/tccell(\d+)_1$/)[1];

    const cellText = async (col) => {
      const cell = page.locator(`#GridBoardACCList_tccell${rowNum}_${col}`);
      return (await cell.count()) ? (await cell.first().innerText()).trim() : '';
    };

    results.push({
      index: Number(rowNum),
      homeowner: await cellText(1),
      address: await cellText(2),
      requestType: await cellText(3),
      status: await cellText(4),
      requestedOn: await cellText(5),
      sentToCommittee: await cellText(6),
      committeeResponse: await cellText(8),
      detailsId: await page
        .locator(`#GridBoardACCList_DXDataRow${rowNum} [id^="btnBACCDetail"]`)
        .first()
        .getAttribute('id')
        .catch(() => null),
    });
  }
  return results;
}
/*opens the modal for one request, WORK IN PROGRESS */
async function openDetailsForRow(page, detailsId) {
  await page.locator(`#${detailsId}`).click();
  await page.waitForSelector('input[value="Close"][onclick="ClosePop()"]', {
    state: 'visible',
    timeout: 15000,
  });
}
/*reads the labeled fields */
async function extractDetailFields(page) {
  // Labeled rows in the modal: Homeowner, Address, ACC Type, Status,
  // Request Date, Sent to Committee Date, Auto Approval Date, Committee Response Date
  const labels = [
    'Homeowner',
    'Address',
    'ACC Type',
    'Status',
    'Request Date',
    'Sent to Committee Date',
    'Auto Approval Date',
    'Committee Response Date',
  ];

  const fields = {};
  for (const label of labels) {
    try {
      const row = page.locator(`text=${label}`).first().locator('xpath=..');
      const text = (await row.innerText()).replace(label, '').trim();
      fields[label] = text;
    } catch {
      fields[label] = null;
    }
  }
  return fields;
}

async function extractNotes(page) {
  // The Notes table has columns: Date | Type | Author | Note
  const notesHeading = page.getByText('Notes', { exact: true });
  const notesSection = notesHeading.locator('xpath=following::table[1]');
  const rows = notesSection.locator('tr');
  const count = await rows.count();
  const notes = [];

  for (let i = 0; i < count; i++) {
    const cells = await rows.nth(i).locator('td').allInnerTexts();
    if (cells.length >= 4) {
      notes.push({
        date: cells[0].trim(),
        type: cells[1].trim(),
        author: cells[2].trim(),
        note: cells[3].trim(),
      });
    }
  }
  return notes;
}
async function downloadAttachments(page, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  // Switch to List view — by id, forced (styled-label overlay)
  const listToggle = page.locator('#rdListView');
  if (await listToggle.count()) {
    await listToggle.check({ force: true });
    await page.waitForTimeout(750);
  }

  // Each download icon's onclick is downloadBoardACCAttachment(<id>).
  // Icons render twice in this grid, so de-dupe the IDs.
  const rawIds = await page.locator('i.fa.fa-download').evaluateAll((els) =>
    els
      .map((el) => el.getAttribute('onclick')?.match(/downloadBoardACCAttachment\((\d+)\)/)?.[1])
      .filter(Boolean)
  );
  const ids = [...new Set(rawIds)];
  console.log(`  ${ids.length} unique attachment(s)`);

  const context = page.context();
  const savedFiles = [];

  // Download each attachment by invoking the site's own function.
  for (const id of ids) {
    try {
      const downloadPromise = context.waitForEvent('download', { timeout: 10000 });
      await page.evaluate((attId) => downloadBoardACCAttachment(Number(attId)), id);
      const download = await downloadPromise;
      const filename = download.suggestedFilename() || `attachment-${id}.pdf`;
      await download.saveAs(path.join(destDir, filename));
      savedFiles.push(filename);
      console.log(`  ✓ ${filename}`);
    } catch (err) {
      console.warn(`  ! ID ${id} produced no download (${err.message})`);
    }
  }

  // Filter out Letter_* files by their real saved filename.
  const kept = [];
  for (const f of savedFiles) {
    if (/^letter/i.test(f.trim())) {
      fs.unlinkSync(path.join(destDir, f));
      console.log(`  – Deleted "${f}" (Letter file)`);
    } else {
      kept.push(f);
    }
  }

  return kept;
}
/*writes notes.md */
function writeNotesMarkdown(destDir, fields, notes, attachmentFiles) {
  let md = `# ARC Request — ${fields['Homeowner'] || 'Unknown'}\n\n`;
  md += `| Field | Value |\n|---|---|\n`;
  for (const [k, v] of Object.entries(fields)) {
    md += `| ${k} | ${v || ''} |\n`;
  }

  md += `\n## Attachments Downloaded\n`;
  if (attachmentFiles.length) {
    for (const f of attachmentFiles) md += `- ${f}\n`;
  } else {
    md += `_No attachments downloaded._\n`;
  }

  md += `\n## Committee / Management Notes\n\n`;
  md += `| Date | Type | Author | Note |\n|---|---|---|---|\n`;
  for (const n of notes) {
    md += `| ${n.date} | ${n.type} | ${n.author} | ${n.note.replace(/\|/g, '\\|')} |\n`;
  }

  fs.writeFileSync(path.join(destDir, 'notes.md'), md, 'utf-8');
}
/*Close modal before next request */
async function closeDetailModal(page) {
  await page.click('input[value="Close"][onclick="ClosePop()"]');
  // Wait for the Close button to disappear, confirming the modal is gone.
  await page.waitForSelector('input[value="Close"][onclick="ClosePop()"]', {
    state: 'hidden',
    timeout: 10000,
  });
}
/*uses all above functions to process ONE request */
async function processRequest(page, target) {
  console.log(`\nOpening details for: ${target.homeowner} (${target.address})`);
  await openDetailsForRow(page, target.detailsId);

  const fields = await extractDetailFields(page);
  const notes = await extractNotes(page);

  const destDir = path.join(OUTPUT_ROOT, slugify(target.homeowner || `row-${target.index}`));
  const attachDir = path.join(destDir, 'attachments');

  console.log('Downloading attachments...');
  const savedFiles = await downloadAttachments(page, attachDir);

  writeNotesMarkdown(destDir, fields, notes, savedFiles);

  console.log(`  Saved to: ${destDir} (${savedFiles.length} attachment(s))`);
  return destDir;
}

async function main() {
  const opts = parseArgs();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    console.log('Logging in...');
    await login(page);

    console.log('Navigating to ARC Review...');
    await goToArcReview(page);
    console.log('Advanced Search Complete.');

    console.log('Listing open/pending requests...');
    const requests = await listRequests(page);

    // --list: just print the rows and exit.
    if (opts.list) {
      console.log(`\nFound ${requests.length} open/pending request(s):\n`);
      requests.forEach((r) => {
        console.log(`[${r.index}] ${r.homeowner} — ${r.address} — ${r.requestType} — ${r.status}`);
      });
      console.log('\nRe-run with --row <n> or --homeowner "<name>" for one, or no args to process all.');
      return;
    }

    if (opts.homeowner || opts.row !== undefined) {
      // Single request
      let target;
      if (opts.homeowner) {
        const normalize = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const needle = normalize(opts.homeowner);
        target = requests.find((r) => normalize(r.homeowner).includes(needle));
        if (!target) throw new Error(`No open request found matching homeowner "${opts.homeowner}"`);
      } else {
        target = requests[opts.row];
        if (!target) throw new Error(`No request at row index ${opts.row}`);
      }
      await processRequest(page, target);
      console.log('\nDone.');
      console.log('\nNext step: open a Claude chat with the arc-review-assistant skill enabled and upload the folder.');
      return;
    }

    // No target given: process ALL open/pending requests.
    if (requests.length === 0) {
      console.log('\nNo open/pending requests found. Nothing to process.');
      return;
    }

    console.log(`\nProcessing all ${requests.length} open/pending request(s)...`);
    const done = [];
    const failed = [];

    for (const target of requests) {
      try {
        await processRequest(page, target);
        done.push(target.homeowner);
        await closeDetailModal(page);
      } catch (err) {
        console.warn(`  ! Failed "${target.homeowner}": ${err.message}`);
        failed.push(target.homeowner);
        await closeDetailModal(page).catch(() => {});
      }
    }

    console.log(`\nDone. Processed ${done.length} of ${requests.length} request(s).`);
    if (failed.length) console.log(`  Failed: ${failed.join(', ')}`);
    console.log('\nNext step: open a Claude chat with the arc-review-assistant skill enabled and upload the folders.');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});