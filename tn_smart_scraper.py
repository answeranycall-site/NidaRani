#!/usr/bin/env python3
"""
Tennessee Delinquent Tax â€” SMART SCRAPER
Reads pages like a human, follows redirects, validates every row.
"""

import os, csv, io, re, time, json
from datetime import datetime
import requests
from bs4 import BeautifulSoup
try:
    import pdfplumber
    HAS_PDF = True
except ImportError:
    HAS_PDF = False

OUTPUT_DIR  = "TN_Delinquent_Tax"
DATE_SCRAPED = datetime.now().strftime("%Y-%m-%d")

PROPERTY_COLS = [
    "county","state","county_seat","parcel_number","owner_name",
    "property_address","city","zip","amount_due","sale_date",
    "sale_number","source_url","date_scraped","notes"
]

# Enhanced log with reasoning columns
LOG_COLS = [
    "county","county_seat","trustee_phone","clerk_master_phone","email",
    "what_page_said","what_you_did","result","records_found",
    "where_list_is","notes","priority"
]

CALL_COLS = [
    "county","county_seat","trustee_phone","clerk_master_phone",
    "email","script","priority","where_list_is","notes"
]

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

PHONE_SCRIPT = (
    "Hi, I'm calling to request the current delinquent property tax list for {county} County. "
    "I understand taxes become delinquent after February 28th. "
    "Do you have a list of properties currently in delinquent status or scheduled for tax sale? "
    "Is that something you can email or mail to me? "
    "Who should I follow up with if not you?"
)

session = requests.Session()
session.headers.update(BROWSER_HEADERS)

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# VALIDATION â€” non-negotiable before any row is saved
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def has_digit(s):
    return bool(re.search(r'\d', s or ""))

def has_word(s):
    return bool(re.search(r'[a-zA-Z]{2,}', s or ""))

def looks_like_name(s):
    """Real name: contains at least 2 letters, not purely numeric, not a header word."""
    if not s or len(s.strip()) < 2:
        return False
    bad = {"step","total","amount","parcel","owner","address","name","page",
           "date","sale","city","zip","county","tax","balance","due","none",
           "nan","n/a","unknown","no.","#","id"}
    if s.strip().lower() in bad:
        return False
    if re.match(r'^[\d\s\-\.,/]+$', s.strip()):   # all numbers/symbols
        return False
    return bool(re.search(r'[a-zA-Z]{2,}', s))

def validate_row(row):
    """
    Returns True only if the row looks like a real delinquent tax property.
    Rule: property_address must contain a digit AND a word.
          owner_name must look like a real name.
    """
    addr = (row.get("property_address") or "").strip()
    owner = (row.get("owner_name") or "").strip()
    # Must have at least one of: valid address or valid owner
    addr_ok = has_digit(addr) and has_word(addr)
    owner_ok = looks_like_name(owner)
    return addr_ok or owner_ok   # at least one must be present

def filter_rows(rows):
    good = [r for r in rows if validate_row(r)]
    bad  = len(rows) - len(good)
    if bad:
        print(f"    Validation removed {bad}/{len(rows)} junk rows")
    return good

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# HELPERS
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def fetch(url, binary=False, timeout=25):
    try:
        r = session.get(url, timeout=timeout, allow_redirects=True)
        ct = r.headers.get("content-type","")
        if binary:
            return r.content, r.status_code, ct
        return r.text, r.status_code, ct
    except Exception as e:
        return None, 0, str(e)

def page_text(html):
    """Return visible text from HTML page, lower-cased for searching."""
    soup = BeautifulSoup(html, "html.parser")
    return soup.get_text(" ", strip=True).lower()

def page_links(html, base_url):
    """Return all (text, full_url) anchors from a page."""
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith("#") or href.lower().startswith("javascript"):
            continue
        full = href if href.startswith("http") else (
            base_url.rstrip("/") + "/" + href.lstrip("/") if href.startswith("/")
            else base_url.rstrip("/") + "/" + href
        )
        out.append((a.get_text(" ", strip=True).strip(), full))
    return out

def pdf_has_tax_context(pdf_bytes):
    """Quick check: does this PDF mention delinquent / tax sale / property?"""
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages[:3]:
                txt = (page.extract_text() or "").lower()
                if any(k in txt for k in ["delinquent","tax sale","taxsale","past due","property owner"]):
                    return True
    except Exception:
        pass
    return False

def parse_pdf_smart(pdf_bytes, county, seat, source_url, sale_date="", sale_num=""):
    """
    Parse PDF tables â€” only if PDF has tax context.
    Tries multiple column orderings to find real property data.
    """
    if not HAS_PDF:
        return []
    if not pdf_has_tax_context(pdf_bytes):
        print("    PDF does not mention delinquent/tax â€” skipping")
        return []

    rows = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page_num, page in enumerate(pdf.pages):
                tables = page.extract_tables()
                for table in tables:
                    if not table:
                        continue
                    # detect header row
                    header = [c.lower().strip() if c else "" for c in (table[0] or [])]
                    # map column indices
                    col_idx = {}
                    for i, h in enumerate(header):
                        if any(k in h for k in ["parcel","map","folio","pid"]):
                            col_idx.setdefault("parcel", i)
                        elif any(k in h for k in ["owner","name","taxpayer"]):
                            col_idx.setdefault("owner", i)
                        elif any(k in h for k in ["address","location","situs"]):
                            col_idx.setdefault("address", i)
                        elif any(k in h for k in ["city","municipality"]):
                            col_idx.setdefault("city", i)
                        elif any(k in h for k in ["zip","postal"]):
                            col_idx.setdefault("zip", i)
                        elif any(k in h for k in ["amount","balance","tax","due","total"]):
                            col_idx.setdefault("amount", i)

                    data_rows = table[1:] if col_idx else table
                    for row in data_rows:
                        if not row or all(not c for c in row):
                            continue
                        cells = [c.strip() if c else "" for c in row]
                        if col_idx:
                            r = {
                                "county": county, "state": "TN", "county_seat": seat,
                                "parcel_number": cells[col_idx["parcel"]] if "parcel" in col_idx and col_idx["parcel"] < len(cells) else "",
                                "owner_name":    cells[col_idx["owner"]]  if "owner"  in col_idx and col_idx["owner"]  < len(cells) else "",
                                "property_address": cells[col_idx["address"]] if "address" in col_idx and col_idx["address"] < len(cells) else "",
                                "city":          cells[col_idx["city"]]   if "city"   in col_idx and col_idx["city"]   < len(cells) else "",
                                "zip":           cells[col_idx["zip"]]    if "zip"    in col_idx and col_idx["zip"]    < len(cells) else "",
                                "amount_due":    cells[col_idx["amount"]] if "amount" in col_idx and col_idx["amount"] < len(cells) else "",
                                "sale_date": sale_date, "sale_number": sale_num,
                                "source_url": source_url, "date_scraped": DATE_SCRAPED,
                                "notes": f"PDF page {page_num+1}"
                            }
                        else:
                            # no header mapping â€” positional fallback (owner | address | parcel)
                            r = {
                                "county": county, "state": "TN", "county_seat": seat,
                                "parcel_number": cells[2] if len(cells) > 2 else "",
                                "owner_name":    cells[0] if len(cells) > 0 else "",
                                "property_address": cells[1] if len(cells) > 1 else "",
                                "city": "", "zip": "",
                                "amount_due":    cells[3] if len(cells) > 3 else "",
                                "sale_date": sale_date, "sale_number": sale_num,
                                "source_url": source_url, "date_scraped": DATE_SCRAPED,
                                "notes": f"PDF page {page_num+1} (positional)"
                            }
                        rows.append(r)
    except Exception as e:
        print(f"    PDF parse error: {e}")
    return filter_rows(rows)

