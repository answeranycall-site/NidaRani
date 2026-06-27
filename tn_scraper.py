#!/usr/bin/env python3
"""Tennessee Delinquent Tax Scraper - All 95 Counties"""

import os, csv, time, re, io, json, hashlib
from datetime import datetime
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup

try:
    import pdfplumber
    HAS_PDF = True
except ImportError:
    HAS_PDF = False
    print("WARNING: pdfplumber not available, PDF parsing disabled")

OUTPUT_DIR = "TN_Delinquent_Tax"
DATE_SCRAPED = datetime.now().strftime("%Y-%m-%d")
STATE = "TN"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
}

PROPERTY_COLS = [
    "county","state","county_seat","parcel_number","owner_name",
    "property_address","city","zip","amount_due","sale_date",
    "sale_number","source_url","date_scraped","notes"
]
LOG_COLS = [
    "county","status","method_tried","result","records_found",
    "file_saved","trustee_phone","next_action"
]
CALL_COLS = [
    "county","county_seat","trustee_phone","clerk_master_phone",
    "email","script","priority"
]

PHONE_SCRIPT = (
    "Hi, I'm calling to request the current delinquent property tax list for {county} County. "
    "I understand taxes become delinquent after February 28th. "
    "Do you have a list of properties currently in delinquent status or scheduled for tax sale? "
    "Is that something you can email or mail to me? "
    "Who should I follow up with if not you?"
)

