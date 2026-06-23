# EFRISConnect – Test Plan

All tests run against `http://localhost:3000` (local) or `https://goods.twoservants.com` (cloud).  
Server started with: `$env:EFRIS_PRIVATE_KEY="F:\EFRIS_Keys\efris_private_v2.pem"; node server.js`  
EFRIS Sandbox: efristest.ura.go.ug

---

## T1 – Health & Connectivity

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T1.1 | Health check | GET `/api/health` | `{"status":"ok"}` + key present indicator |
| T1.2 | EFRIS connection test | Settings → Test EFRIS Connection | "✅ Connected to URA EFRIS Sandbox" |
| T1.3 | Manager.io connection | Settings → Test Manager | "✅ Connected to Manager" with endpoint auto-detected |
| T1.4 | TIN verification | Status tab → Enter any valid TIN → Verify | Taxpayer name returned |
| T1.5 | My Details | Status tab → My Details | Own business name + address returned |

---

## T2 – Settings & Configuration

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T2.1 | Save config | Settings → fill all fields → Save | Config persists on page reload |
| T2.2 | Mode toggle | Settings → toggle Sandbox/Production | URL in subsequent calls changes accordingly |
| T2.3 | Internal API key | `/api/health` without `x-api-key` header | 401 Unauthorized |
| T2.4 | Invalid EFRIS creds | Wrong password in config → Test Connection | "❌ Unauthorized" or clear error |

---

## T3 – Goods / Commodity Configuration (Goods Tab)

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T3.1 | Segment browse | Goods → type segment letter | Filtered list appears |
| T3.2 | Hierarchy drill-down | Select Segment → Family → Class → Commodity | Each level loads child options |
| T3.3 | Commodity select | Click a commodity in list | Details pane populated with code + name |
| T3.4 | Measure units load | Goods → New Item → Unit dropdown | Dropdown populated from T115 |
| T3.5 | Register goods (T130) | Fill item form → Register to EFRIS | rc 00 or rc 45 returned; item appears in search |
| T3.6 | Search goods (T130) | Goods → Search → enter product name | Table of results; "→ Stock-in" button per row |
| T3.7 | Sync to Manager | After register → Write to Manager | Item created in Manager with EFRIS custom fields |
| T3.8 | Manager items list | Goods → Manager Items | Table of existing items from Manager |

---

## T4 – Stock-in (T131)

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T4.1 | Pre-fill via search | Search → click "→ Stock-in" | Stock-in pane opens; item code/unit/price pre-filled |
| T4.2 | Manual stock-in | Goods → Stock In → fill Item Code, Qty, Unit, Price → Submit | rc 00; no "operationType:cannot be empty!" error |
| T4.3 | Date format | Submit with date from date picker | Server sends `"2026/06/23"` (slashes) not dashes |
| T4.4 | Opening stock | stockInType = 104 (Opening Stock) | Accepted by EFRIS |
| T4.5 | Local purchase | stockInType = 102 (Local Purchase), fill Supplier Name | Accepted |
| T4.6 | Multiple items | Add 2+ item rows → Submit | All items in stockInItem array, each with operationType:'101' |
| T4.7 | Invalid goods code | Blank item code → Submit | Validation error before EFRIS call |

---

## T5 – Invoice Submission (Submit Tab – T109)

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T5.1 | Load invoice from Manager | Submit tab → paste invoice key → Load | Invoice lines, total, customer populated |
| T5.2 | B2C submission | Customer type B2C, no TIN → Submit | FDN returned; status changes to "Submitted" |
| T5.3 | B2B submission | Enter customer TIN → Verify TIN → Submit | TIN resolved to name; FDN returned |
| T5.4 | Foreign currency | FX invoice → fetch rate → Submit | Rate applied; UGX equivalent correct |
| T5.5 | Preview (dry-run) | Submit → Preview | Returns EFRIS preview without committing |
| T5.6 | Save FDN to Manager | After submit → Save to Manager | FDN stored in Manager custom field |
| T5.7 | Duplicate submission | Submit same invoice twice | EFRIS returns duplicate error; UI shows warning |
| T5.8 | Credit note | Submit tab → Credit Note → select reason → Submit | T108 rc 00; credit note FDN returned |