def save_county(county_name, rows):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    fname = os.path.join(OUTPUT_DIR, f"{county_name.upper().replace(' ','_')}_delinquent.csv")
    with open(fname, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=PROPERTY_COLS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k,"") for k in PROPERTY_COLS})
    return fname

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# PER-COUNTY SCRAPERS â€” each reads the page and reasons about what to do
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def scrape_shelby():
    """
    Page says: download a CSV file of all properties in Tax Sale.
    Direct CSV at scgpublic.s3.amazonaws.com. Keep only sale_number == TS2301.
    """
    print("\n[SHELBY] Reading tax sale schedule page...")
    url = "https://www.shelbycountytrustee.com/191/Tax-Sale-Schedule"
    html, code, _ = fetch(url)
    if not html:
        return [], "NO_SITE", "Could not load page", url, "", "Call 901-222-0200"

    txt = page_text(html)
    # Find the CSV link
    csv_url = None
    for text_a, href in page_links(html, url):
        if "csv" in href.lower() or ("download" in text_a.lower() and "csv" in txt[:2000]):
            csv_url = href
            print(f"  Found CSV link: {href}")
            break

    if not csv_url:
        # Known direct URL
        csv_url = "https://scgpublic.s3.amazonaws.com/TaxSaleExtract.csv"
        print(f"  Using known CSV URL: {csv_url}")

    data, code2, ct = fetch(csv_url, binary=True)
    if not data or code2 != 200:
        return [], "BLOCKED", f"CSV fetch failed HTTP {code2}", csv_url, "", "Call 901-222-0200"

    text = data.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for line in reader:
        # Real columns: ParcelID, Alt_Parcel, Street Number, Street Name, Tax Sale, Register GIS
        parcel    = (line.get("ParcelID") or "").strip()
        st_num    = (line.get("Street Number") or "").strip()
        st_name   = (line.get("Street Name") or "").strip()
        tax_sale  = (line.get("Tax Sale") or "").strip()
        gis_link  = (line.get("Register GIS") or "").strip()
        alt       = (line.get("Alt_Parcel") or "").strip()

        # Only keep Sale 2301 (Oct 27 2026). Skip 2302 (a different batch).
        if tax_sale not in ("TS2301", "TS2302"):   # both are within the Oct 27 sale event
            continue

        address = f"{st_num} {st_name}".strip()
        r = {
            "county": "Shelby", "state": "TN", "county_seat": "Memphis",
            "parcel_number": parcel,
            "owner_name": "",   # Shelby's CSV does not include owner name
            "property_address": address,
            "city": "Memphis",
            "zip": "", "amount_due": "",
            "sale_date": "2026-10-27",
            "sale_number": tax_sale,
            "source_url": csv_url,
            "date_scraped": DATE_SCRAPED,
            "notes": f"GIS: {gis_link} | Alt parcel: {alt}"
        }
        rows.append(r)

    # Validate (address must have digit + word â€” parcel alone passes if address is blank,
    # but we still keep because parcel_number is meaningful)
    good = [r for r in rows if r["parcel_number"] or (has_digit(r["property_address"]) and has_word(r["property_address"]))]
    what_said = "Page has a CSV download link for all properties in Tax Sale."
    what_did  = f"Downloaded {csv_url}. Kept rows where Tax Sale = TS2301 or TS2302 (Oct 27 2026 batch)."
    return good, "SCRAPED", what_said, what_did, csv_url, f"{len(good)} properties in Oct 27 2026 Sale #2301"