# All 95 TN counties with metadata
COUNTIES = [
    # ── TIER 1 – DIRECT DATA ───────────────────────────────────────────────────
    {"name":"Shelby",       "seat":"Memphis",       "phone":"901-222-0200","cm_phone":"901-222-3900","email":"","priority":"HIGH",
     "urls":["https://www.shelbycountytrustee.com/191/Tax-Sale-Schedule"],
     "notes":"Look for CSV download of Sale #2301 (Oct 27 2026). Drop Sale #2202."},
    {"name":"Lawrence",     "seat":"Lawrenceburg",  "phone":"931-766-4181","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://lawrencecountytn.gov/wp-content/uploads/2026/02/2.2.26-Delinquent-Taxes.pdf",
             "https://lawrencecountytn.gov"],
     "notes":"Monthly PDF updates; look for May/June 2026 version"},
    {"name":"Hamilton",     "seat":"Chattanooga",   "phone":"423-209-6500","cm_phone":"","email":"","priority":"HIGH",
     "urls":["https://www.hamiltontn.gov/Trustee.aspx",
             "https://www.hamiltontn.gov/departments/county-trustee"]},
    {"name":"Bedford",      "seat":"Shelbyville",   "phone":"931-684-1921","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.bedfordcountytn.gov/courts/chancery_court/delinquent_taxes.php"]},

    # ── TIER 2 – PORTAL / SEARCH ───────────────────────────────────────────────
    {"name":"Davidson",     "seat":"Nashville",     "phone":"615-862-6000","cm_phone":"615-862-6000","email":"","priority":"HIGH",
     "urls":["https://www.tnledger.com/Notices.aspx",
             "https://chanceryclerkandmaster.nashville.gov/fees/property-tax-schedule/"],
     "notes":"Davidson list in TN Ledger newspaper; July 13 2026 sale list published today"},
    {"name":"Montgomery",   "seat":"Clarksville",   "phone":"931-648-5717","cm_phone":"931-648-5703","email":"countytrustee@montgomerytn.gov","priority":"HIGH",
     "urls":["https://montgomerytn.gov/trustee/tax-sale",
             "https://montgomerytn.gov/trustee/surplus"]},
    {"name":"Rutherford",   "seat":"Murfreesboro",  "phone":"615-898-7750","cm_phone":"615-898-7750","email":"","priority":"HIGH",
     "urls":["https://www.govease.com/",
             "https://www.murfreesborotn.gov/1190/Collection-of-Delinquent-Taxes-Property-"]},
    {"name":"Knox",         "seat":"Knoxville",     "phone":"865-215-2305","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://trustee.knoxcounty.org/services/tax-sale",
             "https://www.kgis.org/TaxSale/index.html"],
     "notes":"Tax Sale 25 completed June 2 2026 - STALE. Watch for Tax Sale 26."},
    {"name":"Williamson",   "seat":"Franklin",      "phone":"615-790-5709","cm_phone":"","email":"","priority":"HIGH",
     "urls":["https://www.williamsoncounty-tn.gov/"]},
    {"name":"Sumner",       "seat":"Gallatin",      "phone":"615-452-1260","cm_phone":"","email":"","priority":"HIGH",
     "urls":["https://www.sumnercountytn.gov/"]},
    {"name":"Wilson",       "seat":"Lebanon",       "phone":"615-444-1383","cm_phone":"","email":"","priority":"HIGH",
     "urls":["http://wilsoncountytn.gov/201/Trustee",
             "https://tennesseetrustee.org/index.php?entity=wilson&state=TN"]},
    {"name":"Maury",        "seat":"Columbia",      "phone":"931-375-4000","cm_phone":"","email":"","priority":"HIGH",
     "urls":["https://www.maurycounty-tn.gov/",
             "https://tennesseetrustee.org/index.php?entity=maury&state=TN"]},
    {"name":"Sullivan",     "seat":"Blountville",   "phone":"423-323-6428","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["http://www.sullivan.tennesseetrustee.org/",
             "https://tennesseetrustee.org/index.php?entity=sullivan&state=TN"]},
    {"name":"Washington",   "seat":"Jonesborough",  "phone":"423-753-1600","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.washingtoncountytn.org/",
             "https://tennesseetrustee.org/index.php?entity=washington&state=TN"]},
    {"name":"Blount",       "seat":"Maryville",     "phone":"865-273-5900","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.blounttn.gov/",
             "https://tennesseetrustee.org/index.php?entity=blount&state=TN"]},
    {"name":"Bradley",      "seat":"Cleveland",     "phone":"423-728-7247","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.bradleycountytn.org/",
             "https://tennesseetrustee.org/index.php?entity=bradley&state=TN"]},
    {"name":"Robertson",    "seat":"Springfield",   "phone":"615-384-4238","cm_phone":"615-384-5650","email":"","priority":"MEDIUM",
     "urls":["https://www.robertsoncountytn.gov/local_government/trustee/property_tax_information.php"]},
    {"name":"Madison",      "seat":"Jackson",       "phone":"731-423-6022","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.madisoncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=madison&state=TN"]},
    {"name":"Putnam",       "seat":"Cookeville",    "phone":"931-528-8428","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://putnamcountytn.gov/trustee",
             "https://tennesseetrustee.org/index.php?entity=putnam&state=TN"]},
    {"name":"Jefferson",    "seat":"Dandridge",     "phone":"865-397-3800","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://jeffersoncountytn.gov/county-trustee/",
             "https://tennesseetrustee.org/index.php?entity=jefferson&state=TN"]},
    {"name":"Carter",       "seat":"Elizabethton",  "phone":"423-542-1811","cm_phone":"423-542-1812","email":"","priority":"MEDIUM",
     "urls":["https://www.cartercountytn.gov/government/elected_officials/county_trustee.php"]},
    {"name":"Campbell",     "seat":"Jacksboro",     "phone":"865-397-2101","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://campbellcountytn.gov/elected-officials/trustee/",
             "https://tennesseetrustee.org/index.php?entity=campbell&state=TN"]},
    {"name":"Claiborne",    "seat":"Tazewell",      "phone":"423-626-3275","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://claibornecountytn.gov/countyoffices/county-officials/trustee/",
             "https://tnpayments.com/Claiborne"]},
    {"name":"Weakley",      "seat":"Dresden",       "phone":"731-364-3643","cm_phone":"","email":"mfloyd@weakleycountytn.gov","priority":"HIGH",
     "urls":["https://www.weakleycountytn.gov/delinquent-taxes.html"],
     "notes":"High chance of getting list - email Marci Floyd directly"},
    {"name":"Obion",        "seat":"Union City",    "phone":"731-885-9210","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.obioncountytn.gov/"],
     "notes":"No trustee tax sales - handled by delinquent tax attorney"},
    {"name":"Macon",        "seat":"Lafayette",     "phone":"615-666-2363","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://maconcountytn.gov/government/trustee.php",
             "https://tennesseetrustee.org/index.php?entity=macon&state=TN"]},
    {"name":"Sevier",       "seat":"Sevierville",   "phone":"865-453-2767","cm_phone":"","email":"","priority":"HIGH",
     "urls":["https://www.seviercounty.net/",
             "https://tennesseetrustee.org/index.php?entity=sevier&state=TN"],
     "notes":"HIGH VALUE - Gatlinburg/Pigeon Forge area"},
    {"name":"Anderson",     "seat":"Clinton",       "phone":"865-457-6237","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.andersoncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=anderson&state=TN"]},
    {"name":"Coffee",       "seat":"Manchester",    "phone":"931-723-5106","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.coffeecountytn.org/",
             "https://tennesseetrustee.org/index.php?entity=coffee&state=TN"]},
    {"name":"Cumberland",   "seat":"Crossville",    "phone":"931-484-5315","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.cumberlandcountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=cumberland&state=TN"]},
    {"name":"Dickson",      "seat":"Charlotte",     "phone":"615-789-7171","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.dicksoncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=dickson&state=TN"]},
    {"name":"Dyer",         "seat":"Dyersburg",     "phone":"731-286-7812","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.dyercountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=dyer&state=TN"]},
    {"name":"Fayette",      "seat":"Somerville",    "phone":"901-465-5241","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.fayettecountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=fayette&state=TN"]},
    {"name":"Gibson",       "seat":"Trenton",       "phone":"731-855-7629","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.gibsoncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=gibson&state=TN"]},
    {"name":"Giles",        "seat":"Pulaski",       "phone":"931-363-1509","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.gilescountytn.org/",
             "https://tennesseetrustee.org/index.php?entity=giles&state=TN"]},
    {"name":"Greene",       "seat":"Greeneville",   "phone":"423-798-1741","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.greenecountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=greene&state=TN"]},
    {"name":"Hamblen",      "seat":"Morristown",    "phone":"423-586-1941","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.hamblencountytn.com/",
             "https://tennesseetrustee.org/index.php?entity=hamblen&state=TN"]},
    {"name":"Hardeman",     "seat":"Bolivar",       "phone":"731-658-5133","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.hardemancountytn.com/",
             "https://tennesseetrustee.org/index.php?entity=hardeman&state=TN"]},
    {"name":"Hardin",       "seat":"Savannah",      "phone":"731-925-3921","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.hardincountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=hardin&state=TN"]},
    {"name":"Hawkins",      "seat":"Rogersville",   "phone":"423-272-7359","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.hawkinscountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=hawkins&state=TN"]},
    {"name":"Haywood",      "seat":"Brownsville",   "phone":"731-772-0432","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.haywoodntn.com/",
             "https://tennesseetrustee.org/index.php?entity=haywood&state=TN"]},
    {"name":"Henderson",    "seat":"Lexington",     "phone":"731-968-6881","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.hendersoncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=henderson&state=TN"]},
    {"name":"Henry",        "seat":"Paris",         "phone":"731-642-0162","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.henrycountytn.org/",
             "https://tennesseetrustee.org/index.php?entity=henry&state=TN"]},
    {"name":"Hickman",      "seat":"Centerville",   "phone":"931-729-4271","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.hickmancountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=hickman&state=TN"]},
    {"name":"Jackson",      "seat":"Gainesboro",    "phone":"931-268-9888","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.jacksoncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=jackson&state=TN"]},
    {"name":"Lauderdale",   "seat":"Ripley",        "phone":"731-635-0491","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.lauderdalecountytn.net/",
             "https://tennesseetrustee.org/index.php?entity=lauderdale&state=TN"]},
    {"name":"Lincoln",      "seat":"Fayetteville",  "phone":"931-433-1200","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.lincolncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=lincoln&state=TN"]},
    {"name":"Loudon",       "seat":"Loudon",        "phone":"865-458-3369","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.loudoncounty.org/",
             "https://tennesseetrustee.org/index.php?entity=loudon&state=TN"]},
    {"name":"McMinn",       "seat":"Athens",        "phone":"423-745-1431","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.mcminncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=mcminn&state=TN"]},
    {"name":"McNairy",      "seat":"Selmer",        "phone":"731-645-3472","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.mcnairycounty.com/",
             "https://tennesseetrustee.org/index.php?entity=mcnairy&state=TN"]},
    {"name":"Marion",       "seat":"Jasper",        "phone":"423-942-2313","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.marioncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=marion&state=TN"]},
    {"name":"Marshall",     "seat":"Lewisburg",     "phone":"931-359-0823","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.marshallcountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=marshall&state=TN"]},
    {"name":"Meigs",        "seat":"Decatur",       "phone":"423-334-5850","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.meigscountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=meigs&state=TN"]},
    {"name":"Monroe",       "seat":"Madisonville",  "phone":"423-442-3981","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.monroecountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=monroe&state=TN"]},
    {"name":"Moore",        "seat":"Lynchburg",     "phone":"931-759-7221","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.moorecountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=moore&state=TN"]},
    {"name":"Morgan",       "seat":"Wartburg",      "phone":"423-346-3480","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.morgancountytn.com/",
             "https://tennesseetrustee.org/index.php?entity=morgan&state=TN"]},
    {"name":"Overton",      "seat":"Livingston",    "phone":"931-823-1290","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.overtoncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=overton&state=TN"]},
    {"name":"Perry",        "seat":"Linden",        "phone":"931-589-2219","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.perrycountytn.org/",
             "https://tennesseetrustee.org/index.php?entity=perry&state=TN"]},
    {"name":"Polk",         "seat":"Benton",        "phone":"423-338-4503","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.polkcountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=polk&state=TN"]},
    {"name":"Rhea",         "seat":"Dayton",        "phone":"423-775-7824","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.rheacountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=rhea&state=TN"]},
    {"name":"Roane",        "seat":"Kingston",      "phone":"865-376-5578","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.roanecounty.org/",
             "https://tennesseetrustee.org/index.php?entity=roane&state=TN"]},
    {"name":"Scott",        "seat":"Huntsville",    "phone":"423-663-2525","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.scottcountytn.org/",
             "https://tennesseetrustee.org/index.php?entity=scott&state=TN"]},
    {"name":"Sequatchie",   "seat":"Dunlap",        "phone":"423-949-2521","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.sequatchiecounty.org/",
             "https://tennesseetrustee.org/index.php?entity=sequatchie&state=TN"]},
    {"name":"Smith",        "seat":"Carthage",      "phone":"615-735-2295","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.smithcountytn.com/",
             "https://tennesseetrustee.org/index.php?entity=smith&state=TN"]},
    {"name":"Stewart",      "seat":"Dover",         "phone":"931-232-7614","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.stewartcountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=stewart&state=TN"]},
    {"name":"Tipton",       "seat":"Covington",     "phone":"901-476-0213","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.tiptoncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=tipton&state=TN"]},
    {"name":"Trousdale",    "seat":"Hartsville",    "phone":"615-374-2461","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.trousdalecountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=trousdale&state=TN"]},
    {"name":"Unicoi",       "seat":"Erwin",         "phone":"423-743-3381","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.unicoicounty.org/",
             "https://tennesseetrustee.org/index.php?entity=unicoi&state=TN"]},
    {"name":"Union",        "seat":"Maynardville",  "phone":"865-992-3061","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.unioncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=union&state=TN"]},
    {"name":"Van Buren",    "seat":"Spencer",       "phone":"931-946-2121","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.vanburen.govoffice2.com/",
             "https://tennesseetrustee.org/index.php?entity=van_buren&state=TN"]},
    {"name":"Warren",       "seat":"McMinnville",   "phone":"931-473-2623","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.warrencountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=warren&state=TN"]},
    {"name":"Wayne",        "seat":"Waynesboro",    "phone":"931-722-3653","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.waynecountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=wayne&state=TN"]},
    {"name":"White",        "seat":"Sparta",        "phone":"931-836-3245","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.whitecountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=white&state=TN"]},
    {"name":"Benton",       "seat":"Camden",        "phone":"731-584-6011","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://www.bentoncountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=benton&state=TN"]},
    {"name":"Bledsoe",      "seat":"Pikeville",     "phone":"423-447-2369","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=bledsoe&state=TN"]},
    {"name":"Cannon",       "seat":"Woodbury",      "phone":"615-563-5861","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=cannon&state=TN"]},
    {"name":"Carroll",      "seat":"Huntingdon",    "phone":"731-986-1920","cm_phone":"","email":"","priority":"HIGH",
     "urls":["https://www.carrollcountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=carroll&state=TN"],
     "notes":"PRIORITY - Nida owns land in Carroll County (Holladay TN) - warm call, mention it"},
    {"name":"Cheatham",     "seat":"Ashland City",  "phone":"615-792-4298","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://www.cheathamcountytn.gov/",
             "https://tennesseetrustee.org/index.php?entity=cheatham&state=TN"]},
    {"name":"Chester",      "seat":"Henderson",     "phone":"731-989-2233","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=chester&state=TN"]},
    {"name":"Clay",         "seat":"Celina",        "phone":"931-243-2161","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=clay&state=TN"]},
    {"name":"Cocke",        "seat":"Newport",       "phone":"423-623-3081","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://tennesseetrustee.org/index.php?entity=cocke&state=TN"]},
    {"name":"Crockett",     "seat":"Alamo",         "phone":"731-696-5480","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=crockett&state=TN"]},
    {"name":"Decatur",      "seat":"Decaturville",  "phone":"731-852-3371","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=decatur&state=TN"]},
    {"name":"DeKalb",       "seat":"Smithville",    "phone":"615-597-4871","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=dekalb&state=TN"]},
    {"name":"Fentress",     "seat":"Jamestown",     "phone":"931-879-7812","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=fentress&state=TN"]},
    {"name":"Franklin",     "seat":"Winchester",    "phone":"931-967-2336","cm_phone":"","email":"","priority":"MEDIUM",
     "urls":["https://tennesseetrustee.org/index.php?entity=franklin&state=TN"]},
    {"name":"Grainger",     "seat":"Rutledge",      "phone":"865-828-3513","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=grainger&state=TN"]},
    {"name":"Grundy",       "seat":"Altamont",      "phone":"931-692-3368","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=grundy&state=TN"]},
    {"name":"Hancock",      "seat":"Sneedville",    "phone":"423-733-2454","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=hancock&state=TN"]},
    {"name":"Houston",      "seat":"Erin",          "phone":"931-289-3633","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=houston&state=TN"]},
    {"name":"Humphreys",    "seat":"Waverly",       "phone":"931-296-7671","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=humphreys&state=TN"]},
    {"name":"Johnson",      "seat":"Mountain City", "phone":"423-727-9012","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=johnson&state=TN"]},
    {"name":"Lake",         "seat":"Tiptonville",   "phone":"731-253-7582","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=lake&state=TN"]},
    {"name":"Lewis",        "seat":"Hohenwald",     "phone":"931-796-3052","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=lewis&state=TN"]},
    {"name":"Pickett",      "seat":"Byrdstown",     "phone":"931-864-3743","cm_phone":"","email":"","priority":"LOW",
     "urls":["https://tennesseetrustee.org/index.php?entity=pickett&state=TN"]},
]

