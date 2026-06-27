#!/usr/bin/env python3
"""Fix and clean TN delinquent tax data — correct column mappings, re-download correct PDFs."""

import os, csv, io, re, time
from datetime import datetime
import requests
from bs4 import BeautifulSoup
import pdfplumber

OUTPUT_DIR = "TN_Delinquent_Tax"
DATE_SCRAPED = datetime.now().strftime("%Y-%m-%d")
STATE = "TN"

PROPERTY_COLS = [
    "county","state","county_seat","parcel_number","owner_name",
    "property_address","city","zip","amount_due","sale_date",
    "sale_number","source_url","date_scraped","notes"
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}

session = requests.Session()
session.headers.update(HEADERS)

def blank_row(county, seat):
    return {k: "" for k in PROPERTY_COLS} | {"county":county,"state":STATE,"county_seat":seat,"date_scraped":DATE_SCRAPED}

def save_csv(county_name, rows):
    fname = os.path.join(OUTPUT_DIR, f"{county_name.upper().replace(' ','_')}_delinquent.csv")
    with open(fname, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=PROPERTY_COLS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k,"") for k in PROPERTY_COLS})
    print(f"  Saved: {fname} ({len(rows)} records)")
    return fname

# ── FIX SHELBY — remap columns correctly ─────────────────────────────────────
def fix_shelby():
    print("\n[FIX] Shelby County — correct column mapping")
    url = "https://scgpublic.s3.amazonaws.com/TaxSaleExtract.csv"
    r = session.get(url, timeout=30)
    rows = []
    reader = csv.DictReader(io.StringIO(r.text))
    for row in reader:
        # Actual columns: ParcelID, Alt_Parcel, Street Number, Street Name, Tax Sale, Register GIS
        parcel = row.get("ParcelID","").strip()
        street_num = row.get("Street Number","").strip()
        street_name = row.get("Street Name","").strip()
        tax_sale = row.get("Tax Sale","").strip()
        gis_link = row.get("Register GIS","").strip()
        alt_parcel = row.get("Alt_Parcel","").strip()

        # Only include active Sale 2301 (Oct 27 2026) — skip 2302 (completed)
        # Actually TaxSaleExtract includes BOTH TS2301 and TS2302 listings
        # Per instructions: keep Sale #2301 (Oct 27 2026), drop Sale #2202 (April 2026)
        # TS2301 and TS2302 are TWO sub-lists within Sale 2301 batch
        # Include both TS2301 and TS2302 as they're both in the Oct 27 2026 sale

        address = f"{street_num} {street_name}".strip()
        rows.append(blank_row("Shelby","Memphis") | {
            "parcel_number": parcel,
            "owner_name": "",  # Not in the CSV - only parcel/address info available
            "property_address": address,
            "city": "Memphis",  # Shelby County = Memphis area
            "amount_due": "",   # Not in CSV - only sale listing
            "sale_date": "2026-10-27",
            "sale_number": tax_sale,
            "source_url": url,
            "notes": f"Sale #2301 Oct 27 2026 | GIS: {gis_link} | AltParcel: {alt_parcel}"
        })

    print(f"  Shelby: {len(rows)} records properly mapped")
    # Filter out header-like rows
    rows = [r for r in rows if r["parcel_number"] and r["parcel_number"] != "ParcelID"]
    return rows

# ── FIX LAWRENCE — remap columns (PDF has Owner | Address | Parcel order) ────
def fix_lawrence():
    print("\n[FIX] Lawrence County — correct PDF column mapping")
    url = "https://lawrencecountytn.gov/wp-content/uploads/2026/02/2.2.26-Delinquent-Taxes.pdf"
    r = session.get(url, timeout=30, stream=True)
    pdf_bytes = r.content
    rows = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables()
            for table in tables:
                for row in table:
                    if not row or all(not c for c in row):
                        continue
                    cells = [c.strip() if c else "" for c in row]
                    # Skip header rows
                    if not cells[0] or cells[0].lower().startswith("owner"):
                        continue
                    # Lawrence PDF columns: [Owner Name, Property Address, Parcel Number, ...]
                    # Based on sample data inspection
                    owner = cells[0] if len(cells) > 0 else ""
                    address = cells[1] if len(cells) > 1 else ""
                    parcel = cells[2] if len(cells) > 2 else ""
                    amount = cells[3] if len(cells) > 3 else ""
                    # Skip rows that look like headers or meta
                    if not owner or owner.startswith("Owner Name"):
                        continue
                    rows.append(blank_row("Lawrence","Lawrenceburg") | {
                        "parcel_number": parcel,
                        "owner_name": owner,
                        "property_address": address,
                        "city": "Lawrenceburg",
                        "amount_due": amount,
                        "source_url": url,
                        "notes": "Feb 2026 delinquent tax list"
                    })
    print(f"  Lawrence: {len(rows)} records")
    return rows

