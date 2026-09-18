"""The site's name rules, copied. Do not edit to fix a scanner problem.

COPIED FROM  MarboCreatives/recompete-radar  build_site.py
SITE COMMIT  d09109f6abf2fda7ac287692f99e434ec4659ed6
SOURCE FILE  SHA-256 247a5ac859fce784fd0bc3ab7ca7f8665f1302377de6130ef306f4ce5a888c92
COPIED ON    17 September 2026

Every definition below was lifted out of that file with ast.get_source_segment,
so it is what the site has rather than a retyping of it. The order is the order
they appear there.

ONE DELIBERATE DIFFERENCE, IN A DOCSTRING. The site's is_individual docstring
quotes three real suppliers' names as examples of rule 3 — sole traders who
registered under their own names, which these very rules withhold. This copy
leaves them out (CODING-STANDARDS 3: never write a withheld name anywhere) and
says so where they stood. drift.py compares code with docstrings removed, so
this changes no rule and no comparison. tests/test_vendor_copy.py fails if a
re-copy brings any such name back.

WHY A COPY AT ALL. MASTER-DESIGN rule 2 says a rule exists once. These rules
already exist once, in the site, and the scanner is a second program in a
second repository that cannot import them. The copy is the compromise, and
drift.py is what stops it being a fork: it reads build_site.py from the site's
main before every scan, parses both, and refuses to run if any rule below has
moved. The site's name rules DID change in September, in site PR #19, which is
why that check exists rather than being a precaution.

So: when this file and the site disagree, the site is right and the fix is to
re-copy, in a pull request, by re-running the extraction. Changing a word here
to make a scanner test pass would silently publish a name the site withholds.

WHAT IS NOT HERE. The site applies these rules to its own row dicts and then
renders pages. Only the rules travel. suppress_individuals IS here, because it
is the rule for HOW the two halves are applied together — blank the key and
substitute the label, never one without the other — and reimplementing that in
snapshot.py would be a second implementation of exactly the thing
MASTER-DESIGN rule 2 forbids.

VENDOR_ALLOWLIST IS A MODULE GLOBAL AND STARTS EMPTY, exactly as it does on the
site, where build_site.main() fills it. An empty allowlist suppresses MORE
names, not fewer, so forgetting to load it is safe for a person and wrong for a
company: RAYMOND CHABOT GRANT THORNTON would be withheld. snapshot.py loads it
and refuses to run if the file is missing, which is stricter than
load_vendor_allowlist's own "a missing file is not an error" — that is the
site's judgement for the site, and a silent difference in output is not one the
scanner can afford.
"""

from __future__ import annotations

import os
import re


PERSON_LABEL = "Individual supplier (name withheld)"


