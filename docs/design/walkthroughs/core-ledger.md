# Walkthrough: the core ledger (v0.1.0)

This walks through Fiscus as it is at v0.1.0. It covers first run, accounts, importing, the
transactions list, the review queue, rules, transfers, and inviting people. Each journey shows
its screens, what works, and what gets in the way. Monarch is the reference: what to keep, and
what Fiscus should do better. The gap list at the end ranks the problems and maps them to issues.
That ranking sets the order of work for M1.5 (#337).

When these screens change, this becomes their user guide.

**About the screenshots.** They show an invented household, the Riveras: Alex and Sam, with
checking, a credit card, savings, a holiday fund, and a brokerage account. All names and amounts
are made up. To regenerate the images after a UI change, run `pnpm walkthrough`. It builds this
checkout, starts a throwaway stack, runs `apps/web/walkthrough/core-ledger.spec.ts`, and removes
the stack.

Findings are numbered (**F1**, **F2**, …) and collected in the [gap list](#gap-list).

---

## 1. First run

1. The server's first person creates the admin account with the one-time setup token from the logs.
2. They name the household and say who it's for. With **Me and others**, they also choose how money
   is handled together.
3. They land on the dashboard.

| Setup | Create the household | Landing |
|---|---|---|
| ![Setup](core-ledger/01-setup.png) | ![Create household](core-ledger/02-welcome.png) | ![Empty dashboard](core-ledger/03-dashboard-empty.png) |

**Works.** Two short screens, each explaining itself. The finance-style question only appears for
households of more than one person. The time zone comes from the device.

**Gets in the way.**
- **F1.** You land on an empty dashboard: $0 net worth, and "No transactions in this range yet. Add
  some." Nothing suggests the obvious next steps: add or import accounts, invite your partner,
  review what came in.
- **F2.** The sidebar lists Budget, Goals, Planning, Reports, Investments, and Bills & recurring.
  None are built yet, and each opens an "on the way" page. It's six dead ends in the main
  navigation.
- ~~**F3.**~~ *Fixed in #350.* The dashboard has two time controls that don't agree: the page's range (Last 6 months)
  and net worth's own (1Y). Cash flow lists the months before your first transaction as rows of
  "No data".

---

## 2. Accounts

1. **Accounts** starts with an explanation and one **Add account** button. It asks how: enter the
   account yourself, or import from Monarch or a bank file.
2. Entering it yourself needs a name, a type, and optionally today's balance.
3. You land on the new account's page.

| Empty | Add account asks how | Enter it yourself | The new account |
|---|---|---|---|
| ![No accounts yet](core-ledger/04-accounts-empty.png) | ![Add account menu](core-ledger/05-add-account-menu.png) | ![Add account](core-ledger/06-add-account-dialog.png) | ![New account](core-ledger/07-account-detail-new.png) |

After an import, accounts are grouped by type (Cash, Credit cards, Investments) with a total for
each, under net worth.

| Accounts | An account |
|---|---|
| ![Accounts](core-ledger/14-accounts-list.png) | ![Brokerage](core-ledger/15-account-detail.png) |

**Works.** One button that asks how. Plain-language types ("Cash (checking, savings)"). Grouping by
type, with totals.

**Gets in the way.**
- ~~**F4.**~~ *Fixed in #350.* A new account says "No transactions match.", which reads like a filter hiding something.
  It offers no way to add a transaction or import a file from there.
- **F5.** The account page shows its transactions. Its balance history sits behind the **Balances**
  tab, so the Brokerage page shows one $1,000 contribution under a $25,900 balance with no chart.
  The accounts list shows no change over time and no "updated" date. The net worth chart is small,
  and flat where there's little history. Monarch puts the balance chart at the top of every
  account, and shows each account's change on the list.

---

## 3. Importing from Monarch

1. **Source.** Monarch or a bank file. For Monarch, it says where to find the export, and takes
   the Transactions file, the Balances file, or both.
2. **Accounts.** Each account in the file becomes a new account, goes into an existing one, is
   combined with another, or is left out. Accounts whose names say their type are ready, and an
   account that ended at zero is offered as closed.
3. **Categories.** Matching names are matched. The rest map to one of yours, or become new
   categories with a kind (spending, income, transfer).
4. **Review.** Per account: new rows, already imported, possible duplicates, and balances. Then the
   new categories, and the transfers it will link.
5. **Import.** It reports what was imported, and offers review and undo.

| Source | Files read | Accounts | Categories |
|---|---|---|---|
| ![Import](core-ledger/08-import-start.png) | ![Files](core-ledger/09-import-files.png) | ![Accounts](core-ledger/10-import-accounts.png) | ![Categories](core-ledger/11-import-categories.png) |

| Review | Done |
|---|---|
| ![Review](core-ledger/12-import-preview.png) | ![Imported](core-ledger/13-import-done.png) |

**Works.** Nothing is saved until the last step, and the whole import can be undone. The export
instructions sit next to the drop zone. Transfers within the file are linked as it imports, and the
review step says so. Importing the same file again adds nothing.

**Gets in the way.**
- ~~**F6.**~~ *Fixed in #350.* The steps change from four to five once Monarch is chosen (Categories appears). It's
  small, but the progress bar shifts under you.
- ~~**F7.**~~ *Fixed in #350.* When every account looks right, the account list is hidden behind **Show**. That's fast,
  but you can't see at a glance what's about to be created, and as which type.
- ~~**F8.**~~ *Fixed in #350.* The last step says **Review 2 transactions**, while the sidebar badge says **6**. The
  badge also counts the 4 transfers to check, and nothing on this screen mentions them.
- ~~**F9.**~~ *Fixed in #350.* "imported into 6 accounts in 0s". Under a second reads oddly as "0s".
- ~~**F10.**~~ *Fixed in #42: bank-file names are cleaned as they arrive ("BEAN THERE CAFE" becomes "Bean There Cafe"), the bank's text stays the original, and Rules offers to clean up older names, with a preview and Undo. A household setting turns it off.* Names stay as the bank wrote them. "BEAN THERE CAFE" (from the bank file) sits next to
  "Bean There" (from Monarch), and every list shows the difference.

### A bank or card statement

The columns are guessed from the headers and data, and the first rows show how they read. Lines
that can't be read are listed with the reason, and are left out.

| Match the columns | Review |
|---|---|
| ![Columns](core-ledger/16-csv-columns.png) | ![Review](core-ledger/17-csv-preview.png) |

**Works.** Live reading of the first rows. The day/month question is asked only when the file
can't settle it. The mapping can be saved for the bank's next file.

---

## 4. Transactions

The list is grouped by day. Each row shows the name, account, category, and amount, and a
**Review** badge when it needs a look. The category is a picker on the row: choose one and it's
saved, with **Undo** in the toast, and a rule suggestion if one fits. Filters (time range, account, needs review) sit behind one
button. **Add** asks how: enter a transaction, or import a file.

| Desktop | Category from the row | Phone | Phone filters |
|---|---|---|---|
| ![Transactions](core-ledger/18-transactions.png) | ![Row category](core-ledger/18b-row-category.png) | <img src="core-ledger/19-transactions-phone.png" width="260" alt="Transactions on a phone"> | <img src="core-ledger/20-filters-phone.png" width="260" alt="Filters on a phone"> |

Opening a row shows the drawer: name, category, date, tags, notes, review state, and actions
(make a rule, move to another account, link as a transfer, split). Each change saves as you make
it; text fields save when you leave them. Changing a category offers a rule for next time, and
marks the transaction reviewed (a household setting, on by default).

| Add asks how | The drawer | Rule suggestion | Split |
|---|---|---|---|
| ![Add](core-ledger/21-add-menu.png) | ![Drawer](core-ledger/22-drawer.png) | ![Rule suggestion](core-ledger/23-rule-suggestion.png) | ![Split](core-ledger/24-split.png) |

**Works.** The rule suggestion appears right after a correction, worded as the rule itself. Notes
come in two kinds: shared, and only-you. Splits must add up before they save. The phone header is
compact, and filters show as removable chips.

**Gets in the way.**
- ~~**F11.**~~ *Fixed in #351.* The list is spacious: about eight rows fit on a laptop screen.
  Monarch's list is a dense table (date, merchant, category, account, amount) where 15–20 rows fit,
  and it can be sorted. The compact density setting helps, but it's in Personal settings, where few
  people will look. Now a desktop shows a table sortable by each column, with the density choice
  beside the search.
- ~~**F12.**~~ *Fixed in #349.* Recategorizing took four steps: open the drawer, open the category
  list, pick one, then **Save changes**. In Monarch you click the category on the row and pick one.
  Now Fiscus works the same way.
- ~~**F13.**~~ *Fixed in #349.* Every edit in the drawer waited for **Save changes**, and
  forgetting to save lost the edit. Each field now saves as it changes, as in Monarch.
- ~~**F14.**~~ *Fixed in #349.* Setting a category didn't mark the transaction reviewed. Deciding
  the category is usually the review, so now it does, unless the household turns that off.
- ~~**F15.**~~ *Fixed in #350.* **Split** sits at the bottom of the drawer, below both notes. The other actions (rule,
  move, link) are at the top. A new split starts as two equal halves in the same category, so both
  parts usually need changing.
- ~~**F16.**~~ *Fixed in #350.* On a phone, long account names wrap a row onto three lines, and the Review badge drops
  to a line of its own.

---

## 5. The review queue

**Review** goes through new and flagged transactions oldest first: the list on the left, the
transaction on the right. Keys work through it: `c` for category, `r` to mark reviewed and move
on.

![Review](core-ledger/25-review.png)

**Works.** Oldest first, and one key per decision. Transfers are a second tab of the same page.

**Gets in the way.**
- ~~**F17.**~~ *Fixed in #350.* The keys are listed above the queue, but only on wide screens. The transaction pane
  repeats the category picker that the bar above it already has. (Since #349, choosing a category
  here also completes the review and moves to the next transaction.)
- (F8 again) The sidebar badge adds transactions and transfers, so it matches neither tab. Since
  #350, the import's last step offers both: **Review N transactions** and **Check N transfers**.

---

## 6. Rules

A rule has conditions (description text, money in or out, amount, account, current category) and
actions (rename, set category, add tags, treat as a transfer to an account). While you type, the
editor previews how many transactions it would change, and applies the rule to them as it's saved
unless you untick that. Rules run top to bottom, and never undo what a person set.

| Editor | Rules |
|---|---|
| ![Rule editor](core-ledger/26-rule-editor.png) | ![Rules](core-ledger/27-rules-list.png) |

**Works.** A live preview while you write the rule. Each rule reads as a sentence on the list.
"Apply to existing" shows exactly what would change first.

**Gets in the way.**
- ~~**F18.**~~ *Fixed in #350.* Applying a rule to past transactions is a separate step after creating it; a toast says
  so. Monarch asks in the editor, with a count ("Apply to 12 existing transactions").
- **F19.** The editor shows every condition and action at once, which makes for a long dialog for
  "if it says X, call it Y". Most rules use one condition and one or two actions.
- ~~**F20.**~~ *Better since #42: rule suggestions still match the bank's text, but names read as names.* Suggested rules use the bank's raw text ("When the description contains “CORNER
  HARDWARE”"). That's correct, but loud. It goes away with merchant cleanup (F10).

---

## 7. Checking transfers

The **Transfers** tab of Review lists:
- **Suggested pairs:** money out of one account, and the same amount into another, that Fiscus
  didn't link on its own. A reason is given under each.
- **No other side:** transfers over a week old with nothing to match.

When the names point to one candidate, it's labeled **Likely**. Linking one pair settles any pair
it decides. Here, linking Holiday Fund → High-Yield Savings also linked Joint Checking →
High-Yield Savings.

| Before | After one Link |
|---|---|
| ![Transfer review](core-ledger/29-transfer-review.png) | ![After](core-ledger/30-transfer-review-after.png) |

**Works.** Every suggestion says why it wasn't linked automatically. Linked pairs leave at once.

**Gets in the way.** These are tracked in #332: what to do with very large lists, bulk-confirming
the **Likely** pairs, and saying how many other pairs a link settled.

---

## 8. People

The household menu (the name at the top left) has **Invite someone**, Household settings, and
Create household. An invite is an email address and a role, and it makes a one-time link to send.
The person creates their account from the link, or signs in, and joins. With two people in the
household, the dashboard gets the **Mine / Sam / Ours / All** lens, and **Shared costs** appears
in the sidebar.

| Household menu | Invite | The link |
|---|---|---|
| ![Menu](core-ledger/31-household-menu.png) | ![Invite](core-ledger/32-invite-dialog.png) | ![Link](core-ledger/33-invite-link.png) |

| Joining (phone) | A used link | Household settings | The lens |
|---|---|---|---|
| <img src="core-ledger/34-join-household-phone.png" width="220" alt="Join The Riveras"> | ![Invite not valid](core-ledger/37-invite-used.png) | ![Settings](core-ledger/35-household-settings.png) | ![Dashboard with lens](core-ledger/36-dashboard.png) |

The server's admin can also invite someone to make an account and start their own household.
That's **Server** in the account menu.

![Server](core-ledger/38-server.png)

**Works.** The invite link works on a phone, works once, and shows which household and role it's
for. The lens appears only once there's someone to share with.

**Gets in the way.**
- ~~**F21.**~~ *Fixed in #352.* Household settings is one long page: general settings, how you
  appear, members, and every category, over 2,400 pixels tall. Categories, which people edit most,
  are at the bottom. Monarch splits settings into sections. Now it has sections, each at its own
  URL: General, Members, Categories, and Rules (moved from Transactions).
- ~~**F22.**~~ *Fixed in #350.* **Household settings** is in two places: the household menu, and the bottom of the
  sidebar.
- ~~**F23.**~~ *Fixed in #350.* The new-password field states the rules twice: as a sentence, then as the checklist.

---

## Gap list

Impact: how often people hit it, and how much it costs them. **High** means daily or in every
import. **Medium** means it confuses or slows down a common task. **Low** is polish.

| # | Problem | Impact | Proposal | Issue |
|---|---|---|---|---|
| F12 | Recategorizing takes four steps | High | Category picker on the row itself, on desktop and phone | Fixed (#349) |
| F13 | Drawer edits wait for Save | High | Save each field as it changes, with undo in the toast | Fixed (#349) |
| F14 | Categorizing doesn't mark reviewed | Medium | Setting a category marks it reviewed, as a household setting (on by default) | Fixed (#349) |
| F10, F20 | Bank-formatted names | High | Merchant cleanup | Fixed (#42) |
| F11 | Low list density | Medium | A dense, sortable table on desktop; make the density choice visible on the list | Fixed (#351) |
| F8, F17 | Counts that don't agree; review pane repeats the category | Medium | Separate badges, or "4 + 4 transfers"; the import's last step offers "Check 4 transfers"; one category picker in the review pane | Fixed (#350) |
| F18 | Applying a rule to past transactions is a second step | Medium | "Also apply to N existing" checkbox in the editor | Fixed (#350) |
| F21 | One long settings page | Medium | Sections: General, Members, Categories, Rules (moved from Transactions) | Fixed (#352) |
| F2 | Six unbuilt sections in the navigation | — | Keep them: they show what Fiscus will have | Won't change |
| F1 | Empty landing after setup | Medium | A first-run checklist on the dashboard (accounts, partner, review) until it's done | #354 |
| F5 | No balance chart on account pages | Medium | Chart at the top of the account page; change and "updated" on the list | #353, with #48 |
| F15 | Split is hard to find, and starts as two halves | Low | Split with the other actions; the second part takes the rest, uncategorized | Fixed (#350) |
| F4 | "No transactions match" on a new account | Low | "No transactions yet", with Add and Import | Fixed (#350) |
| F3 | Two time controls; empty months on the dashboard | Low | Net worth follows the page range; start cash flow at the first transaction | Fixed (#350) |
| F6, F7, F9 | Import step count shifts; accounts hidden; "0s" | Low | Fixed step list; show the accounts collapsed by default; "in under a second" | Fixed (#350) |
| F16 | Phone rows wrap to three lines | Low | Truncate the account name; badge on the amount line | Fixed (#350) |
| F19 | Long rule editor | Low | Start with one condition and one action; "Add condition" for more | #355 |
| F22, F23 | Settings twice; password rules twice | Low | One entry each | Fixed (#350) |
| — | Transfer review at scale | Medium | | #332 |

## Proposed order for M1.5

1. ~~**Faster transaction editing** (F12, F13, F14).~~ Done in #349.
2. ~~**Quick wins** (F3, F4, F6–F9, F15–F18, F22, F23).~~ Done in #350.
3. ~~**Merchant cleanup** (#42, F10, F20).~~ Done in #42.
4. ~~**Transactions table** (F11), once editing is fast.~~ Done in #351.
5. ~~**Settings sections** (F21)~~ (done in #352) and **account page chart** (F5, with #48 account groups).
6. **Transfer review follow-ups** (#332).
7. Then the rest of M1.5, as planned: edit history (#46), OFX and YNAB/Actual imports (#74, #76),
   multi-currency (#43), member-scoped rules (#58), member leaving (#62), and so on.

## Decisions

- **F2:** unbuilt sections stay in the navigation: they show what's coming. Each opens a page
  saying so.
- **F13:** the drawer saves as you go, as Monarch's does.
- **F14:** setting a category counts as reviewing it. It's a household setting, on by default.