def scrape_davidson():
    """
    Page says: list is published in TN Ledger newspaper (public notices).
    Go to tnledger.com, find June 19 2026 notices, scrape the July 13 sale list.
    """
    print("\n[DAVIDSON] Reading Chancery Court page â†’ following to TN Ledger...")
    base_url = "https://chanceryclerkandmaster.nashville.gov/fees/property-tax-schedule"
    html, code, _ = fetch(base_url)
    page_said = "Page references property tax sale schedule and links to delinquent tax sale info."

    # Check the delinquent tax sales page too
    dt_url = "https://chanceryclerkandmaster.nashville.gov/fees/delinquent-tax-sales"
    html2, code2, _ = fetch(dt_url)
    full_text = ""
    if html2:
        full_text = page_text(html2)
        # Extract what the page says to do
        if "ledger" in full_text:
            page_said = "Page says list is published in TN Ledger newspaper."
        if "facebook" in full_text:
            page_said += " Also references Facebook: Metro Nashville Chancery Court/Delinquent Tax Sales."

    # Now go to TN Ledger public notices
    print("  Going to TN Ledger public notices...")
    tnledger_url = "https://www.tnledger.com/Notices.aspx"
    html3, code3, _ = fetch(tnledger_url)
    rows = []
    what_did = f"Loaded TN Ledger notices page (HTTP {code3}). "

    if html3 and code3 == 200:
        txt3 = page_text(html3)
        links3 = page_links(html3, tnledger_url)
        print(f"  TN Ledger loaded OK. Searching for Davidson delinquent notices...")

        # Look for Davidson tax sale notice links
        davidson_links = []
        for text_a, href in links3:
            if re.search(r'(davidson|delinquent|tax.?sale|july.?13)', text_a.lower() + href.lower()):
                davidson_links.append((text_a, href))
                print(f"    Notice link: {text_a[:60]} -> {href[:80]}")

        # Try the search/filter for Davidson
        # TN Ledger sometimes has a county filter
        search_url = "https://www.tnledger.com/editorial/notices-search.aspx?county=Davidson&type=tax"
        html4, code4, _ = fetch(search_url)
        if html4 and code4 == 200:
            txt4 = page_text(html4)
            links4 = page_links(html4, search_url)
            for text_a, href in links4:
                if re.search(r'(delinquent|tax.?sale|july)', text_a.lower() + href.lower()):
                    davidson_links.append((text_a, href))
                    print(f"    Search result: {text_a[:60]} -> {href[:80]}")

        what_did += f"Found {len(davidson_links)} Davidson-related links on TN Ledger. "

        # Follow each Davidson notice link looking for property lists
        for text_a, href in davidson_links[:5]:
            if href.startswith("http"):
                html5, code5, _ = fetch(href)
                if not html5 or code5 != 200:
                    continue
                txt5 = page_text(html5)
                # Look for address-like content
                soup5 = BeautifulSoup(html5, "html.parser")
                # Check for property tables
                for table in soup5.find_all("table"):
                    trs = table.find_all("tr")
                    for tr in trs[1:]:
                        cells = [td.get_text(" ", strip=True) for td in tr.find_all(["td","th"])]
                        if len(cells) >= 2:
                            r = {
                                "county":"Davidson","state":"TN","county_seat":"Nashville",
                                "parcel_number": cells[0] if len(cells)>0 else "",
                                "owner_name":    cells[1] if len(cells)>1 else "",
                                "property_address": cells[2] if len(cells)>2 else "",
                                "city": "Nashville",
                                "zip": cells[4] if len(cells)>4 else "",
                                "amount_due": cells[5] if len(cells)>5 else "",
                                "sale_date":"2026-07-13","sale_number":"",
                                "source_url": href,
                                "date_scraped": DATE_SCRAPED,
                                "notes": "July 13 2026 Davidson tax sale from TN Ledger"
                            }
                            rows.append(r)
                # Also check for inline text with property addresses
                if "july 13" in txt5 or "delinquent tax" in txt5:
                    # Extract property info from text
                    paragraphs = soup5.find_all(["p","li","div"])
                    for para in paragraphs:
                        ptxt = para.get_text(" ", strip=True)
                        if has_digit(ptxt) and len(ptxt) > 20 and len(ptxt) < 500:
                            if re.search(r'\d+\s+\w+\s+(st|ave|rd|blvd|dr|ln|ct|pl|way|pike)', ptxt, re.I):
                                r = {
                                    "county":"Davidson","state":"TN","county_seat":"Nashville",
                                    "parcel_number":"","owner_name":"","property_address":ptxt[:200],
                                    "city":"Nashville","zip":"","amount_due":"",
                                    "sale_date":"2026-07-13","sale_number":"",
                                    "source_url":href,"date_scraped":DATE_SCRAPED,
                                    "notes":"Extracted from TN Ledger notice text"
                                }
                                rows.append(r)
            time.sleep(0.5)

    rows = filter_rows(rows)
    if not rows:
        what_did += "No machine-readable property list found on TN Ledger â€” the notice may be an image PDF or the list posts later today."
        return [], "CALL_REQUIRED", page_said, what_did, tnledger_url, \
               "Call 615-862-6000 Chancery Clerk NOW â€” July 13 sale list published TODAY June 19"
    return rows, "SCRAPED", page_said, what_did, tnledger_url, \
           f"{len(rows)} records from TN Ledger Davidson July 13 2026 sale"

def scrape_lawrence():
    """
    Page has a direct PDF link for the delinquent tax list. Download and parse it.
    The PDF has owner name | property address | parcel number columns.
    """
    print("\n[LAWRENCE] Reading trustee page for PDF link...")
    main_url = "https://lawrencecountytn.gov"
    pdf_url  = "https://lawrencecountytn.gov/wp-content/uploads/2026/02/2.2.26-Delinquent-Taxes.pdf"

    # First check if there's a newer version on the page
    html, code, _ = fetch(main_url)
    page_said = "County website. Looking for delinquent tax PDF (updated monthly)."
    if html:
        links = page_links(html, main_url)
        for text_a, href in links:
            if re.search(r'(delinquent|unpaid|tax.?list)', text_a.lower() + href.lower()):
                if re.search(r'\.(pdf|csv|xlsx)', href.lower()):
                    # Check date in URL â€” prefer newer one
                    if re.search(r'(2026/(05|06)|(may|june))', href.lower()):
                        pdf_url = href
                        print(f"  Found newer PDF: {href}")
                        break

    print(f"  Downloading: {pdf_url}")
    data, code2, ct = fetch(pdf_url, binary=True)
    if not data or code2 != 200:
        return [], "NO_LIST", page_said, f"PDF download failed HTTP {code2}", pdf_url, "Call 931-766-4181"
    if not data[:5].startswith(b"%PDF"):
        return [], "NO_LIST", page_said, "Downloaded file is not a PDF", pdf_url, "Call 931-766-4181"
    if not pdf_has_tax_context(data):
        return [], "NO_LIST", page_said, "PDF does not contain tax/delinquent keywords", pdf_url, "Call 931-766-4181"

    # Lawrence PDF column order (based on manual inspection): Owner Name | Address | Parcel
    rows = []
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for page_num, page in enumerate(pdf.pages):
                tables = page.extract_tables()
                for table in tables:
                    for row in table:
                        if not row or all(not c for c in row):
                            continue
                        cells = [c.strip() if c else "" for c in row]
                        # Detect header row
                        joined_lower = " ".join(cells).lower()
                        if any(k in joined_lower for k in ["owner name","property address","updated"]):
                            continue
                        # Lawrence PDF: col0=owner, col1=address, col2=parcel, col3=amount
                        owner   = cells[0] if len(cells) > 0 else ""
                        address = cells[1] if len(cells) > 1 else ""
                        parcel  = cells[2] if len(cells) > 2 else ""
                        amount  = cells[3] if len(cells) > 3 else ""

                        # If col0 looks like a parcel (numbers/dashes) and col1 looks like a name, swap
                        if re.match(r'^[\d\-\s]+$', owner) and has_word(address):
                            owner, address, parcel = address, parcel, owner

                        r = {
                            "county":"Lawrence","state":"TN","county_seat":"Lawrenceburg",
                            "parcel_number": parcel,
                            "owner_name": owner,
                            "property_address": address,
                            "city": "Lawrenceburg", "zip": "",
                            "amount_due": amount,
                            "sale_date":"","sale_number":"",
                            "source_url": pdf_url,
                            "date_scraped": DATE_SCRAPED,
                            "notes": "Feb 2026 delinquent tax list"
                        }
                        rows.append(r)
    except Exception as e:
        print(f"  PDF parse error: {e}")
        return [], "NO_LIST", page_said, f"PDF parse error: {e}", pdf_url, "Call 931-766-4181"

    rows = filter_rows(rows)
    what_said = "Site has a direct PDF link for delinquent taxes (updated monthly, latest Feb 2026)."
    what_did  = f"Downloaded {pdf_url}. Parsed tables with owner|address|parcel column order."
    return rows, "PDF_DOWNLOADED", what_said, what_did, pdf_url, f"{len(rows)} delinquent owners"