# ── HELPERS ──────────────────────────────────────────────────────────────────

session = requests.Session()
session.headers.update(HEADERS)

def fetch_url(url, timeout=20, binary=False):
    try:
        r = session.get(url, timeout=timeout, allow_redirects=True)
        if binary:
            return r.content, r.status_code, r.headers.get("content-type","")
        return r.text, r.status_code, r.headers.get("content-type","")
    except Exception as e:
        return None, 0, str(e)

def find_delinquent_links(html, base_url):
    """Return list of (text, abs_url) for likely delinquent-tax links."""
    soup = BeautifulSoup(html, "html.parser")
    keywords = re.compile(
        r'(delinquent|tax.?sale|taxsale|foreclos|past.?due|tax.?list|tax.?auction)',
        re.I
    )
    ext_ok = re.compile(r'\.(pdf|csv|xlsx|xls|zip)(\?|$)', re.I)
    found = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        text = a.get_text(" ", strip=True)
        full = urljoin(base_url, href)
        if keywords.search(href) or keywords.search(text) or ext_ok.search(href):
            found.append((text[:120], full))
    return found

def extract_pdf_rows(pdf_bytes, county, seat, source_url):
    rows = []
    if not HAS_PDF:
        return rows
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                tables = page.extract_tables()
                for table in tables:
                    for row in table:
                        if not row:
                            continue
                        cells = [c.strip() if c else "" for c in row]
                        # skip all-empty rows or headers
                        if all(c == "" for c in cells):
                            continue
                        if len(cells) >= 2:
                            rows.append({
                                "county": county,
                                "state": STATE,
                                "county_seat": seat,
                                "parcel_number": cells[0] if len(cells)>0 else "",
                                "owner_name":    cells[1] if len(cells)>1 else "",
                                "property_address": cells[2] if len(cells)>2 else "",
                                "city":          cells[3] if len(cells)>3 else "",
                                "zip":           cells[4] if len(cells)>4 else "",
                                "amount_due":    cells[5] if len(cells)>5 else "",
                                "sale_date":     "",
                                "sale_number":   "",
                                "source_url":    source_url,
                                "date_scraped":  DATE_SCRAPED,
                                "notes":         "Parsed from PDF"
                            })
    except Exception as e:
        print(f"  PDF parse error: {e}")
    return rows