CORP_WORDS = frozenset("""
INC INCORPORATED LTD LTEE LIMITED LIMITEE LLP LLC LP ULC CORP CORPORATION CO COMPANY
COMPAGNIE SENC SENCRL SRL LDA ENR ENRG GMBH PLC AG SA SAS SARL NV BV PTY GROUP GROUPE
SERVICES SERVICE SOLUTIONS CONSULTING CONSULTANTS CONSULTANT TECHNOLOGIES TECHNOLOGY
SYSTEMS SYSTEMES ASSOCIATES ASSOCIES PARTNERS PARTNERSHIP HOLDINGS HOLDING ENTERPRISES
ENTREPRISES INDUSTRIES INTERNATIONAL UNIVERSITY UNIVERSITE COLLEGE INSTITUTE INSTITUT
SOCIETY SOCIETE ASSOCIATION FOUNDATION FONDATION TRUST BANK BANQUE SCHOOL ECOLE
HOSPITAL CENTRE CENTER AGENCY AGENCE CANADA CANADIAN NATIONAL NATIONALE CONSTRUCTION
ENGINEERING MARINE AVIATION LOGISTICS LOGISTIQUE MANAGEMENT MEDIA DESIGN STUDIO LABS
LABORATORY LABORATOIRES CLINIC CLINIQUE FARMS RANCH AUTO MOTORS EQUIPMENT SUPPLY
SUPPLIES PRODUCTS FOODS TRAVEL HOTEL RESORT PROPERTIES REALTY INSURANCE CAPITAL
VENTURES GLOBAL WORLDWIDE NETWORK NETWORKS DIGITAL SOFTWARE DATA SECURITY STAFFING
RECRUITMENT TRAINING ACADEMY PRESS PUBLISHING PRINTING TRANSPORT TRANSPORTATION
SHIPPING ENERGY POWER ELECTRIC ELECTRICAL MECHANICAL PLUMBING ROOFING LANDSCAPING
CLEANING MAINTENANCE REPAIR RENTAL LEASING IMPRIMERIE TRADUCTION TRANSLATION
INTERPRETATION DBA OPERATING GENERAL AND ET THE OF DES DU LA LE LES GOVERNMENT
GOUVERNEMENT MINISTRY MINISTERE BOARD COUNCIL CONSEIL COMMISSION OFFICE BUREAU
DEPARTMENT CITY VILLE TOWN MUNICIPALITY COUNTY REGION PROVINCE FIRST NATION NATIONS
BAND TRIBAL HEALTH SANTE LAW AVOCATS NOTAIRES ARCHITECTS ARCHITECTES SURVEYORS
ACCOUNTING ACCOUNTANTS CPA SONS BROS BROTHERS ENTERPRISE COOPERATIVE COOP
MUSEUM MUSEE GALLERY GALERIE THEATRE ORCHESTRA CHOIR LIBRARY BIBLIOTHEQUE
DEMENAGEMENT MOVING STORAGE ENTREPOSAGE WORKS WORKSHOP ATELIER COMPONENTS PARTS
INDUSTRIAL INDUSTRIEL READY MIX CONCRETE ASPHALT PAVING AGGREGATE QUARRY
TOOLS HARDWARE LUMBER TIMBER STEEL METALS WELDING FABRICATION MACHINE MACHINERY
FARM ORCHARD GREENHOUSE NURSERY GARDEN LANDSCAPE FORESTRY LOGGING
CATERING RESTAURANT CAFE BAKERY BREWERY DISTILLERY WINERY BISTRO CUISINE
PHARMACY PHARMACIE DENTAL OPTICAL VETERINARY THERAPY REHAB WELLNESS FITNESS
SALON SPA BARBER LAUNDRY JANITORIAL SANITATION DISPOSAL RECYCLING
TOWING GARAGE COLLISION TIRE TIRES FUEL PETROLEUM PETRO GAS PROPANE
SIGNS PRINTS GRAPHICS IMAGING PHOTO VIDEO FILMS PRODUCTIONS ENTERTAINMENT
SPORTS ATHLETIC RECREATION ARENA STADIUM CLUB LODGE CAMP OUTFITTERS ADVENTURE
AIRLINES AIRWAYS AIRPORT HELICOPTERS CHARTERS FREIGHT COURIER DELIVERY MOVERS
VENTURES EQUITY FUND FUNDS INVESTMENTS ADVISORY ADVISORS BROKERAGE
PLUS PRO EXPRESS DIRECT PRIME ELITE PREMIER SUPERIOR UNITED ALLIED ALLIANCE
NORTHERN SOUTHERN EASTERN WESTERN ATLANTIC PACIFIC COMMISSIONNAIRES
REGROUPEMENT CONCIERGERIE TOURISM AUTHORITY HTO AEC INDIGENOUS METIS INUIT
""".split())


