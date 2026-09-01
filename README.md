# Kuester ARC Scraper

Logs into the Kuester Management portal, opens the ARC Review queue, and pulls
the full detail (fields, committee notes, and attachments) for a chosen
homeowner request — saved locally so it can be handed to the
`arc-review-assistant` Claude skill for analysis.

**This script only reads and downloads. It never writes notes, decisions, or
anything else back into Kuester.** Posting the AI-generated summary back into
the "Add New Committee Note/Recommendation" box is a manual, deliberate step —
copy/paste it yourself after reviewing.

## Setup

```bash
npm install
npx playwright install chromium   # first time only, downloads the browser binary
```

## Credentials

Never hardcode your Kuester login. Set it as environment variables for the
duration of the command only:

```bash
export KUESTER_EMAIL="you@example.com"
export KUESTER_PASSWORD="your-password"
```

Better: use a `.env` file that's git-ignored, or your OS keychain / a secrets
manager, and load it into the shell session rather than typing the password
inline in a command you'll re-run from shell history.

## Usage

**1. See what's open:**
```bash
node fetch-arc-requests.js --list
```
Prints every open/pending request with its row index, homeowner, address,
type, and status.

**2. Pull full details for one request:**
```bash
node fetch-arc-requests.js --homeowner "Jane Doe"
# or
node fetch-arc-requests.js --row 1
```

This will:
- Open that request's detail modal
- Scrape the field table (ACC type, status, dates, etc.)
- Scrape the full Notes table (committee notes, management notes, authors, dates)
- Switch attachments to List view and download every file
- Write everything to `./output/<homeowner-slug>/`:
  - `notes.md` — fields + notes table, formatted for easy reading
  - `attachments/` — every downloaded document

## Handing off to the ARC review skill

Once a folder is populated:

1. Open a Claude.ai chat with the `arc-review-assistant` skill enabled
2. Upload `notes.md` and everything in `attachments/`
3. Ask Claude to review the request per the skill's workflow

Claude will apply the document hierarchy, red-flag checks, and Step 0 location
verification from `SKILL.md`, then generate the owner letter, internal
committee notes, and concise summary.

## Notes on fragility

The selectors here are based on screenshots of the portal, not live DOM
inspection, so a few things are written defensively (text-based locators
rather than CSS classes) but may still need small tweaks if:

- The modal's Notes table structure differs slightly from what's scraped
- The Attachments "List" view has different column ordering
- Kuester changes the login flow or nav labels

If a run fails, run with `--list` first to confirm login + navigation work,
then narrow down which step (`extractDetailFields`, `extractNotes`, or
`downloadAttachments`) needs adjusting. Feel free to paste the error back to
Claude along with an updated screenshot of whatever step broke.
