#!/usr/bin/env python3
"""Finalize TN delinquent tax data — remove junk, update log, rebuild master."""

import os, csv, io, re, time
from datetime import datetime
import requests
from bs4 import BeautifulSoup

OUTPUT_DIR = "TN_Delinquent_Tax"
DATE_SCRAPED = datetime.now().strftime("%Y-%m-%d")
STATE = "TN"

PROPERTY_COLS = [
    "county","state","county_seat","parcel_number","owner_name",
    "property_address","city","zip","amount_due","sale_date",
    "sale_number","source_url","date_scraped","notes"
]
LOG_COLS = ["county","status","method_tried","result","records_found",
            "file_saved","trustee_phone","next_action"]
CALL_COLS = ["county","county_seat","trustee_phone","clerk_master_phone",
             "email","script","priority"]

HEADERS = {"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
session = requests.Session()
session.headers.update(HEADERS)

PHONE_SCRIPT = (
    "Hi, I'm calling to request the current delinquent property tax list for {county} County. "
    "I understand taxes become delinquent after February 28th. "
    "Do you have a list of properties currently in delinquent status or scheduled for tax sale? "
    "Is that something you can email or mail to me? "
    "Who should I follow up with if not you?"
)

# ── VALIDATED GOOD DATA (confirmed real delinquent tax records) ──────────────
GOOD_FILES = {
    "SHELBY_delinquent.csv": {
        "note": "2,170 properties in Sale #2301 Oct 27 2026. Direct CSV from Shelby County S3 bucket. "
                "Columns: ParcelID + Address. No owner names in CSV — look up via shelby.tn.us GIS.",
        "status": "SCRAPED"
    },
    "LAWRENCE_delinquent.csv": {
        "note": "84 delinquent property owners from Feb 2026 PDF. Real names + addresses. "
                "Look for updated May/June 2026 PDF at lawrencecountytn.gov",
        "status": "PDF_DOWNLOADED"
    },
}

# ── GARBAGE FILES (wrong PDFs downloaded) — delete and move to call sheet ─────
JUNK_FILES = {
    "DICKSON_delinquent.csv":    ("931-789-7171","","MEDIUM","TN Capitol budget analysis PDF downloaded instead of delinquent list. Call trustee."),
    "ANDERSON_delinquent.csv":   ("865-457-6237","","MEDIUM","Garbled data from wrong PDF. Call trustee."),
    "HAWKINS_delinquent.csv":    ("423-272-7359","","MEDIUM","County budget salary PDF downloaded. Call trustee."),
    "MCMINN_delinquent.csv":     ("423-745-1431","","MEDIUM","Wrong PDF downloaded. Call trustee."),
    "UNION_delinquent.csv":      ("865-992-3061","","LOW","Wrong PDF downloaded. Call trustee."),
    "OBION_delinquent.csv":      ("731-885-9210","","MEDIUM","GovEase signup flyer PDF, not property list. Note: Obion uses GovEase for online auctions."),
    "BLOUNT_delinquent.csv":     ("865-273-5900","","MEDIUM","5 rows likely navigation items, not real data."),
    "WILLIAMSON_delinquent.csv": ("615-790-5709","","HIGH","5 rows navigation items. Large county — HIGH priority call."),
    "MAURY_delinquent.csv":      ("931-375-4000","","HIGH","5 rows navigation items. Call trustee."),
    "WASHINGTON_delinquent.csv": ("423-753-1600","","MEDIUM","5 rows navigation items. Call trustee."),
    "MADISON_delinquent.csv":    ("731-423-6022","","MEDIUM","5 rows navigation items. Call trustee."),
    "WHITE_delinquent.csv":      ("931-836-3245","","LOW","5 rows navigation items. Call trustee."),
    "DAVIDSON_delinquent.csv":   ("615-862-6000","615-862-6000","HIGH",
        "July 13 2026 sale ACTIVE — published today June 19. Check https://chanceryclerkandmaster.nashville.gov/fees/property-tax-schedule/ "
        "or call Chancery Clerk. Also check tnledger.com for the published list."),
    "WEAKLEY_delinquent.csv":    ("731-364-3643","","HIGH",
        "PDF exists (100 pages, scanned/image — not machine readable). Email mfloyd@weakleycountytn.gov for Excel/CSV. "
        "PDF URL: weakleycountytn.gov/uploads/1/0/7/5/107537459/unpaid_list_as_of_5-28-26.pdf"),
}

# ── ALL 95 COUNTIES FINAL LOG ─────────────────────────────────────────────────
ALL_COUNTIES = [
    # format: (name, seat, phone, cm_phone, email, priority, status, method, result, next_action)
    ("Shelby","Memphis","901-222-0200","901-222-3900","","HIGH","SCRAPED",
     "CSV_DOWNLOAD","2170 properties in Oct 27 2026 Sale #2301 from S3 CSV",
     "Data saved. No owner names — cross-ref shelby.tn.us GIS by parcel ID"),
    ("Lawrence","Lawrenceburg","931-766-4181","","","MEDIUM","PDF_DOWNLOADED",
     "PDF_PARSE","84 delinquent owners from Feb 2026 PDF",
     "Check lawrencecountytn.gov for updated May/June 2026 PDF"),
    ("Hamilton","Chattanooga","423-209-6500","","","HIGH","NO_LIST",
     "HTTP_200","Site loaded, no downloadable list found",
     "Call trustee. Delinquent list may be at Chancery Court 423-209-6900"),
    ("Bedford","Shelbyville","931-684-1921","","","MEDIUM","NO_LIST",
     "HTTP_200","citisenportal.com/DelinquentTax/Search link found but portal returned 500 error",
     "Try citisenportal.com directly or call trustee. citisenportal applicationSiteId=05qlI"),
    ("Davidson","Nashville","615-862-6000","615-862-6000","","HIGH","NO_LIST",
     "HTTP_200","July 13 2026 sale ACTIVE. No downloadable list found — published in TN Ledger newspaper",
     "Call 615-862-6000 Chancery C&M. Check tnledger.com for July 13 sale. Facebook: Metro Nashville Chancery Court/Delinquent Tax Sales"),
    ("Montgomery","Clarksville","931-648-5717","931-648-5703","countytrustee@montgomerytn.gov","HIGH","NO_LIST",
     "HTTP_200","Chancery Court tax-sale page found (mcgtn.org/chancery/tax-sale) but no list PDF",
     "Email countytrustee@montgomerytn.gov OR call Chancery C&M 931-648-5703"),
    ("Rutherford","Murfreesboro","615-898-7750","615-898-7750","","HIGH","NO_LIST",
     "HTTP_200","rcchancery.com returned 404. GovEase portal requires registration",
     "Call 615-898-7750 Chancery C&M. Try govease.com search for Rutherford County TN"),
    ("Knox","Knoxville","865-215-2305","","","MEDIUM","STALE",
     "KNOWN","Tax Sale 25 completed June 2 2026",
     "Monitor trustee.knoxcounty.org/services/tax-sale for Tax Sale 26 announcement"),
    ("Williamson","Franklin","615-790-5709","","","HIGH","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list online",
     "Call trustee 615-790-5709. Large high-value county — HIGH priority"),
    ("Sumner","Gallatin","615-452-1260","","","HIGH","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list found",
     "Call trustee 615-452-1260"),
    ("Wilson","Lebanon","615-444-1383","","","HIGH","NO_LIST",
     "HTTP_200","Court Public Auctions link found but no list. TN Trustee portal no data",
     "Call 615-444-1383. Check wilsoncountytn.gov/174/Court-Public-Auctions-Delinquent-Tax-Sal"),
    ("Maury","Columbia","931-375-4000","","","HIGH","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list online",
     "Call trustee 931-375-4000"),
    ("Sullivan","Blountville","423-323-6428","","","MEDIUM","NO_LIST",
     "HTTP_200","TN Trustee portal — no delinquent data found",
     "Call trustee 423-323-6428"),
    ("Washington","Jonesborough","423-753-1600","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list",
     "Call trustee 423-753-1600"),
    ("Blount","Maryville","865-273-5900","","","MEDIUM","NO_LIST",
     "HTTP_200","TN Trustee portal — no real delinquent data",
     "Call trustee 865-273-5900"),
    ("Bradley","Cleveland","423-728-7247","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list",
     "Call trustee 423-728-7247"),
    ("Robertson","Springfield","615-384-4238","615-384-5650","","MEDIUM","NO_LIST",
     "HTTP_200","Delinquents turned over to Chancery Court March 16-31",
     "Call Chancery C&M 615-384-5650 (delinquent list is with them, not trustee)"),
    ("Madison","Jackson","731-423-6022","","","MEDIUM","NO_LIST",
     "HTTP_200","TN Trustee portal — no real delinquent data",
     "Call trustee 731-423-6022"),
    ("Putnam","Cookeville","931-528-8428","","","MEDIUM","NO_LIST",
     "HTTP_200","Delinquents at Chancery Court after March 31",
     "Call trustee 931-528-8428"),
    ("Jefferson","Dandridge","865-397-3800","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 865-397-3800"),
    ("Carter","Elizabethton","423-542-1811","423-542-1812","","MEDIUM","NO_LIST",
     "HTTP_200","Over 13 months past due goes to Clerk & Masters",
     "Call C&M 423-542-1812 for lawsuit list"),
    ("Campbell","Jacksboro","865-397-2101","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 865-397-2101"),
    ("Claiborne","Tazewell","423-626-3275","","","LOW","NO_LIST",
     "HTTP_200","tnpayments.com/Claiborne — payment portal, no delinquent list",
     "Call trustee 423-626-3275"),
    ("Weakley","Dresden","731-364-3643","","mfloyd@weakleycountytn.gov","HIGH","NO_LIST",
     "PDF_FOUND_SCANNED","100-page PDF found but scanned (image-only) — not machine-readable",
     "EMAIL mfloyd@weakleycountytn.gov for Excel/CSV. PDF: weakleycountytn.gov/.../unpaid_list_as_of_5-28-26.pdf"),
    ("Obion","Union City","731-885-9210","","","MEDIUM","NO_LIST",
     "HTTP_200","GovEase signup flyer found (not property list). County uses GovEase for online auctions",
     "Register at liveauctions.govease.com to view Obion County auction properties, OR call 731-885-9210"),
    ("Macon","Lafayette","615-666-2363","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list",
     "Call trustee 615-666-2363"),
    ("Sevier","Sevierville","865-453-2767","","","HIGH","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list. HIGH VALUE area (Gatlinburg/Pigeon Forge)",
     "Call trustee 865-453-2767. HIGH priority — Sevier is a high-value tourist area"),
    ("Anderson","Clinton","865-457-6237","","","MEDIUM","NO_LIST",
     "PDF_WRONG","Downloaded wrong PDF (county phone directory, not tax list)",
     "Call trustee 865-457-6237"),
    ("Coffee","Manchester","931-723-5106","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list",
     "Call trustee 931-723-5106"),
    ("Cumberland","Crossville","931-484-5315","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list",
     "Call trustee 931-484-5315"),
    ("Dickson","Charlotte","615-789-7171","","","MEDIUM","NO_LIST",
     "PDF_WRONG","Downloaded TN Capitol budget analysis PDF. TN Trustee portal is JS-rendered (no data)",
     "Call trustee 615-789-7171"),
    ("Dyer","Dyersburg","731-286-7812","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list",
     "Call trustee 731-286-7812"),
    ("Fayette","Somerville","901-465-5241","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list",
     "Call trustee 901-465-5241"),
    ("Gibson","Trenton","731-855-7629","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list",
     "Call trustee 731-855-7629"),
    ("Giles","Pulaski","931-363-1509","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list",
     "Call trustee 931-363-1509"),
    ("Greene","Greeneville","423-798-1741","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no delinquent list",
     "Call trustee 423-798-1741"),
    ("Hamblen","Morristown","423-586-1941","","","MEDIUM","NO_LIST",
     "HTTP_200","hamblencountychancery.org portal found but requires login/registration",
     "Try hamblencountychancery.org OR call 423-586-1941"),
    ("Hardeman","Bolivar","731-658-5133","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 731-658-5133"),
    ("Hardin","Savannah","731-925-3921","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 731-925-3921"),
    ("Hawkins","Rogersville","423-272-7359","","","MEDIUM","NO_LIST",
     "PDF_WRONG","Downloaded county budget PDF (salary grades). TN Trustee portal JS-rendered",
     "Call trustee 423-272-7359"),
    ("Haywood","Brownsville","731-772-0432","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 731-772-0432"),
    ("Henderson","Lexington","731-968-6881","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 731-968-6881"),
    ("Henry","Paris","731-642-0162","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 731-642-0162"),
    ("Hickman","Centerville","931-729-4271","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — Dropbox PDFs found but not delinquent list",
     "Call trustee 931-729-4271"),
    ("Jackson","Gainesboro","931-268-9888","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 931-268-9888"),
    ("Lauderdale","Ripley","731-635-0491","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 731-635-0491"),
    ("Lincoln","Fayetteville","931-433-1200","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — Register of Deeds links only",
     "Call trustee 931-433-1200"),
    ("Loudon","Loudon","865-458-3369","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 865-458-3369"),
    ("McMinn","Athens","423-745-1431","","","MEDIUM","NO_LIST",
     "PDF_WRONG","Downloaded wrong PDF from site. TN Trustee JS-rendered",
     "Call trustee 423-745-1431"),
    ("McNairy","Selmer","731-645-3472","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 731-645-3472"),
    ("Marion","Jasper","423-942-2313","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 423-942-2313"),
    ("Marshall","Lewisburg","931-359-0823","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 931-359-0823"),
    ("Meigs","Decatur","423-334-5850","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 423-334-5850"),
    ("Monroe","Madisonville","423-442-3981","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 423-442-3981"),
    ("Moore","Lynchburg","931-759-7221","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 931-759-7221"),
    ("Morgan","Wartburg","423-346-3480","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 423-346-3480"),
    ("Overton","Livingston","931-823-1290","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 931-823-1290"),
    ("Perry","Linden","931-589-2219","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 931-589-2219"),
    ("Polk","Benton","423-338-4503","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 423-338-4503"),
    ("Rhea","Dayton","423-775-7824","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 423-775-7824"),
    ("Roane","Kingston","865-376-5578","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 865-376-5578"),
    ("Scott","Huntsville","423-663-2525","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 423-663-2525"),
    ("Sequatchie","Dunlap","423-949-2521","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 423-949-2521"),
    ("Smith","Carthage","615-735-2295","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 615-735-2295"),
    ("Stewart","Dover","931-232-7614","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 931-232-7614"),
    ("Tipton","Covington","901-476-0213","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 901-476-0213"),
    ("Trousdale","Hartsville","615-374-2461","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 615-374-2461"),
    ("Unicoi","Erwin","423-743-3381","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 423-743-3381"),
    ("Union","Maynardville","865-992-3061","","","LOW","NO_LIST",
     "PDF_WRONG","Downloaded wrong PDF (TN Trustee portal JS-rendered, grabbed wrong document)",
     "Call trustee 865-992-3061"),
    ("Van Buren","Spencer","931-946-2121","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 931-946-2121"),
    ("Warren","McMinnville","931-473-2623","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 931-473-2623"),
    ("Wayne","Waynesboro","931-722-3653","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 931-722-3653"),
    ("White","Sparta","931-836-3245","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — 5 rows navigation items, not real data",
     "Call trustee 931-836-3245"),
    ("Benton","Camden","731-584-6011","","","LOW","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 731-584-6011"),
    ("Bledsoe","Pikeville","423-447-2369","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 423-447-2369"),
    ("Cannon","Woodbury","615-563-5861","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 615-563-5861"),
    ("Carroll","Huntingdon","731-986-1920","","","HIGH","NO_LIST",
     "HTTP_200","Site loaded — no list. Nida owns land here (Holladay TN)",
     "WARM CALL — mention Nida owns land in Carroll County. Call 731-986-1920. Also try TN Trustee portal."),
    ("Cheatham","Ashland City","615-792-4298","","","MEDIUM","NO_LIST",
     "HTTP_200","Site loaded — no list",
     "Call trustee 615-792-4298"),
    ("Chester","Henderson","731-989-2233","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 731-989-2233"),
    ("Clay","Celina","931-243-2161","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 931-243-2161"),
    ("Cocke","Newport","423-623-3081","","","MEDIUM","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 423-623-3081"),
    ("Crockett","Alamo","731-696-5480","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 731-696-5480"),
    ("Decatur","Decaturville","731-852-3371","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 731-852-3371"),
    ("DeKalb","Smithville","615-597-4871","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 615-597-4871"),
    ("Fentress","Jamestown","931-879-7812","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 931-879-7812"),
    ("Franklin","Winchester","931-967-2336","","","MEDIUM","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 931-967-2336"),
    ("Grainger","Rutledge","865-828-3513","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 865-828-3513"),
    ("Grundy","Altamont","931-692-3368","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 931-692-3368"),
    ("Hancock","Sneedville","423-733-2454","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 423-733-2454"),
    ("Houston","Erin","931-289-3633","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 931-289-3633"),
    ("Humphreys","Waverly","931-296-7671","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 931-296-7671"),
    ("Johnson","Mountain City","423-727-9012","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 423-727-9012"),
    ("Lake","Tiptonville","731-253-7582","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 731-253-7582"),
    ("Lewis","Hohenwald","931-796-3052","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 931-796-3052"),
    ("Pickett","Byrdstown","931-864-3743","","","LOW","NO_LIST",
     "HTTP_200","TN Trustee portal — JS-rendered, no data",
     "Call trustee 931-864-3743"),
]

def main():
    print("="*60)
    print("TN DELINQUENT TAX — FINAL CLEANUP")
    print("="*60)

    # 1. Remove junk county files (replace with header-only)
    print("\n[1] Removing junk data files (wrong PDFs)...")
    for fname in JUNK_FILES:
        fpath = os.path.join(OUTPUT_DIR, fname)
        if os.path.exists(fpath):
            # Write header-only file to keep structure
            with open(fpath, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=PROPERTY_COLS)
                w.writeheader()
            print(f"  Cleared junk: {fname}")

    # 2. Write master log (accurate, all 95 counties)
    print("\n[2] Writing accurate _MASTER_LOG.csv...")
    log_path = os.path.join(OUTPUT_DIR, "_MASTER_LOG.csv")
    with open(log_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=LOG_COLS)
        w.writeheader()
        for row in ALL_COUNTIES:
            name, seat, phone, cm_phone, email, priority, status, method, result, next_action = row
            # Find if we have a saved file
            fname = f"{name.upper().replace(' ','_')}_delinquent.csv"
            fpath = os.path.join(OUTPUT_DIR, fname)
            rec_count = 0
            if os.path.exists(fpath):
                with open(fpath, encoding="utf-8") as ff:
                    reader = csv.DictReader(ff)
                    rows = [r for r in reader if r.get("owner_name") or r.get("parcel_number") or r.get("property_address")]
                    rec_count = len(rows)
            file_saved = fname if rec_count > 0 else ""
            w.writerow({
                "county": name,
                "status": status if rec_count > 0 or status in ("STALE",) else "NO_LIST",
                "method_tried": method,
                "result": result,
                "records_found": rec_count,
                "file_saved": file_saved,
                "trustee_phone": phone,
                "next_action": next_action
            })

    # 3. Write call sheet (all counties without data, sorted by priority)
    print("\n[3] Writing _CALL_SHEET.csv...")
    call_path = os.path.join(OUTPUT_DIR, "_CALL_SHEET.csv")

    priority_order = {"HIGH":0,"MEDIUM":1,"LOW":2}

    call_rows = []
    for row in ALL_COUNTIES:
        name, seat, phone, cm_phone, email, priority, status, method, result, next_action = row
        fname = f"{name.upper().replace(' ','_')}_delinquent.csv"
        fpath = os.path.join(OUTPUT_DIR, fname)
        rec_count = 0
        if os.path.exists(fpath):
            with open(fpath, encoding="utf-8") as ff:
                reader = csv.DictReader(ff)
                rows_r = [r for r in reader if r.get("owner_name") or r.get("parcel_number") or r.get("property_address")]
                rec_count = len(rows_r)
        if rec_count == 0 and status != "STALE":
            script = PHONE_SCRIPT.format(county=name)
            if name == "Carroll":
                script += " (NOTE: I own land in Carroll County near Holladay — warm call)"
            if name == "Davidson":
                script = "ACTIVE SALE July 13 2026. Call 615-862-6000 Chancery Clerk for list. Also check tnledger.com and Facebook: Metro Nashville Chancery Court/Delinquent Tax Sales"
            call_rows.append({
                "county": name,
                "county_seat": seat,
                "trustee_phone": phone,
                "clerk_master_phone": cm_phone,
                "email": email,
                "script": script,
                "priority": priority,
                "_sort": priority_order.get(priority, 9)
            })

    call_rows.sort(key=lambda x: x["_sort"])
    with open(call_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CALL_COLS)
        w.writeheader()
        for r in call_rows:
            w.writerow({k: r[k] for k in CALL_COLS})
    print(f"  Call sheet: {len(call_rows)} counties")

    # 4. Rebuild master merged file from only validated good data
    print("\n[4] Rebuilding _ALL_COUNTIES_MERGED.csv (validated data only)...")
    master_path = os.path.join(OUTPUT_DIR, "_ALL_COUNTIES_MERGED.csv")
    all_rows = []
    files = sorted([f for f in os.listdir(OUTPUT_DIR) if f.endswith("_delinquent.csv")])
    for fname in files:
        fpath = os.path.join(OUTPUT_DIR, fname)
        with open(fpath, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            good = [r for r in reader if r.get("owner_name") or r.get("parcel_number") or r.get("property_address")]
            all_rows.extend(good)

    with open(master_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=PROPERTY_COLS)
        w.writeheader()
        for r in all_rows:
            w.writerow({k: r.get(k,"") for k in PROPERTY_COLS})

    # 5. Print final summary
    print("\n" + "="*60)
    print("FINAL SUMMARY — TENNESSEE DELINQUENT TAX MISSION")
    print("="*60)

    status_counts = {}
    for row in ALL_COUNTIES:
        name, seat, phone, cm_phone, email, priority, status, *_ = row
        fname = f"{name.upper().replace(' ','_')}_delinquent.csv"
        fpath = os.path.join(OUTPUT_DIR, fname)
        rec_count = 0
        if os.path.exists(fpath):
            with open(fpath, encoding="utf-8") as ff:
                reader = csv.DictReader(ff)
                rec_count = len([r for r in reader if r.get("owner_name") or r.get("parcel_number") or r.get("property_address")])
        if rec_count > 0:
            s = "SCRAPED" if status == "SCRAPED" else "PDF_DOWNLOADED" if status == "PDF_DOWNLOADED" else "DATA_FOUND"
        else:
            s = status
        status_counts[s] = status_counts.get(s,0) + 1

    print(f"Total counties attempted:           95")
    for s, c in sorted(status_counts.items()):
        print(f"  {s:<35} {c}")

    print(f"\nTotal verified records saved:        {len(all_rows)}")
    print(f"  Shelby County (Oct 27 sale):       ~2,170 properties")
    print(f"  Lawrence County (Feb 2026 list):   ~84 owners")
    print(f"  Other validated data:              {len(all_rows) - 2170 - 84}")
    print(f"\nCall sheet entries (need phone):    {len(call_rows)}")
    print(f"  HIGH priority:  {sum(1 for r in call_rows if r['priority']=='HIGH')}")
    print(f"  MEDIUM priority:{sum(1 for r in call_rows if r['priority']=='MEDIUM')}")
    print(f"  LOW priority:   {sum(1 for r in call_rows if r['priority']=='LOW')}")

    print(f"\n{'='*60}")
    print("KEY ACTIVE OPPORTUNITIES")
    print(f"{'='*60}")
    print("1. SHELBY — 2,170 properties in Oct 27 2026 sale (active!)")
    print("   File: SHELBY_delinquent.csv | No owner names — use GIS links in notes field")
    print("2. LAWRENCE — 84 named owners, Feb 2026 list")
    print("   File: LAWRENCE_delinquent.csv | Has owner names + addresses")
    print("3. DAVIDSON — July 13 2026 sale ACTIVE (published TODAY)")
    print("   Action: Call 615-862-6000 OR check tnledger.com NOW")
    print("4. WEAKLEY — 'Unpaid Taxes Report 5-28-26' PDF exists but scanned")
    print("   Action: Email mfloyd@weakleycountytn.gov for editable list")
    print("5. CARROLL — Your county! No list online")
    print("   Action: Call 731-986-1920 (warm call — you own land there)")
    print("6. SEVIER — High-value Gatlinburg/Pigeon Forge area")
    print("   Action: Call 865-453-2767")
    print("="*60)
    print("\nFiles ready in TN_Delinquent_Tax/")

if __name__ == "__main__":
    main()