GIVEN_NAMES = frozenset("""
james john robert michael william david richard joseph thomas charles christopher
daniel matthew anthony mark donald steven paul andrew joshua kenneth kevin brian
george timothy ronald jason edward jeffrey ryan jacob gary nicholas eric stephen
jonathan larry justin scott brandon benjamin samuel frank gregory raymond alexander
patrick jack dennis jerry tyler aaron jose adam nathan henry douglas peter zachary
kyle walter ethan jeremy harold keith christian roger noah gerald carl terry sean
austin arthur lawrence jesse dylan bryan joe jordan billy bruce albert willie gabriel
logan alan juan wayne roy ralph randy eugene vincent russell elmer louis philip
johnny mary patricia jennifer linda elizabeth barbara susan jessica sarah karen nancy
lisa margaret betty sandra ashley dorothy kimberly emily donna michelle carol amanda
melissa deborah stephanie rebecca laura sharon cynthia kathleen amy shirley angela
helen anna brenda pamela nicole ruth katherine samantha christine emma catherine
debra virginia rachel carolyn janet maria heather diane julie joyce victoria kelly
christina joan evelyn lauren judith megan cheryl andrea hannah martha jacqueline
frances gloria ann teresa kathryn sara janice jean alice madison doris abigail julia
judy grace denise amber marilyn danielle beverly charlotte natalie theresa diana
brittany kayla alexis lori marie jeanne pascale olivier pierre jacques michel andre
francois luc marc claude gilles yves serge alain sylvain martin nathalie sylvie
isabelle chantal manon lucie helene johanne josee guylaine genevieve veronique
stephane mathieu simon etienne benoit denis jean-pierre marie-claude
greg gregg tom tommy bob bobby dave davey mike mikey jim jimmy bill billy steve
rob robbie dan danny tony ed eddie ted teddy sam sammy ben benny nick nicky
chris matt andy joe joey pat ken kenny ron ronnie jamie rick ricky tim timmy
jack jake jeff josh kate katie kathy liz beth maggie meg molly sally sue tina
val vicky wendy cindy sandy jenny jess abby josie rosie cathy connie bonnie
kirsten kirsty anders lars nils bjorn erik erika ingrid soren jorgen
darcy declan cormac niamh siobhan aoife eamon padraig fergus rory brendan
armand bertrand francine ghislain gaetan raynald normand fernand adrien
lucien marcel gaston edouard hubert laurent thierry remi cedric fabrice andree
sable roxanne shauna sheena kendra kelsey brooke paige sierra jenna leah
miles milo malcolm murray magnus duncan angus lachlan ewan callum blair
priya priyanka raj rajesh rajiv ravi ramesh suresh sunil anil vijay vikram amit
sanjay deepak manish rahul arun ashok mohan krishna gopal hari shiv arjun karan
rohit nikhil ajay akash aditya siddharth neha pooja anjali kavita meera geeta
rekha shweta divya swati nisha ritu asha usha lata sunita anita seema veena
subarno subrata sourav sanjeev pankaj gaurav abhishek prashant vivek naveen
mohammed muhammad mohamed ahmed ahmad ali hassan hussein hussain omar khaled
khalid tariq yasser samir karim rashid mahmoud mustafa ibrahim ismail youssef
yusuf hamed hamid nasser fadi ziad bilal imad wael nabil adel hisham riad
ghaida fatima fatema aisha ayesha layla leila noor nour huda mona rania dina
yasmin yasmine amira hala samira nadia soraya farah rima maha lina zeinab asad
soheil fariha wei ming jian jun feng lei tao hui ying mei jing ling
seo hyun joon sung dong hae eun yong chul kyung soo woo chih
hiroshi takashi kenji yuki akira satoshi taro naoko yumiko keiko kazuo noriko
kwame kofi ama adwoa amara chidi ngozi olu ade tunde sipho thabo nkechi obi
emeka chinwe uche ifeoma bongani lerato mandla zanele chukwuemeka mawusi dumenu
vladimir dmitri dmitry sergei sergey ivan boris oleg nikolai alexei aleksei
mikhail yuri anton pavel andrei andrey natasha olga svetlana tatiana irina
ludmila katya anya galina nina larisa vera zoya pylypuk
garen aram vartan hagop sarkis armen ani lusine anahit tigran levon
anibal alberto jose carlos luis miguel rafael fernando ricardo eduardo
alejandro javier sergio diego pablo gonzalo mateo santiago rodrigo ignacio
isabella sofia camila valentina lucia elena rosa carmen pilar mercedes veronica
dimitri dimitrios nikos yannis kostas stavros eleni vasilis christos
minh thanh hoang tuan hung linh trang mai lan phuong quang duc binh
ewa agnieszka malgorzata krzysztof wojciech grzegorz jacek marek piotr tomasz
zoltan attila laszlo istvan gabor tibor csaba bela ferenc katalin erzsebet
johanna madeleine bernadette suzanne tanya marlene violette taffot
lorne wade rene renee trevor vanessa marcel gilles yvon normand
serge sylvain stephane florent fernand adrien armand aurele benoit clement
edmond emile etienne fabien gaetan gaston germain gerard gilbert guillaume hugo
jocelyn laurent lucien mathieu maurice olivier pascal patrice raoul regis remi
roch rosaire sebastien thierry vincent yves alana amber ashley brenda carla
carmen cheryl colleen connie corinne dana danielle darlene dawn debra dianne
doreen dorothy elaine erin evelyn gail ginette glenda gloria heather holly
irene jacqueline jamie janice joyce krista lana leanne lindsay lorna lynda
lyne lynne marlene melody meredith micheline monique nadine nancy noel odette
pamela pauline peggy penny phyllis ramona rhonda rita roberta robin rochelle
rosemarie roxanne sandra shanna shauna shawna shelby sheri sherri sherry sonia
sonja tammy tanya tara teresa theresa tonya tracie trina trisha valerie vera
verna vicki vickie wanda wendy whitney yolanda yvette yvonne alvin arnold barry
bernie blaine blair blake brad braden brady brendan brent brock bruce bryce
byron calvin cameron carl carlton carson casey cecil cedric chad chandler chase
chester clark claude clay clayton cliff clifford clint clyde cody colby cole
colin conrad cooper craig curtis cyril dale dallas dalton damon dane darin
darnell darrel darrell darren darrin darryl daryl dave dean delbert denis
dennis derek derrick desmond devin devon dewayne dwayne dwight dylan earl eddie
edgar edmund edwin elbert eldon elias elliot ellis elmer emerson emmett erik
ernest errol ervin ethan eugene evan everett felix fletcher floyd forrest
foster frank franklin fred freddie freeman gabe galen garnet garrett garry
garth gavin gene geoffrey gerald gerry gil glen glenn gordon grady graham gregg
gregory griffin gus guy hal hank harlan harley harold harris harrison harry
hartley harvey hayden heath hector henry herb herbert herman hollis homer
horace howard hubert hugh hunter ian ira irvin irving isaac isaiah ivan jack
jackson jarrod jarvis jasper javier jay jed jeff jerald jeremiah jeremy jerome
jerry jesse jessie jim jimmy joel joey johnnie johnny jonas jonathan jordan
josiah jude julian julius justin kane karl keaton keith kelvin ken kendall
kendrick kenny kent kerry kip kirby kirk kurt kyle lamar lamont lance landon
lane larry laverne lawrence layne leland lemuel leon leonard leroy lester levi
lewis liam lincoln lindsey lionel lloyd logan lon loren louie louis lowell
lucas luke luther lyle lyman mack malcolm marc marcus mario marion marlin
marlon marshall martin marty marvin mason mathias maynard mckinley mel melvin
merle merlin merrill micah mick mickey miguel mike miles milford millard milo
milton mitch mitchell monroe monte morgan morris morton moses murphy myles
myron nate nathan nathaniel neal ned neil nelson newton nick noah nolan norbert
norman norris oliver ollie omar oren orion orlando orville oscar otis otto owen
parker pat patrick percy perry pete peter phil philip pierce preston quentin
quincy quinn rafael ralph ramon randal randall randolph randy raul ray raymond
reed reese reggie reginald reid reuben rex ricardo rich richie rick rickey
ricky riley rob robbie rocco rocky rod roderick rodger rodney rogelio roger
roland rolland roman romeo ron ronnie rory roscoe ross rowan roy royce rudolph
rudy rufus rupert russ russell rusty ruben ryder sam sammy samuel sanford saul
scott seamus sean seth seymour shane shannon shaun shawn sheldon sherman
sherwood sid sidney silas simon sol solomon spencer stan stanford stanley
stefan stewart stuart sylvester tanner ted terence terrance terrell terrence
terry thad theo theodore thurman tim titus tobias toby tod todd tom tommy tony
travis trent trenton trey tristan troy truman tucker turner tyler tyrone tyson
val vance vaughn vern vernon victor vince virgil wallace wally walt walter ward
warren waylon wayne webster weldon wendell wes wesley weston wilbert wilbur
wiley wilfred wilfrid will willard willis wilmer wilson winston woodrow wyatt
xavier zachary zane zeke
""".split())