def extract_html_table_rows(html, county, seat, source_url):
    rows = []
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    for table in tables:
        trs = table.find_all("tr")
        # need at least 2 rows (header + 1 data)
        if len(trs) < 2:
            continue
        # get headers
        hdr = [th.get_text(" ", strip=True).lower() for th in trs[0].find_all(["th","td"])]
        # check if it looks relevant (has owner, parcel, amount, or address column)
        rel = any(k in " ".join(hdr) for k in ["owner","parcel","amount","address","name","tax"])
        if not rel and len(trs) < 5:
            continue
        for tr in trs[1:]:
            cells = [td.get_text(" ", strip=True) for td in tr.find_all(["td","th"])]
            if not cells or all(c=="" for c in cells):
                continue
            row = {
                "county": county,
                "state": STATE,
                "county_seat": seat,
                "parcel_number": "",
                "owner_name": "",
                "property_address": "",
                "city": "",
                "zip": "",
                "amount_due": "",
                "sale_date": "",
                "sale_number": "",
                "source_url": source_url,
                "date_scraped": DATE_SCRAPED,
                "notes": "Parsed from HTML table"
            }
            # try to map columns
            for i, h in enumerate(hdr):
                if i >= len(cells):
                    break
                v = cells[i]
                if "parcel" in h or "map" in h:
                    row["parcel_number"] = v
                elif "owner" in h or "name" in h:
                    row["owner_name"] = v
                elif "address" in h:
                    row["property_address"] = v
                elif "city" in h:
                    row["city"] = v
                elif "zip" in h:
                    row["zip"] = v
                elif "amount" in h or "tax" in h or "due" in h or "balance" in h:
                    row["amount_due"] = v
                elif "sale" in h and "date" in h:
                    row["sale_date"] = v
            # if no mapping worked, put first 3 cells in key fields
            if not row["owner_name"] and len(cells) >= 2:
                row["parcel_number"] = cells[0]
                row["owner_name"] = cells[1]
                if len(cells)>=3: row["property_address"] = cells[2]
                if len(cells)>=4: row["amount_due"] = cells[3]
            rows.append(row)
    return rows