# ── FIX WEAKLEY — download the actual unpaid taxes PDF ───────────────────────
def fix_weakley():
    print("\n[FIX] Weakley County — download correct delinquent list PDF")
    pdf_url = "https://www.weakleycountytn.gov/uploads/1/0/7/5/107537459/unpaid_list_as_of_5-28-26.pdf"
    r = session.get(pdf_url, timeout=30)
    if r.status_code != 200:
        print(f"  ERROR: HTTP {r.status_code}")
        return []
    pdf_bytes = r.content
    rows = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        print(f"  PDF has {len(pdf.pages)} pages")
        for page_num, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            tables = page.extract_tables()
            for table in tables:
                for row in table:
                    if not row or all(not c for c in row):
                        continue
                    cells = [c.strip() if c else "" for c in row]
                    if len(cells) < 2:
                        continue
                    joined = " ".join(cells)
                    if any(kw in joined.lower() for kw in ["owner","parcel","page","total","amount","name"]):
                        if cells[0].lower() in ["owner","name","parcel","#","no."]:
                            continue
                    rows.append(blank_row("Weakley","Dresden") | {
                        "parcel_number": cells[0],
                        "owner_name":    cells[1] if len(cells) > 1 else "",
                        "property_address": cells[2] if len(cells) > 2 else "",
                        "city":          cells[3] if len(cells) > 3 else "",
                        "amount_due":    cells[4] if len(cells) > 4 else "",
                        "source_url":    pdf_url,
                        "notes":         f"Unpaid Taxes Report 5-28-26, Page {page_num+1}"
                    })
    print(f"  Weakley: {len(rows)} records")
    return rows

# ── FIX DAVIDSON — get actual tax sale list ───────────────────────────────────
def fix_davidson():
    print("\n[FIX] Davidson County — find actual tax sale list")
    rows = []
    # Try the delinquent tax sales page
    url = "https://chanceryclerkandmaster.nashville.gov/fees/delinquent-tax-sales"
    r = session.get(url, timeout=20)
    if r.status_code == 200:
        soup = BeautifulSoup(r.text, "html.parser")
        # Look for PDF links for the July 13 2026 sale
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(" ", strip=True)
            if ".pdf" in href.lower() or "july" in text.lower() or "2026" in text:
                full_url = href if href.startswith("http") else f"https://chanceryclerkandmaster.nashville.gov{href}"
                print(f"  Found link: {text[:60]} -> {full_url[:80]}")
                if ".pdf" in href.lower():
                    pr = session.get(full_url, timeout=30)
                    if pr.status_code == 200 and b"%PDF" in pr.content[:10]:
                        with pdfplumber.open(io.BytesIO(pr.content)) as pdf:
                            for page in pdf.pages:
                                tables = page.extract_tables()
                                for table in tables:
                                    for row in table:
                                        if not row or all(not c for c in row):
                                            continue
                                        cells = [c.strip() if c else "" for c in row]
                                        if len(cells) >= 2 and cells[0] and cells[1]:
                                            rows.append(blank_row("Davidson","Nashville") | {
                                                "parcel_number": cells[0],
                                                "owner_name":    cells[1] if len(cells)>1 else "",
                                                "property_address": cells[2] if len(cells)>2 else "",
                                                "amount_due":    cells[3] if len(cells)>3 else "",
                                                "sale_date":     "2026-07-13",
                                                "source_url":    full_url,
                                                "notes":         "July 13 2026 tax sale"
                                            })
        # Also try property tax schedule
        url2 = "https://chanceryclerkandmaster.nashville.gov/fees/property-tax-schedule"
        r2 = session.get(url2, timeout=20)
        if r2.status_code == 200:
            soup2 = BeautifulSoup(r2.text, "html.parser")
            for a in soup2.find_all("a", href=True):
                href = a["href"]
                text = a.get_text(" ", strip=True)
                print(f"  Tax schedule link: {text[:50]} -> {href[:70]}")

    if not rows:
        # Write a placeholder with the known info
        rows.append(blank_row("Davidson","Nashville") | {
            "notes": "July 13 2026 sale active - published June 19 2026. Call 615-862-6000 or check tnledger.com",
            "sale_date": "2026-07-13",
            "source_url": "https://chanceryclerkandmaster.nashville.gov/fees/delinquent-tax-sales"
        })
    print(f"  Davidson: {len(rows)} records")
    return rows