VENDOR_ALLOWLIST: set[str] = set()


NAME_PARTICLES = frozenset("LA LE LES DES DU".split())


TITLE_WORDS = frozenset("CHIEF DR DRE MR MRS MS MME MLLE PROF REV SIR HON "
                        "CAPT MAJ COL SGT LT CMDR".split())


def _has_corporate_word(toks: list[str]) -> bool:
    """True when a token marks this name as an organisation.

    A NAME_PARTICLES token counts only in first position; see that set.
    """
    for i, t in enumerate(toks):
        u = t.upper()
        if u not in CORP_WORDS:
            continue
        if u in NAME_PARTICLES and i > 0:
            continue
        return True
    return False


def _without_titles(toks: list[str]) -> list[str]:
    """The tokens after any leading titles. Never returns an empty list."""
    i = 0
    while i < len(toks) - 1 and toks[i].upper().rstrip(".") in TITLE_WORDS:
        i += 1
    return toks[i:]


def _name_tokens(name: str) -> list[str]:
    return [t for t in re.split(r"[^A-Za-z\u00C0-\u024F'\u2019-]+", name or "") if t]


def _norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip()).lower()


def load_vendor_allowlist(path: str) -> set[str]:
    """One name per line, # starts a comment. Missing file is not an error."""
    out: set[str] = set()
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.split("#", 1)[0].strip()
                if line:
                    out.add(_norm_name(line))
    return out