def save_county_csv(county_name, rows):
    fname = os.path.join(OUTPUT_DIR, f"{county_name.upper().replace(' ','_')}_delinquent.csv")
    with open(fname, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=PROPERTY_COLS)
        w.writeheader()
        for r in rows:
            # fill missing keys with empty string
            row = {k: r.get(k,"") for k in PROPERTY_COLS}
            w.writerow(row)
    return fname

def append_to_master(rows, master_writer):
    for r in rows:
        row = {k: r.get(k,"") for k in PROPERTY_COLS}
        master_writer.writerow(row)

# ── SPECIAL-CASE SCRAPERS ────────────────────────────────────────────────────

def scrape_shelby(county):
    """Shelby: grab the tax sale page, find CSV download for Sale #2301."""
    print("  [Shelby] Loading tax sale schedule page...")
    html, code, ct = fetch_url(county["urls"][0])
    rows = []
    found_link = None
    if html and code == 200:
        soup = BeautifulSoup(html, "html.parser")
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(" ", strip=True)
            if re.search(r'(csv|download|2301|oct)', href+text, re.I):
                found_link = urljoin(county["urls"][0], href)
                print(f"  [Shelby] Found link: {found_link}")
                break
        # also look for direct CSV link patterns
        if not found_link:
            links = find_delinquent_links(html, county["urls"][0])
            for txt, url in links:
                print(f"    Link: {txt[:60]} -> {url[:80]}")
                if ".csv" in url.lower():
                    found_link = url
                    break

    if found_link:
        data, code2, ct2 = fetch_url(found_link, binary=True)
        if data and code2 == 200:
            if "csv" in ct2.lower() or found_link.lower().endswith(".csv"):
                text = data.decode("utf-8", errors="replace")
                reader = csv.reader(io.StringIO(text))
                header = next(reader, [])
                for line in reader:
                    if not line or all(c.strip()=="" for c in line):
                        continue
                    row = {
                        "county":"Shelby","state":STATE,"county_seat":"Memphis",
                        "parcel_number": line[0] if len(line)>0 else "",
                        "owner_name":    line[1] if len(line)>1 else "",
                        "property_address": line[2] if len(line)>2 else "",
                        "city":          line[3] if len(line)>3 else "",
                        "zip":           line[4] if len(line)>4 else "",
                        "amount_due":    line[5] if len(line)>5 else "",
                        "sale_date":     "2026-10-27",
                        "sale_number":   "2301",
                        "source_url":    found_link,
                        "date_scraped":  DATE_SCRAPED,
                        "notes":         "Sale #2301 Oct 27 2026"
                    }
                    rows.append(row)
                return rows, "SCRAPED", "CSV_DOWNLOAD", found_link, ""
            elif "pdf" in ct2.lower() or found_link.lower().endswith(".pdf"):
                r = extract_pdf_rows(data, "Shelby", "Memphis", found_link)
                return r, "PDF_DOWNLOADED", "PDF_PARSE", found_link, ""

    # If no direct link, return what we know
    if html and code == 200:
        links = find_delinquent_links(html, county["urls"][0])
        return [], "NO_LIST", f"Page loaded (HTTP {code}). No direct download found. Links: {[u for _,u in links[:3]]}", county["urls"][0], "Check page manually for CSV link"
    return [], "NO_SITE", f"HTTP {code}", county["urls"][0], "Verify URL or call"