---

## T6 – Walk-in Receipt (Issue Receipt Tab)

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T6.1 | Add line items | Issue Receipt → Add Line → fill desc, qty, price | Subtotals recalculate |
| T6.2 | Add payment | Add Payment → select Cash/Mobile Money | Payment rows sum correctly |
| T6.3 | Item autocomplete | Start typing item name | Catalog suggestions appear |
| T6.4 | Submit receipt | Fill all → Submit | FDN returned; receipt URL generated |
| T6.5 | Print receipt | After submit → Print (no EFRIS) | Receipt page opens without ERR_CONNECTION_CLOSED |
| T6.6 | Open EFRIS receipt | After submit → Open Receipt | Valid EFRIS receipt URL opens |
| T6.7 | B2G walk-in | Set customer type B2G → enter TIN | TIN validated before submit |

---

## T7 – Bulk Submit (Bulk Tab)

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T7.1 | Load invoice list | Bulk → Load | Pending invoices listed |
| T7.2 | Bulk submit | Select 2+ invoices → Start | Each processed; progress shown |
| T7.3 | Partial failure | One invoice with bad data in batch | Failed items flagged; others succeed |
| T7.4 | Clear results | Bulk → Clear | Results table resets |

---

## T8 – History (History Tab)

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T8.1 | Load history | History tab | Submission log table with FDN, date, status |
| T8.2 | Search/filter | Enter invoice number | Filtered rows |
| T8.3 | Delete entry | Click delete on a row → confirm | Row removed; GET log no longer has it |
| T8.4 | Pagination | If >20 entries, navigate pages | Correct page loads |

---

## T9 – Number Series (Numbers Tab)

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T9.1 | Create series | Numbers → New → fill prefix, start, step → Save | Series appears in list |
| T9.2 | Preview next | Preview | Shows formatted next number |
| T9.3 | Generate next | Generate | Counter increments; number returned |
| T9.4 | Delete series | Delete → confirm | Series removed |

---

## T10 – FX Rates

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T10.1 | Fetch rate | Submit tab → foreign currency → Fetch FX | Rate from Bank of Uganda displayed |
| T10.2 | Rate applied | Enter amount in USD → apply rate | UGX equivalent auto-calculated |

---

## T11 – Inventory Adjust (T132)

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T11.1 | Submit adjustment | Goods → Stock Adjust → fill item, qty → Submit | rc 00 from T132 |
| T11.2 | Credit (decrease) | adjustType = decrease | Stock reduced in EFRIS |

---

## T12 – Receipt Route (Print / no EFRIS)

| # | Test | Steps | Pass Criteria |
|---|------|-------|---------------|
| T12.1 | Local receipt | GET `/receipt?key=...` on localhost | HTML receipt page renders (not ERR_CONNECTION_CLOSED) |
| T12.2 | Cloud receipt | GET `/receipt?key=...` on goods.twoservants.com | Same; requires cloud container running |

---

## Known Bugs to Retest

| Bug | Expected after fix |
|-----|--------------------|
| T131 `operationType:cannot be empty!` (rc 2076) | rc 00 after root-level `operationType:'101'` restored |
| T130 "Partial failure!" (rc 45) | Treated as success; items returned |
| T130 "Illegal json format!" | Fixed by wrapping payload as array |
| Receipt ERR_CONNECTION_CLOSED (cloud) | Cloud container needs restart |
| "→ Stock-in" button no-op when goodsCode blank | `stkPreFill` falls back to goodsName |

---

## Test Execution Order (Recommended)

1. T1.1 → T1.3 (basic connectivity)  
2. T2.1 (save config)  
3. T3.4 → T3.6 (measure units + goods search)  
4. T4.2 (manual stock-in – the main bug under test)  
5. T4.1 (stock-in via "→ Stock-in" button)  
6. T5.1 → T5.2 (load + submit invoice)  
7. T6.1 → T6.5 (walk-in receipt + print)  
8. T8.1 (history after submissions)  
9. T12.1 (receipt route local)