def is_individual(name: str) -> bool:
    """True when a published vendor name is a private person, not an organisation.

    Two rules, both measured against the full live vendor list before being used:

    1. "SURNAME, Given" with EXACTLY ONE comma and one or two tokens on each side.
       935 matches. The one-comma limit is what keeps multi-partner law firms out;
       without it, three surnames in a row read as a person.
    2. A two or three word name with no comma, containing a common given name.
       411 matches. Weaker, hence the allowlist.
    3. A LONGER name that opens with a given name and carries no corporate word
       anywhere. This is the sole trader who registered under their own name and
       then described the work. The site's copy of this docstring gives three
       real examples here; this copy leaves them out, because they are names
       these rules withhold (CODING-STANDARDS 3). Rule 2's three-token ceiling misses every one of them, and the
       trailing description is in whatever language the vendor registered in, so
       CORP_WORDS will never cover it.

       Measured against all 12,899 live vendor names: 32 additional matches, of
       which 31 are natural people. The single false positive is the accounting
       firm RAYMOND CHABOT GRANT THORNTON, which is in vendor_allowlist.txt.
       That is the trade suppress_individuals already describes — withholding a
       company name costs a reader one label, missing one exposes a person.

    A rule matching any 2-3 word name WITHOUT the given-name test was tried and
    rejected: it swept up 1,740 names including plain companies. Do not add it.
    Rule 3 is NOT that rule: it keeps the given-name test and only relaxes the
    length ceiling.
    """
    n = (name or "").strip()
    if not n or any(ch.isdigit() for ch in n):
        return False
    toks = _name_tokens(n)
    if not toks or _has_corporate_word(toks):
        return False
    if n.count(",") == 1:
        left, right = (p.strip() for p in n.split(","))
        lt, rt = _name_tokens(left), _name_tokens(right)
        if 1 <= len(lt) <= 2 and 1 <= len(rt) <= 2:
            return True
    core = _without_titles(toks)
    if "," not in n and 2 <= len(core) <= 3:
        if any(t.lower() in GIVEN_NAMES for t in core):
            return True
    if len(core) >= 4 and core[0].lower() in GIVEN_NAMES:
        return True
    return False


def is_person_shaped(name: str) -> bool:
    """Looser than is_individual: any name that COULD belong to a person.

    Used for ONE thing — deciding whether a group may have a URL fragment.
    is_individual decides what is published and is deliberately conservative,
    because withholding a real company's name costs the reader something. An
    anchor costs the reader nothing: without one the row still appears, with
    its value and contract count, exactly as it did before anchors existed.

    So the trade here is the opposite way round. A fragment is a permanent,
    linkable, shareable pointer at one named party, which is what hard rule 8
    exists to prevent. Being wrong in this direction costs a company an anchor.
    Being wrong in the other direction puts a private person's name in a URL.

    No given-name test on purpose. That test is what lets non-Anglo names
    through, because no word list covers every given name on earth.
    """
    n = (name or "").strip()
    if not n or any(ch.isdigit() for ch in n):
        return False
    toks = _name_tokens(n)
    if not toks or _has_corporate_word(toks):
        return False
    if n.count(",") == 1:
        return True
    return 2 <= len(_without_titles(toks)) <= 3


def suppress_individuals(rows: list[dict]) -> int:
    """Withhold the names of vendors who are private people.

    The contract stays in EVERY total - department, category, province, value and
    bidder counts are all untouched. Only the displayed name changes. Blanking
    vendor_key is enough to stop a page or an index entry being made, because
    group() skips empty keys and entity_link() falls back to plain text. The
    published tender reference stays visible, so the public record is traceable.

    The list of suppressed names is deliberately NOT written to a file, an
    artifact or the build log. That list IS the personal information. Workflow
    artifacts and Actions logs on a public repo are readable by anyone, which is
    exactly how buyer_name leaked before. Only the count is reported.
    """
    n = 0
    for r in rows:
        name = r.get("vendor_name") or ""
        if _norm_name(name) in VENDOR_ALLOWLIST:
            continue
        if is_individual(name):
            r["vendor_name"] = PERSON_LABEL
            r["vendor_key"] = ""
            n += 1
    return n