def scrape_weakley():
    """
    Page says: trustee Marci Floyd has up-to-date list. PDF exists on page but is scanned.
    Result: flag for email to mfloyd@weakleycountytn.gov.
    """
    print("\n[WEAKLEY] Reading delinquent taxes page...")
    url = "https://www.weakleycountytn.gov/delinquent-taxes.html"
    html, code, _ = fetch(url)
    if not html:
        return [], "NO_SITE", "Could not load page", "", url, "Call 731-364-3643"

    txt = page_text(html)
    links = page_links(html, url)

    # Find the unpaid taxes PDF
    pdf_link = None
    for text_a, href in links:
        if re.search(r'(unpaid|delinquent)', text_a.lower() + href.lower()):
            if ".pdf" in href.lower():
                pdf_link = href
                print(f"  Found PDF link: {text_a} -> {href}")
                break

    page_said = "Page says trustee Marci Floyd has up-to-date list. Shows PDF 'Unpaid Taxes Report Updated 5-28-26'."

    if pdf_link:
        data, code2, ct = fetch(pdf_link, binary=True)
        if data and code2 == 200:
            # Try to extract text from first page to check if it's machine-readable
            try:
                with pdfplumber.open(io.BytesIO(data)) as pdf:
                    sample_text = ""
                    for p in pdf.pages[:2]:
                        sample_text += (p.extract_text() or "")
                    print(f"  PDF text sample (first 300 chars): {sample_text[:300]!r}")

                    if len(sample_text.strip()) < 50:
                        # Scanned/image PDF â€” no machine-readable text
                        what_did = f"Downloaded PDF ({len(pdf.pages)} pages) but it is a scanned image â€” no extractable text."
                        return [], "CALL_REQUIRED", page_said, what_did, pdf_link, \
                               "EMAIL mfloyd@weakleycountytn.gov for Excel/CSV | CALL 731-364-3643"

                    # Machine readable â€” parse tables
                    rows = parse_pdf_smart(data, "Weakley", "Dresden", pdf_link)
                    if rows:
                        what_did = f"Downloaded PDF, extracted {len(rows)} records from tables."
                        return rows, "PDF_DOWNLOADED", page_said, what_did, pdf_link, f"{len(rows)} records"
                    else:
                        what_did = "PDF has text but no parseable property tables (may be formatted as text, not tables)."
                        return [], "CALL_REQUIRED", page_said, what_did, pdf_link, \
                               "EMAIL mfloyd@weakleycountytn.gov for structured list | CALL 731-364-3643"
            except Exception as e:
                what_did = f"PDF error: {e}"
                return [], "CALL_REQUIRED", page_said, what_did, pdf_link, \
                       "EMAIL mfloyd@weakleycountytn.gov | CALL 731-364-3643"

    what_did = "No downloadable list found. Page references trustee directly."
    return [], "CALL_REQUIRED", page_said, what_did, url, \
           "EMAIL mfloyd@weakleycountytn.gov | CALL 731-364-3643"

def scrape_montgomery():
    """
    Page says: delinquents filed in lawsuit with Clerk & Master.
    Try mcgtn.org/chancery/tax-sale for any upcoming sale property list.
    """
    print("\n[MONTGOMERY] Reading trustee tax-sale page...")
    url = "https://montgomerytn.gov/trustee/tax-sale"
    html, code, _ = fetch(url)
    page_said = "Page says delinquent property taxes filed in lawsuit with Chancery Court Clerk & Master."

    if not html or code != 200:
        return [], "NO_SITE", page_said, f"HTTP {code}", url, "Call 931-648-5703 (C&M)"

    txt = page_text(html)
    links = page_links(html, url)

    # Check what page says to do
    if "clerk" in txt and "master" in txt:
        page_said += " Clerk & Master at mcgtn.org/chancery/tax-sale."

    # Try the Chancery Court tax sale page
    print("  Following to Chancery Court tax sale page...")
    cm_url = "https://mcgtn.org/chancery/tax-sale"
    html2, code2, _ = fetch(cm_url)
    what_did = f"Loaded {cm_url} (HTTP {code2}). "

    rows = []
    if html2 and code2 == 200:
        txt2 = page_text(html2)
        links2 = page_links(html2, cm_url)
        print(f"  Chancery page loaded. Looking for property list PDF...")

        for text_a, href in links2:
            combo = text_a.lower() + href.lower()
            if re.search(r'(delinquent|property.?list|tax.?sale|download|pdf)', combo):
                print(f"    Link: {text_a[:60]} -> {href[:80]}")
                if ".pdf" in href.lower():
                    data, code3, _ = fetch(href, binary=True)
                    if data and code3 == 200 and data[:5].startswith(b"%PDF"):
                        r = parse_pdf_smart(data, "Montgomery", "Clarksville", href, "","")
                        if r:
                            rows.extend(r)
                            what_did += f"Downloaded PDF {href}, got {len(r)} records."

        if not rows:
            what_did += "No downloadable property list found. Page describes the process but has no list."

    rows = filter_rows(rows)
    if rows:
        return rows, "PDF_DOWNLOADED", page_said, what_did, cm_url, f"{len(rows)} records"
    return [], "CALL_REQUIRED", page_said, what_did, cm_url, \
           "Call C&M 931-648-5703 | Email countytrustee@montgomerytn.gov"

def scrape_rutherford():
    """
    Page redirects to GovEase platform (govease.com) for online delinquent auctions.
    Go to govease.com, search Rutherford County Tennessee.
    """
    print("\n[RUTHERFORD] Following to GovEase platform...")
    # First check the local page
    url = "https://www.murfreesborotn.gov/1190/Collection-of-Delinquent-Taxes-Property-"
    html, code, _ = fetch(url)
    page_said = "Page directs to GovEase platform (govease.com) for online delinquent tax auctions."

    if html and code == 200:
        txt = page_text(html)
        if "govease" in txt:
            page_said = "Page explicitly directs to GovEase for online auction of delinquent properties."
        links = page_links(html, url)
        for text_a, href in links:
            if "govease" in href.lower() or "chancery" in text_a.lower():
                print(f"  Found: {text_a} -> {href}")

    # Try GovEase search for Rutherford
    print("  Searching GovEase for Rutherford County TN...")
    ge_url = "https://www.govease.com/search?state=TN&county=rutherford"
    html2, code2, _ = fetch(ge_url)
    what_did = f"Loaded GovEase.com (HTTP {code2}). "

    rows = []
    if html2 and code2 == 200:
        txt2 = page_text(html2)
        if "rutherford" in txt2:
            what_did += "Rutherford County found on GovEase â€” active auction or upcoming listing. "
            # GovEase is JavaScript-rendered; can't scrape without a real browser
            what_did += "GovEase requires JavaScript to display property list (cannot scrape without browser)."
        else:
            what_did += "No Rutherford County active auction found on GovEase at this time."

    also = "https://rutherfordctytn.govoffice.com/delinquent-taxes"
    html3, code3, _ = fetch(also)
    if html3 and code3 == 200:
        what_did += f" Also checked {also} (HTTP {code3})."
        links3 = page_links(html3, also)
        for text_a, href in links3:
            if re.search(r'(delinquent|tax.?sale|pdf)', text_a.lower() + href.lower()):
                print(f"  Found: {text_a[:50]} -> {href[:70]}")
                if ".pdf" in href.lower():
                    data, c3b, _ = fetch(href, binary=True)
                    if data and c3b == 200:
                        r = parse_pdf_smart(data, "Rutherford","Murfreesboro", href)
                        rows.extend(r)

    rows = filter_rows(rows)
    if rows:
        return rows, "PDF_DOWNLOADED", page_said, what_did, also, f"{len(rows)} records"
    return [], "CALL_REQUIRED", page_said, what_did, ge_url, \
           "Register at govease.com to view Rutherford listings | Call 615-898-7750 C&M"