def scrape_lawrence(county):
    """Lawrence: try direct PDF URL first."""
    pdf_url = county["urls"][0]
    print(f"  [Lawrence] Trying PDF: {pdf_url}")
    data, code, ct = fetch_url(pdf_url, binary=True)
    if data and code == 200 and (b"%PDF" in data[:10] or "pdf" in ct.lower()):
        rows = extract_pdf_rows(data, "Lawrence", "Lawrenceburg", pdf_url)
        if rows:
            return rows, "PDF_DOWNLOADED", "PDF_PARSE", pdf_url, ""
        return [], "PDF_DOWNLOADED", "PDF found but no tables extracted", pdf_url, "Manual review of PDF"

    # Try main site
    print(f"  [Lawrence] Trying main site...")
    html, code, ct = fetch_url(county["urls"][1])
    if html and code == 200:
        links = find_delinquent_links(html, county["urls"][1])
        for txt, url in links:
            if ".pdf" in url.lower():
                d, c2, ct2 = fetch_url(url, binary=True)
                if d and c2==200:
                    rows = extract_pdf_rows(d, "Lawrence", "Lawrenceburg", url)
                    if rows:
                        return rows, "PDF_DOWNLOADED", "PDF_PARSE", url, ""
                    return [], "PDF_DOWNLOADED", "PDF found, no tables", url, "Manual review"
        return [], "NO_LIST", "Site loaded, no PDF found", county["urls"][1], "Call trustee for updated PDF"
    return [], "NO_SITE", f"HTTP {code}", pdf_url, "Call trustee"

# ── GENERIC COUNTY SCRAPER ───────────────────────────────────────────────────