# ── FIX HAMILTON — try citisenportal link ────────────────────────────────────
def fix_hamilton():
    print("\n[FIX] Hamilton County — try additional sources")
    rows = []
    # Try the chancery court portal
    urls = [
        "https://www.hamiltontn.gov/departments/county-trustee",
        "https://hamiltonchancery.com/delinquent-tax-sale",
        "https://www.hamiltontn.gov/2239/Delinquent-Tax",
    ]
    for url in urls:
        try:
            r = session.get(url, timeout=15)
            if r.status_code == 200:
                soup = BeautifulSoup(r.text, "html.parser")
                links = []
                for a in soup.find_all("a", href=True):
                    href = a["href"]
                    text = a.get_text(" ", strip=True)
                    if re.search(r'(delinquent|tax.?sale|taxsale|foreclos)', href+text, re.I):
                        links.append((text[:60], href))
                if links:
                    print(f"  {url}: found {len(links)} relevant links")
                    for t, h in links[:5]:
                        print(f"    -> {t} | {h[:70]}")
        except Exception as e:
            print(f"  {url}: {e}")
        time.sleep(1)
    return rows

# ── FIX BEDFORD — try citisenportal directly ─────────────────────────────────
def fix_bedford():
    print("\n[FIX] Bedford County — try citisenportal.com")
    rows = []
    url = "https://citisenportal.com/DelinquentTax/Search?applicationSiteId=05qlI"
    try:
        r = session.get(url, timeout=20)
        print(f"  citisenportal HTTP {r.status_code}")
        if r.status_code == 200:
            soup = BeautifulSoup(r.text, "html.parser")
            # Look for property table
            tables = soup.find_all("table")
            print(f"  Found {len(tables)} tables")
            for table in tables:
                rows_html = table.find_all("tr")
                if len(rows_html) > 2:
                    for tr in rows_html[1:]:
                        cells = [td.get_text(" ", strip=True) for td in tr.find_all(["td","th"])]
                        if cells and any(c for c in cells):
                            rows.append(blank_row("Bedford","Shelbyville") | {
                                "parcel_number": cells[0] if len(cells)>0 else "",
                                "owner_name":    cells[1] if len(cells)>1 else "",
                                "property_address": cells[2] if len(cells)>2 else "",
                                "amount_due":    cells[3] if len(cells)>3 else "",
                                "source_url":    url,
                                "notes":         "citisenportal.com"
                            })
    except Exception as e:
        print(f"  Error: {e}")
    print(f"  Bedford: {len(rows)} records")
    return rows

# ── FIX HAMBLEN — try chancery portal ────────────────────────────────────────
def fix_hamblen():
    print("\n[FIX] Hamblen County — try chancery portal")
    rows = []
    url = "https://www.hamblencountychancery.org/#/"
    try:
        r = session.get("https://www.hamblencountychancery.org/", timeout=15)
        print(f"  HTTP {r.status_code}")
        if r.status_code == 200:
            soup = BeautifulSoup(r.text, "html.parser")
            for a in soup.find_all("a", href=True):
                text = a.get_text(" ", strip=True)
                href = a["href"]
                if re.search(r'(delinquent|tax.?sale)', href+text, re.I):
                    print(f"  Link: {text[:50]} -> {href[:70]}")
    except Exception as e:
        print(f"  Error: {e}")
    return rows