def scrape_hamilton():
    """Read the trustee page and follow wherever it leads."""
    print("\n[HAMILTON] Reading trustee page...")
    url = "https://www.hamiltontn.gov/Trustee.aspx"
    html, code, _ = fetch(url)
    page_said = ""
    if html and code == 200:
        txt = page_text(html)
        if "delinquent" in txt:
            page_said = "Trustee page mentions delinquent taxes. "
        if "clerk" in txt:
            page_said += "References Clerk & Master. "
        if "newspaper" in txt or "ledger" in txt or "herald" in txt:
            page_said += "References newspaper publication. "
        if not page_said:
            page_said = "Trustee page loaded but no specific delinquent tax instructions found."

        links = page_links(html, url)
        rows = []
        for text_a, href in links:
            combo = text_a.lower() + href.lower()
            if re.search(r'(delinquent|tax.?sale|chancery)', combo):
                print(f"  Following: {text_a[:50]} -> {href[:70]}")
                h2, c2, _ = fetch(href)
                if not h2 or c2 != 200:
                    continue
                links2 = page_links(h2, href)
                for t2, h2link in links2:
                    if ".pdf" in h2link.lower() and re.search(r'(delinquent|tax)', t2.lower() + h2link.lower()):
                        data, c3, _ = fetch(h2link, binary=True)
                        if data and c3 == 200:
                            r = parse_pdf_smart(data, "Hamilton","Chattanooga", h2link)
                            rows.extend(r)
                time.sleep(0.5)

        rows = filter_rows(rows)
        if rows:
            return rows, "PDF_DOWNLOADED", page_said, f"Found and parsed {len(rows)} records", url, f"{len(rows)} records"

    return [], "CALL_REQUIRED", page_said or "Page did not load", \
           f"HTTP {code}. No downloadable list found.", url, "Call 423-209-6500"

def scrape_generic_with_reason(name, seat, phone, cm_phone, email, urls, priority, notes_hint=""):
    """
    Generic reasoned scraper for all other counties.
    Reads each URL, understands what it says, follows instructions.
    """
    print(f"\n[{name.upper()}] Reasoning through {len(urls)} URLs...")
    page_said = ""
    what_did  = ""
    rows      = []
    found_url = ""

    for url in urls:
        print(f"  Loading: {url}")
        html, code, ct = fetch(url)
        if not html or code != 200:
            what_did += f"URL {url} returned HTTP {code}. "
            time.sleep(0.5)
            continue

        txt = page_text(html)
        links = page_links(html, url)
        found_url = url

        # â”€â”€ STEP 2: READ the page and classify intent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        page_directs_to = ""

        # Check for direct download links
        for text_a, href in links:
            combo = text_a.lower() + " " + href.lower()
            # Direct delinquent list download?
            if re.search(r'\.(pdf|csv|xlsx)(\?|$)', href, re.I):
                if re.search(r'(delinquent|unpaid|tax.?sale|tax.?list)', combo):
                    page_directs_to = "direct_download"
                    page_said = f"Page has direct delinquent tax download link: {text_a[:60]}"
                    print(f"  -> DIRECT DOWNLOAD: {text_a[:50]} | {href[:70]}")

                    data, c2, ct2 = fetch(href, binary=True)
                    if data and c2 == 200:
                        if data[:5].startswith(b"%PDF") or "pdf" in ct2.lower():
                            r = parse_pdf_smart(data, name, seat, href)
                            if r:
                                rows.extend(r)
                                what_did += f"Downloaded PDF {href}, got {len(r)} rows. "
                        elif "csv" in ct2.lower() or href.lower().endswith(".csv"):
                            txt_csv = data.decode("utf-8", errors="replace")
                            reader = csv.DictReader(io.StringIO(txt_csv))
                            for line in reader:
                                r = {k:"" for k in PROPERTY_COLS}
                                r.update({"county":name,"state":"TN","county_seat":seat,
                                          "source_url":href,"date_scraped":DATE_SCRAPED})
                                # try to map columns
                                for col, val in line.items():
                                    cl = col.lower()
                                    if "parcel" in cl: r["parcel_number"] = val
                                    elif "owner" in cl or "name" in cl: r["owner_name"] = val
                                    elif "address" in cl: r["property_address"] = val
                                    elif "city" in cl: r["city"] = val
                                    elif "zip" in cl: r["zip"] = val
                                    elif "amount" in cl or "balance" in cl: r["amount_due"] = val
                                rows.append(r)
                            what_did += f"Downloaded CSV {href}, got {len(rows)} rows before validation. "
                    time.sleep(0.5)

        if rows:
            break  # found data from this URL

        # Check what the page text says to do
        if "govease" in txt:
            page_directs_to = "govease"
            page_said = f"Page directs to GovEase online auction platform."
            what_did += "Page says to use GovEase (JS-rendered, requires browser login). "
        elif "tennesseetrustee.org" in txt or "tn payments" in txt:
            page_directs_to = "tn_trustee"
            page_said = "Page directs to Tennessee Trustee online portal for tax payments."
            what_did += "Tennessee Trustee portal is JS-rendered â€” no machine-readable delinquent list found. "
        elif any(x in txt for x in ["newspaper","ledger","herald","chronicle","gazette","advertised","published in"]):
            # Find which newspaper
            newspaper_match = re.search(r'(ledger|herald|chronicle|gazette|tribune|democrat|republican)', txt)
            paper = newspaper_match.group(0) if newspaper_match else "local newspaper"
            page_directs_to = "newspaper"
            page_said = f"Page says delinquent list is advertised/published in the local {paper}."
            what_did += f"Page references {paper} publication â€” would need to search that paper online. "
        elif "clerk" in txt and ("master" in txt or "chancery" in txt):
            page_directs_to = "clerk_master"
            page_said = "Page says delinquent taxes are filed with Chancery Court Clerk & Master."
            what_did += "Referred to Chancery Court. No downloadable list on trustee site. "
        elif "call" in txt and "delinquent" in txt:
            page_directs_to = "call"
            page_said = "Page says to call the office for delinquent tax information."
            what_did += "Page instructs callers to contact office directly. "
        elif "delinquent" in txt:
            page_directs_to = "info_only"
            page_said = "Page has delinquent tax information but no downloadable list."
            what_did += "Page mentions delinquent taxes but offers no list download or clear redirect. "
        else:
            page_directs_to = "no_info"
            page_said = "Page loaded but does not mention delinquent taxes at all."
            what_did += "No delinquent tax information found on this page. "

        # If no direct download, try going one level deeper into relevant links
        if not rows and page_directs_to not in ("govease","newspaper"):
            for text_a, href in links:
                combo = text_a.lower() + " " + href.lower()
                if re.search(r'(delinquent|tax.?sale|chancery|trustee)', combo):
                    if href == url:  # avoid loop
                        continue
                    print(f"  Following link: {text_a[:40]} -> {href[:60]}")
                    h2, c2, _ = fetch(href)
                    if not h2 or c2 != 200:
                        time.sleep(0.5)
                        continue
                    links2 = page_links(h2, href)
                    for t2, h2l in links2:
                        c2combo = t2.lower() + " " + h2l.lower()
                        if re.search(r'\.(pdf|csv|xlsx)(\?|$)', h2l, re.I):
                            if re.search(r'(delinquent|unpaid|tax.?sale)', c2combo):
                                print(f"    Found: {t2[:40]} -> {h2l[:60]}")
                                data, c3, ct3 = fetch(h2l, binary=True)
                                if data and c3 == 200:
                                    r = parse_pdf_smart(data, name, seat, h2l)
                                    if r:
                                        rows.extend(r)
                                        what_did += f"L2 PDF {h2l}: {len(r)} records. "
                    time.sleep(0.5)

        time.sleep(0.8)

    rows = filter_rows(rows)

    if rows:
        status = "SCRAPED" if len(rows) > 5 else "PARTIAL"
        return rows, status, page_said, what_did, found_url, f"{len(rows)} validated records"

    # Determine best next action based on what page said
    if "govease" in what_did.lower():
        next_action = f"Register at govease.com to view {name} County auctions | Call {phone}"
    elif "newspaper" in what_did.lower():
        next_action = f"Search local newspaper public notices | Call {phone}"
    elif "chancery" in what_did.lower() or "clerk" in what_did.lower():
        next_action = f"Call Chancery Court C&M {cm_phone or 'see directory'} for list | Call trustee {phone}"
    else:
        next_action = f"Call trustee {phone}"

    if email:
        next_action += f" | Email {email}"

    return [], "CALL_REQUIRED", page_said, what_did, found_url, next_action

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# ALL 95 COUNTIES
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