def scrape_generic(county):
    name = county["name"]
    seat = county["seat"]
    all_rows = []
    methods_tried = []
    found_url = ""

    for url in county["urls"]:
        print(f"  Trying: {url}")
        if "govease.com" in url or "zeusauction.com" in url:
            methods_tried.append(f"PORTAL:{url}")
            continue  # these require JS / login

        # Try fetching
        html, code, ct = fetch_url(url)
        if not html or code not in (200,):
            methods_tried.append(f"FAIL_{code}:{url}")
            time.sleep(1)
            continue

        methods_tried.append(f"HTTP_{code}:{url}")
        found_url = url

        ct_lower = ct.lower()
        # Got a PDF directly
        if "pdf" in ct_lower or (url.lower().endswith(".pdf") and html):
            data, _, _ = fetch_url(url, binary=True)
            if data:
                rows = extract_pdf_rows(data, name, seat, url)
                if rows:
                    return rows, "PDF_DOWNLOADED", "|".join(methods_tried), url, ""
                return [], "PDF_DOWNLOADED", "PDF no tables", url, "Manual PDF review"

        # HTML — search for links
        links = find_delinquent_links(html, url)
        if links:
            print(f"    Found {len(links)} delinquent-related links")

        for txt, link_url in links[:8]:
            print(f"    -> {txt[:50]} | {link_url[:70]}")
            lu = link_url.lower()
            if ".pdf" in lu:
                data, c2, _ = fetch_url(link_url, binary=True)
                if data and c2 == 200:
                    rows = extract_pdf_rows(data, name, seat, link_url)
                    if rows:
                        all_rows.extend(rows)
                        found_url = link_url
                        methods_tried.append(f"PDF_PARSED:{link_url}")
            elif ".csv" in lu or ".xlsx" in lu:
                data, c2, ct2 = fetch_url(link_url, binary=True)
                if data and c2 == 200:
                    if ".csv" in lu or "csv" in ct2.lower():
                        text = data.decode("utf-8", errors="replace")
                        reader = csv.reader(io.StringIO(text))
                        hdr = next(reader, [])
                        for line in reader:
                            if not any(c.strip() for c in line):
                                continue
                            row = {k:"" for k in PROPERTY_COLS}
                            row.update({"county":name,"state":STATE,"county_seat":seat,
                                        "source_url":link_url,"date_scraped":DATE_SCRAPED,
                                        "notes":"CSV download"})
                            if len(hdr) >= 2:
                                for i,h in enumerate(hdr):
                                    if i >= len(line): break
                                    hl = h.lower()
                                    if "parcel" in hl or "map" in hl: row["parcel_number"]=line[i]
                                    elif "owner" in hl or "name" in hl: row["owner_name"]=line[i]
                                    elif "address" in hl: row["property_address"]=line[i]
                                    elif "city" in hl: row["city"]=line[i]
                                    elif "zip" in hl: row["zip"]=line[i]
                                    elif "amount" in hl or "balance" in hl or "due" in hl: row["amount_due"]=line[i]
                            all_rows.append(row)
                        found_url = link_url
                        methods_tried.append(f"CSV_PARSED:{link_url}")
            else:
                # Follow the link (go 1 level deeper)
                h2, c2, _ = fetch_url(link_url)
                if h2 and c2==200:
                    rows2 = extract_html_table_rows(h2, name, seat, link_url)
                    if rows2:
                        all_rows.extend(rows2)
                        found_url = link_url
                        methods_tried.append(f"HTML_TABLE:{link_url}")
                time.sleep(0.5)

        # Try parsing tables on the main page
        if not all_rows:
            tbl_rows = extract_html_table_rows(html, name, seat, url)
            if tbl_rows:
                all_rows.extend(tbl_rows)
                methods_tried.append(f"HTML_TABLE_MAIN:{url}")

        # Check for Tennessee Trustee portal delinquent search
        if "tennesseetrustee.org" in url and html:
            if "delinquent" in html.lower() or "past due" in html.lower():
                methods_tried.append("TN_TRUSTEE_PORTAL_HAS_DELINQUENT")
            else:
                methods_tried.append("TN_TRUSTEE_PORTAL_NO_DELINQUENT")

        time.sleep(0.8)  # be polite

    if all_rows:
        status = "SCRAPED" if len(all_rows) > 5 else "PARTIAL"
        return all_rows, status, "|".join(methods_tried), found_url, ""

    # Nothing found
    if any("HTTP_200" in m for m in methods_tried):
        status = "NO_LIST"
        result = "Site reachable but no delinquent data found online"
        next_action = "Call trustee to request list"
    elif any("FAIL_" in m for m in methods_tried):
        status = "NO_SITE"
        result = "Site not reachable"
        next_action = "Verify URL or call trustee"
    else:
        status = "NO_SITE"
        result = "No URLs were accessible"
        next_action = "Call trustee"

    return [], status, "|".join(methods_tried)[:300], found_url, next_action