# ── FIX MONTGOMERY — try chancery court page ─────────────────────────────────
def fix_montgomery():
    print("\n[FIX] Montgomery County — try chancery court tax sale page")
    rows = []
    url = "https://mcgtn.org/chancery/tax-sale"
    try:
        r = session.get(url, timeout=15)
        print(f"  HTTP {r.status_code}")
        if r.status_code == 200:
            soup = BeautifulSoup(r.text, "html.parser")
            # Look for PDF or list links
            for a in soup.find_all("a", href=True):
                href = a["href"]
                text = a.get_text(" ", strip=True)
                if re.search(r'(delinquent|tax.?sale|pdf|list|propert)', href+text, re.I):
                    full = href if href.startswith("http") else f"https://mcgtn.org{href}"
                    print(f"  -> {text[:50]} | {full[:70]}")
                    if ".pdf" in href.lower():
                        pr = session.get(full, timeout=30)
                        if pr.status_code == 200 and b"%PDF" in pr.content[:10]:
                            with pdfplumber.open(io.BytesIO(pr.content)) as pdf:
                                for page in pdf.pages:
                                    tables = page.extract_tables()
                                    for table in tables:
                                        for row in table:
                                            if not row: continue
                                            cells = [c.strip() if c else "" for c in row]
                                            if len(cells) >= 2:
                                                rows.append(blank_row("Montgomery","Clarksville") | {
                                                    "parcel_number": cells[0],
                                                    "owner_name":    cells[1] if len(cells)>1 else "",
                                                    "property_address": cells[2] if len(cells)>2 else "",
                                                    "amount_due":    cells[3] if len(cells)>3 else "",
                                                    "source_url":    full,
                                                    "notes":         "Chancery Court tax sale"
                                                })
    except Exception as e:
        print(f"  Error: {e}")
    print(f"  Montgomery: {len(rows)} records")
    return rows

# ── FIX RUTHERFORD — try chancery court ──────────────────────────────────────
def fix_rutherford():
    print("\n[FIX] Rutherford County — try chancery court")
    rows = []
    url = "https://rcchancery.com/delinquent_taxsale.htm"
    try:
        r = session.get(url, timeout=15)
        print(f"  HTTP {r.status_code}")
        if r.status_code == 200:
            soup = BeautifulSoup(r.text, "html.parser")
            print(f"  Page title: {soup.title.string if soup.title else 'N/A'}")
            # Look for downloadable lists
            for a in soup.find_all("a", href=True):
                href = a["href"]
                text = a.get_text(" ", strip=True)
                if re.search(r'(delinquent|tax.?sale|list|pdf|download)', href+text, re.I):
                    print(f"  -> {text[:50]} | {href[:70]}")
    except Exception as e:
        print(f"  Error: {e}")
    return rows

# ── VERIFY TN TRUSTEE DATA ────────────────────────────────────────────────────
def check_tn_trustee_data():
    """Check whether the TN Trustee portal data is real or junk."""
    print("\n[CHECK] Tennessee Trustee portal data quality")
    # Dickson had 234 records - verify
    url = "https://tennesseetrustee.org/index.php?entity=dickson&state=TN"
    r = session.get(url, timeout=20)
    if r.status_code == 200:
        soup = BeautifulSoup(r.text, "html.parser")
        tables = soup.find_all("table")
        print(f"  Dickson TN Trustee: HTTP {r.status_code}, {len(tables)} tables")
        for i, t in enumerate(tables[:3]):
            rows = t.find_all("tr")
            print(f"  Table {i}: {len(rows)} rows, first row: {[td.get_text(' ',strip=True)[:30] for td in rows[0].find_all(['td','th'])][:4] if rows else []}")