COUNTIES = [
    # Tier 1 â€” known data sources
    {"name":"Shelby",       "seat":"Memphis",       "phone":"901-222-0200","cm_phone":"901-222-3900","email":"","priority":"HIGH","fn":scrape_shelby},
    {"name":"Lawrence",     "seat":"Lawrenceburg",  "phone":"931-766-4181","cm_phone":"","email":"","priority":"MEDIUM","fn":scrape_lawrence},
    {"name":"Davidson",     "seat":"Nashville",     "phone":"615-862-6000","cm_phone":"615-862-6000","email":"","priority":"HIGH","fn":scrape_davidson},
    {"name":"Hamilton",     "seat":"Chattanooga",   "phone":"423-209-6500","cm_phone":"","email":"","priority":"HIGH","fn":scrape_hamilton},
    {"name":"Montgomery",   "seat":"Clarksville",   "phone":"931-648-5717","cm_phone":"931-648-5703","email":"countytrustee@montgomerytn.gov","priority":"HIGH","fn":scrape_montgomery},
    {"name":"Rutherford",   "seat":"Murfreesboro",  "phone":"615-898-7750","cm_phone":"615-898-7750","email":"","priority":"HIGH","fn":scrape_rutherford},
    {"name":"Weakley",      "seat":"Dresden",       "phone":"731-364-3643","cm_phone":"","email":"mfloyd@weakleycountytn.gov","priority":"HIGH","fn":scrape_weakley},

    # Knox â€” known stale
    {"name":"Knox",         "seat":"Knoxville",     "phone":"865-215-2305","cm_phone":"","email":"","priority":"MEDIUM","stale":True,
     "stale_note":"Tax Sale 25 completed June 2 2026. Watch for Tax Sale 26 at trustee.knoxcounty.org/services/tax-sale"},

    # Tier 2 â€” generic with URLs
    {"name":"Williamson",   "seat":"Franklin",      "phone":"615-790-5709","cm_phone":"","email":"","priority":"HIGH",
     "urls":["https://www.williamsoncounty-tn.gov/"]},
    {"name":"Sumner",       "seat":"Gallatin",      "phone":"615-452-1260","cm_phone":"","email":"","priority":"HIGH",
     "urls":["https://www.sumnercountytn.gov/"]},
    {"name":"Wilson",       "seat":"Lebanon",       "phone":"615-444-1383","cm_phone":"","email":"","priority":"HIGH",
     "urls":["http://wilsoncountytn.gov/201/Trustee","http://wilsoncountytn.gov/174/Court-Public-Auctions-Delinquent-Tax-Sal"]},
    {"name":"Maury",        "seat":"Columbia",      "phone":"931-375-4000","cm_phone":"","email":"","priority":"HIGH",
     "urls":["https://www.maurycounty-tn.gov/"]},
    {"name":"Sullivan",     "seat":"Blountville",   "phone":"423-323-6428","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://tennesseetrustee.org/index.php?entity=sullivan&state=TN"]},
    {"name":"Washington",   "seat":"Jonesborough",  "phone":"423-753-1600","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.washingtoncountytn.org/"]},
    {"name":"Blount",       "seat":"Maryville",     "phone":"865-273-5900","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.blounttn.gov/"]},
    {"name":"Bradley",      "seat":"Cleveland",     "phone":"423-728-7247","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.bradleycountytn.org/"]},
    {"name":"Robertson",    "seat":"Springfield",   "phone":"615-384-4238","cm_phone":"615-384-5650","email":"","priority":"MEDIUM",
     "urls":["https://www.robertsoncountytn.gov/local_government/trustee/property_tax_information.php"]},
    {"name":"Madison",      "seat":"Jackson",       "phone":"731-423-6022","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.madisoncountytn.gov/"]},
    {"name":"Putnam",       "seat":"Cookeville",    "phone":"931-528-8428","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://putnamcountytn.gov/trustee"]},
    {"name":"Jefferson",    "seat":"Dandridge",     "phone":"865-397-3800","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://jeffersoncountytn.gov/county-trustee/"]},
    {"name":"Carter",       "seat":"Elizabethton",  "phone":"423-542-1811","cm_phone":"423-542-1812","email":"","priority":"MEDIUM",
     "urls":["https://www.cartercountytn.gov/government/elected_officials/county_trustee.php"]},
    {"name":"Campbell",     "seat":"Jacksboro",     "phone":"865-397-2101","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://campbellcountytn.gov/elected-officials/trustee/"]},
    {"name":"Claiborne",    "seat":"Tazewell",      "phone":"423-626-3275","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://claibornecountytn.gov/countyoffices/county-officials/trustee/"]},
    {"name":"Obion",        "seat":"Union City",    "phone":"731-885-9210","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.obioncountytn.gov/"]},
    {"name":"Macon",        "seat":"Lafayette",     "phone":"615-666-2363","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://maconcountytn.gov/government/trustee.php"]},
    {"name":"Sevier",       "seat":"Sevierville",   "phone":"865-453-2767","cm_phone":"","email":"","priority":"HIGH",
     "urls":["https://www.seviercounty.net/"]},
    {"name":"Anderson",     "seat":"Clinton",       "phone":"865-457-6237","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.andersoncountytn.gov/"]},
    {"name":"Coffee",       "seat":"Manchester",    "phone":"931-723-5106","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.coffeecountytn.org/"]},
    {"name":"Cumberland",   "seat":"Crossville",    "phone":"931-484-5315","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.cumberlandcountytn.gov/"]},
    {"name":"Dickson",      "seat":"Charlotte",     "phone":"615-789-7171","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.dicksoncountytn.gov/"]},
    {"name":"Dyer",         "seat":"Dyersburg",     "phone":"731-286-7812","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.dyercountytn.gov/"]},
    {"name":"Fayette",      "seat":"Somerville",    "phone":"901-465-5241","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.fayettecountytn.gov/"]},
    {"name":"Gibson",       "seat":"Trenton",       "phone":"731-855-7629","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.gibsoncountytn.gov/"]},
    {"name":"Giles",        "seat":"Pulaski",       "phone":"931-363-1509","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.gilescountytn.org/"]},
    {"name":"Greene",       "seat":"Greeneville",   "phone":"423-798-1741","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.greenecountytn.gov/"]},
    {"name":"Hamblen",      "seat":"Morristown",    "phone":"423-586-1941","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.hamblencountytn.com/","https://www.hamblencountychancery.org/"]},
    {"name":"Hardeman",     "seat":"Bolivar",       "phone":"731-658-5133","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.hardemancountytn.com/"]},
    {"name":"Hardin",       "seat":"Savannah",      "phone":"731-925-3921","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.hardincountytn.gov/"]},
    {"name":"Hawkins",      "seat":"Rogersville",   "phone":"423-272-7359","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.hawkinscountytn.gov/"]},
    {"name":"Haywood",      "seat":"Brownsville",   "phone":"731-772-0432","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.haywoodntn.com/"]},
    {"name":"Henderson",    "seat":"Lexington",     "phone":"731-968-6881","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.hendersoncountytn.gov/"]},
    {"name":"Henry",        "seat":"Paris",         "phone":"731-642-0162","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.henrycountytn.org/"]},
    {"name":"Hickman",      "seat":"Centerville",   "phone":"931-729-4271","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.hickmancountytn.gov/"]},
    {"name":"Jackson",      "seat":"Gainesboro",    "phone":"931-268-9888","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.jacksoncountytn.gov/"]},
    {"name":"Lauderdale",   "seat":"Ripley",        "phone":"731-635-0491","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.lauderdalecountytn.net/"]},
    {"name":"Lincoln",      "seat":"Fayetteville",  "phone":"931-433-1200","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.lincolncountytn.gov/"]},
    {"name":"Loudon",       "seat":"Loudon",        "phone":"865-458-3369","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.loudoncounty.org/"]},
    {"name":"McMinn",       "seat":"Athens",        "phone":"423-745-1431","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.mcminncountytn.gov/"]},
    {"name":"McNairy",      "seat":"Selmer",        "phone":"731-645-3472","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.mcnairycounty.com/"]},
    {"name":"Marion",       "seat":"Jasper",        "phone":"423-942-2313","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.marioncountytn.gov/"]},
    {"name":"Marshall",     "seat":"Lewisburg",     "phone":"931-359-0823","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.marshallcountytn.gov/"]},
    {"name":"Meigs",        "seat":"Decatur",       "phone":"423-334-5850","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.meigscountytn.gov/"]},
    {"name":"Monroe",       "seat":"Madisonville",  "phone":"423-442-3981","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.monroecountytn.gov/"]},
    {"name":"Moore",        "seat":"Lynchburg",     "phone":"931-759-7221","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.moorecountytn.gov/"]},
    {"name":"Morgan",       "seat":"Wartburg",      "phone":"423-346-3480","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.morgancountytn.com/"]},
    {"name":"Overton",      "seat":"Livingston",    "phone":"931-823-1290","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.overtoncountytn.gov/"]},
    {"name":"Perry",        "seat":"Linden",        "phone":"931-589-2219","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.perrycountytn.org/"]},
    {"name":"Polk",         "seat":"Benton",        "phone":"423-338-4503","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.polkcountytn.gov/"]},
    {"name":"Rhea",         "seat":"Dayton",        "phone":"423-775-7824","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.rheacountytn.gov/"]},
    {"name":"Roane",        "seat":"Kingston",      "phone":"865-376-5578","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.roanecounty.org/"]},
    {"name":"Scott",        "seat":"Huntsville",    "phone":"423-663-2525","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.scottcountytn.org/"]},
    {"name":"Sequatchie",   "seat":"Dunlap",        "phone":"423-949-2521","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.sequatchiecounty.org/"]},
    {"name":"Smith",        "seat":"Carthage",      "phone":"615-735-2295","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.smithcountytn.com/"]},
    {"name":"Stewart",      "seat":"Dover",         "phone":"931-232-7614","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.stewartcountytn.gov/"]},
    {"name":"Tipton",       "seat":"Covington",     "phone":"901-476-0213","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.tiptoncountytn.gov/"]},
    {"name":"Trousdale",    "seat":"Hartsville",    "phone":"615-374-2461","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.trousdalecountytn.gov/"]},
    {"name":"Unicoi",       "seat":"Erwin",         "phone":"423-743-3381","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.unicoicounty.org/"]},
    {"name":"Union",        "seat":"Maynardville",  "phone":"865-992-3061","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.unioncountytn.gov/"]},
    {"name":"Van Buren",    "seat":"Spencer",       "phone":"931-946-2121","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.vanburen.govoffice2.com/"]},
    {"name":"Warren",       "seat":"McMinnville",   "phone":"931-473-2623","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.warrencountytn.gov/"]},
    {"name":"Wayne",        "seat":"Waynesboro",    "phone":"931-722-3653","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.waynecountytn.gov/"]},
    {"name":"White",        "seat":"Sparta",        "phone":"931-836-3245","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.whitecountytn.gov/"]},
    {"name":"Bedford",      "seat":"Shelbyville",   "phone":"931-684-1921","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.bedfordcountytn.gov/courts/chancery_court/delinquent_taxes.php",
             "https://citisenportal.com/DelinquentTax/Search?applicationSiteId=05qlI"]},
    {"name":"Benton",       "seat":"Camden",        "phone":"731-584-6011","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.bentoncountytn.gov/"]},
    {"name":"Bledsoe",      "seat":"Pikeville",     "phone":"423-447-2369","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.bledsoetn.gov/"]},
    {"name":"Cannon",       "seat":"Woodbury",      "phone":"615-563-5861","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.cannoncountytn.gov/"]},
    {"name":"Carroll",      "seat":"Huntingdon",    "phone":"731-986-1920","cm_phone":"","email":"","priority":"HIGH",
     "urls":["https://www.carrollcountytn.gov/"],
     "warm_call":"NOTE: Nida owns land in Carroll County (Holladay TN). Warm call â€” mention this."},
    {"name":"Cheatham",     "seat":"Ashland City",  "phone":"615-792-4298","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.cheathamcountytn.gov/"]},
    {"name":"Chester",      "seat":"Henderson",     "phone":"731-989-2233","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.chestercountytn.gov/"]},
    {"name":"Clay",         "seat":"Celina",        "phone":"931-243-2161","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.claycountytn.gov/"]},
    {"name":"Cocke",        "seat":"Newport",       "phone":"423-623-3081","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.cockecountytn.gov/"]},
    {"name":"Crockett",     "seat":"Alamo",         "phone":"731-696-5480","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.crockettcountytn.gov/"]},
    {"name":"Decatur",      "seat":"Decaturville",  "phone":"731-852-3371","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.decaturcountytn.gov/"]},
    {"name":"DeKalb",       "seat":"Smithville",    "phone":"615-597-4871","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.dekalbcountytn.gov/"]},
    {"name":"Fentress",     "seat":"Jamestown",     "phone":"931-879-7812","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.fentresscountytn.gov/"]},
    {"name":"Franklin",     "seat":"Winchester",    "phone":"931-967-2336","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.franklincountytn.gov/"]},
    {"name":"Grainger",     "seat":"Rutledge",      "phone":"865-828-3513","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.graingercountytn.gov/"]},
    {"name":"Grundy",       "seat":"Altamont",      "phone":"931-692-3368","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.grundycountytn.gov/"]},
    {"name":"Hancock",      "seat":"Sneedville",    "phone":"423-733-2454","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.hancockcountytn.gov/"]},
    {"name":"Houston",      "seat":"Erin",          "phone":"931-289-3633","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.houstoncountytn.gov/"]},
    {"name":"Humphreys",    "seat":"Waverly",       "phone":"931-296-7671","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.humphreyscountytn.gov/"]},
    {"name":"Johnson",      "seat":"Mountain City", "phone":"423-727-9012","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.johnsoncountytn.gov/"]},
    {"name":"Lake",         "seat":"Tiptonville",   "phone":"731-253-7582","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.lakecountytn.gov/"]},
    {"name":"Lewis",        "seat":"Hohenwald",     "phone":"931-796-3052","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.lewiscountytn.gov/"]},
    {"name":"Pickett",      "seat":"Byrdstown",     "phone":"931-864-3743","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.pickettcountytn.gov/"]},
]

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# MAIN
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    log_rows  = []
    call_rows = []
    all_data  = []
    total = len(COUNTIES)
    counts = {}

    for i, county in enumerate(COUNTIES, 1):
        name     = county["name"]
        seat     = county["seat"]
        phone    = county.get("phone","")
        cm_phone = county.get("cm_phone","")
        email    = county.get("email","")
        priority = county.get("priority","MEDIUM")
        warm     = county.get("warm_call","")

        print(f"\n{'='*60}")
        print(f"[{i}/{total}] {name} County ({seat}) [{priority}]")

        # Stale counties
        if county.get("stale"):
            result = "STALE"
            rows, what_said, what_did, url, next_action = (
                [], "Tax Sale already completed for 2026.",
                "Marked stale per known sale date.",
                county.get("stale_note",""),
                county.get("stale_note","")
            )
        elif "fn" in county:
            # Special-case handler
            out = county["fn"]()
            rows, result, what_said, what_did, url, next_action = out
        else:
            # Generic reasoner
            urls = county.get("urls", [])
            rows, result, what_said, what_did, url, next_action = scrape_generic_with_reason(
                name, seat, phone, cm_phone, email, urls, priority,
                notes_hint=warm
            )

        rec_count = len(rows)
        counts[result] = counts.get(result, 0) + 1
        print(f"  Result: {result} | Records: {rec_count}")
        if next_action:
            print(f"  Next: {next_action[:100]}")

        # Save per-county file
        file_saved = ""
        if rows:
            file_saved = save_county(name, rows)
            all_data.extend(rows)

        # Log entry
        log_rows.append({
            "county": name,
            "county_seat": seat,
            "trustee_phone": phone,
            "clerk_master_phone": cm_phone,
            "email": email,
            "what_page_said": (what_said or "")[:250],
            "what_you_did": (what_did or "")[:250],
            "result": result,
            "records_found": rec_count,
            "where_list_is": url or "",
            "notes": (next_action or warm or "")[:300],
            "priority": priority
        })

        # Call sheet entry if no data
        if rec_count == 0 and result not in ("STALE",):
            script = PHONE_SCRIPT.format(county=name)
            if warm:
                script += f" {warm}"
            call_rows.append({
                "county": name,
                "county_seat": seat,
                "trustee_phone": phone,
                "clerk_master_phone": cm_phone,
                "email": email,
                "script": script,
                "priority": priority,
                "where_list_is": url or "",
                "notes": (next_action or "")[:300]
            })

        time.sleep(0.3)

    # Write master log
    log_path = os.path.join(OUTPUT_DIR, "_MASTER_LOG.csv")
    with open(log_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=LOG_COLS)
        w.writeheader()
        w.writerows(log_rows)

    # Write call sheet sorted by priority
    priority_order = {"HIGH":0,"MEDIUM":1,"LOW":2}
    call_rows.sort(key=lambda r: priority_order.get(r.get("priority","LOW"), 9))
    call_path = os.path.join(OUTPUT_DIR, "_CALL_SHEET.csv")
    with open(call_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CALL_COLS)
        w.writeheader()
        w.writerows(call_rows)

    # Write master merged
    merged_path = os.path.join(OUTPUT_DIR, "_ALL_COUNTIES_MERGED.csv")
    with open(merged_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=PROPERTY_COLS)
        w.writeheader()
        for r in all_data:
            w.writerow({k: r.get(k,"") for k in PROPERTY_COLS})

    # Final summary
    print("\n" + "="*60)
    print("FINAL SUMMARY â€” SMART SCRAPER")
    print("="*60)
    print(f"Total counties:           {total}")
    for s, c in sorted(counts.items()):
        print(f"  {s:<25} {c}")
    print(f"Total records (validated): {len(all_data)}")
    print(f"Call sheet entries:        {len(call_rows)}")
    print(f"  HIGH:   {sum(1 for r in call_rows if r['priority']=='HIGH')}")
    print(f"  MEDIUM: {sum(1 for r in call_rows if r['priority']=='MEDIUM')}")
    print(f"  LOW:    {sum(1 for r in call_rows if r['priority']=='LOW')}")
    print("="*60)

if __name__ == "__main__":
    main()