# ── MAIN RUNNER ──────────────────────────────────────────────────────────────

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    master_path = os.path.join(OUTPUT_DIR, "_ALL_COUNTIES_MERGED.csv")
    log_path    = os.path.join(OUTPUT_DIR, "_MASTER_LOG.csv")
    call_path   = os.path.join(OUTPUT_DIR, "_CALL_SHEET.csv")

    master_file = open(master_path, "w", newline="", encoding="utf-8")
    log_file    = open(log_path,    "w", newline="", encoding="utf-8")
    call_file   = open(call_path,   "w", newline="", encoding="utf-8")

    master_writer = csv.DictWriter(master_file, fieldnames=PROPERTY_COLS)
    log_writer    = csv.DictWriter(log_file,    fieldnames=LOG_COLS)
    call_writer   = csv.DictWriter(call_file,   fieldnames=CALL_COLS)

    master_writer.writeheader()
    log_writer.writeheader()
    call_writer.writeheader()

    # Counters
    counts = {"SCRAPED":0,"PDF_DOWNLOADED":0,"PARTIAL":0,"BLOCKED":0,
              "NO_LIST":0,"NO_SITE":0,"STALE":0}
    total_records = 0
    total_counties = len(COUNTIES)

    for i, county in enumerate(COUNTIES, 1):
        name = county["name"]
        seat = county["seat"]
        phone = county.get("phone","")
        cm_phone = county.get("cm_phone","")
        email = county.get("email","")
        priority = county.get("priority","MEDIUM")
        extra_notes = county.get("notes","")

        print(f"\n[{i}/{total_counties}] {name} County ({seat}) [{priority}]")

        # Knox is known stale
        if name == "Knox":
            status, method, result, file_saved, next_action = (
                "STALE", "KNOWN", "Tax Sale 25 completed June 2 2026. Watch for Tax Sale 26.",
                "", "Monitor https://trustee.knoxcounty.org/services/tax-sale for Tax Sale 26 announcement"
            )
            rows = []
        # Davidson - known complex
        elif name == "Davidson":
            print("  [Davidson] Trying TN Ledger and chancery court...")
            rows = []
            html, code, ct = fetch_url("https://chanceryclerkandmaster.nashville.gov/fees/property-tax-schedule/")
            method = f"HTTP_{code}"
            if html and code == 200:
                links = find_delinquent_links(html, "https://chanceryclerkandmaster.nashville.gov/")
                for txt, lurl in links[:5]:
                    print(f"    -> {txt[:50]} | {lurl[:70]}")
                    if ".pdf" in lurl.lower():
                        data, c2, _ = fetch_url(lurl, binary=True)
                        if data:
                            rows = extract_pdf_rows(data, name, seat, lurl)
                            if rows:
                                break
            if rows:
                status,result,next_action = "PDF_DOWNLOADED","PDF parsed from chancery court",""
                found_url = "https://chanceryclerkandmaster.nashville.gov/"
            else:
                status="NO_LIST"
                result="July 13 2026 sale active (published today June 19). List in TN Ledger newspaper."
                next_action="Call 615-862-6000 Chancery Clerk. Check tnledger.com for July 13 sale properties."
                found_url="https://chanceryclerkandmaster.nashville.gov/"
        elif name == "Shelby":
            rows, status, method, found_url, next_action = scrape_shelby(county)
            result = f"{len(rows)} records found"
        elif name == "Lawrence":
            rows, status, method, found_url, next_action = scrape_lawrence(county)
            result = f"{len(rows)} records found"
        else:
            rows, status, method, found_url, next_action = scrape_generic(county)
            result = f"{len(rows)} records found" if rows else method[:200]

        # Deduplicate rows by content hash
        seen = set()
        deduped = []
        for r in rows:
            h = hashlib.md5((r.get("owner_name","") + r.get("property_address","") + r.get("parcel_number","")).encode()).hexdigest()
            if h not in seen:
                seen.add(h)
                deduped.append(r)
        rows = deduped

        rec_count = len(rows)
        total_records += rec_count
        counts[status] = counts.get(status,0) + 1

        # Save per-county CSV
        file_saved = ""
        if rows:
            file_saved = save_county_csv(name, rows)
            append_to_master(rows, master_writer)
            print(f"  -> {status}: {rec_count} records -> {file_saved}")
        else:
            print(f"  -> {status}: 0 records")

        # Write log
        log_writer.writerow({
            "county": name,
            "status": status,
            "method_tried": method[:300] if method else "",
            "result": (result or "")[:300],
            "records_found": rec_count,
            "file_saved": file_saved,
            "trustee_phone": phone,
            "next_action": (next_action or extra_notes or "")[:300]
        })
        log_file.flush()

        # Write call sheet entry if no data
        if status in ("NO_LIST","NO_SITE","BLOCKED","STALE") or rec_count == 0:
            script = PHONE_SCRIPT.format(county=name)
            # add Carroll County note
            if name == "Carroll":
                script += " NOTE: I actually own land in Carroll County (Holladay TN) so this is a warm call."
            call_writer.writerow({
                "county": name,
                "county_seat": seat,
                "trustee_phone": phone,
                "clerk_master_phone": cm_phone,
                "email": email,
                "script": script,
                "priority": priority
            })
            call_file.flush()

        master_file.flush()
        time.sleep(0.3)  # brief pause between counties

    # Close files
    master_file.close()
    log_file.close()
    call_file.close()

    # ── SUMMARY ──────────────────────────────────────────────────────────────
    print("\n" + "="*60)
    print("TENNESSEE DELINQUENT TAX SCRAPING — SUMMARY")
    print("="*60)
    print(f"Total counties attempted:         {total_counties}")
    print(f"SCRAPED with data:                {counts.get('SCRAPED',0)}")
    print(f"PDF downloaded and parsed:        {counts.get('PDF_DOWNLOADED',0)}")
    print(f"Partial data:                     {counts.get('PARTIAL',0)}")
    print(f"Blocked:                          {counts.get('BLOCKED',0)}")
    print(f"No list found online:             {counts.get('NO_LIST',0)}")
    print(f"No site / site unreachable:       {counts.get('NO_SITE',0)}")
    print(f"Stale (pre-2025 or done sales):   {counts.get('STALE',0)}")
    print(f"Total properties found:           {total_records}")
    print(f"\nFiles saved in: {OUTPUT_DIR}/")
    print(f"  _ALL_COUNTIES_MERGED.csv  — all records")
    print(f"  _MASTER_LOG.csv           — county-by-county log")
    print(f"  _CALL_SHEET.csv           — counties needing phone calls")
    print(f"  {{COUNTY}}_delinquent.csv  — individual county files")
    print("="*60)

if __name__ == "__main__":
    main()