def rebuild_tn_trustee_counties():
    """Re-pull TN Trustee portal data for counties that got data from it."""
    counties_to_check = [
        ("Anderson", "Clinton", "anderson"),
        ("Dickson", "Charlotte", "dickson"),
        ("McMinn", "Athens", "mcminn"),
        ("Union", "Maynardville", "union"),
        ("Blount", "Maryville", "blount"),
    ]
    results = {}
    for county, seat, entity in counties_to_check:
        print(f"\n[TN TRUSTEE] {county} County")
        url = f"https://tennesseetrustee.org/index.php?entity={entity}&state=TN"
        try:
            r = session.get(url, timeout=20)
            if r.status_code != 200:
                print(f"  HTTP {r.status_code}")
                continue
            soup = BeautifulSoup(r.text, "html.parser")
            # Look for delinquent search or property list
            delinquent_section = None
            for elem in soup.find_all(text=re.compile(r'delinquent|past.?due|tax.?sale', re.I)):
                print(f"  Found text: {elem[:60]}")
            tables = soup.find_all("table")
            print(f"  {county}: HTTP {r.status_code}, {len(tables)} tables")
            rows_out = []
            for table in tables:
                trs = table.find_all("tr")
                if len(trs) < 2:
                    continue
                hdr = [th.get_text(" ", strip=True).lower() for th in trs[0].find_all(["th","td"])]
                print(f"  Table headers: {hdr[:6]}")
                # Only process if headers look like tax/property data
                if any(k in " ".join(hdr) for k in ["owner","parcel","amount","address","name","tax","delinquent"]):
                    for tr in trs[1:10]:  # sample first 10
                        cells = [td.get_text(" ", strip=True) for td in tr.find_all(["td","th"])]
                        if cells:
                            print(f"  Row: {cells[:4]}")
            results[county] = rows_out
        except Exception as e:
            print(f"  Error: {e}")
        time.sleep(1)
    return results

# ── REBUILD MASTER MERGED ─────────────────────────────────────────────────────
def rebuild_master():
    print("\n[REBUILD] Rebuilding _ALL_COUNTIES_MERGED.csv from individual files")
    master_path = os.path.join(OUTPUT_DIR, "_ALL_COUNTIES_MERGED.csv")
    all_rows = []
    files = sorted([f for f in os.listdir(OUTPUT_DIR) if f.endswith("_delinquent.csv")])
    for fname in files:
        fpath = os.path.join(OUTPUT_DIR, fname)
        with open(fpath, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            file_rows = list(reader)
            # Only include rows with at least an owner or parcel or address
            good_rows = [r for r in file_rows if r.get("owner_name") or r.get("parcel_number") or r.get("property_address")]
            all_rows.extend(good_rows)
            print(f"  {fname}: {len(good_rows)}/{len(file_rows)} rows kept")

    with open(master_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=PROPERTY_COLS)
        w.writeheader()
        for r in all_rows:
            w.writerow({k: r.get(k,"") for k in PROPERTY_COLS})
    print(f"\n  Master: {len(all_rows)} total records -> {master_path}")
    return all_rows

# ── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    print("="*60)
    print("TN DELINQUENT TAX DATA — CLEANUP & ENHANCEMENT")
    print("="*60)

    # 1. Fix Shelby with correct column mapping
    shelby_rows = fix_shelby()
    save_csv("Shelby", shelby_rows)

    # 2. Fix Lawrence with correct column mapping
    lawrence_rows = fix_lawrence()
    save_csv("Lawrence", lawrence_rows)

    # 3. Fix Davidson (download actual tax sale list)
    davidson_rows = fix_davidson()
    save_csv("Davidson", davidson_rows)

    # 4. Fix Weakley (get the actual delinquent list PDF)
    weakley_rows = fix_weakley()
    save_csv("Weakley", weakley_rows)

    # 5. Try additional sources for zero-record counties
    print("\n[ADDITIONAL SOURCES]")
    hamilton_rows = fix_hamilton()
    montgomery_rows = fix_montgomery()
    rutherford_rows = fix_rutherford()
    bedford_rows = fix_bedford()
    hamblen_rows = fix_hamblen()

    if montgomery_rows:
        save_csv("Montgomery", montgomery_rows)
    if bedford_rows:
        save_csv("Bedford", bedford_rows)

    # 6. Check TN Trustee portal data quality
    check_tn_trustee_data()
    rebuild_tn_trustee_counties()

    # 7. Rebuild master merged file from all individual files
    all_rows = rebuild_master()

    print("\n" + "="*60)
    print("CLEANUP COMPLETE")
    print(f"Total records in master: {len(all_rows)}")
    print("="*60)

if __name__ == "__main__":
    main()
