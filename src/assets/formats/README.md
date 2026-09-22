# Client sheet formats

What the client sees, one folder per media type.

A bus sheet says *Display Charges Per Bus*; an auto sheet says *Rate per Auto*
and carries a *Union Charges* column no other medium has. That difference is
the format, and it lives here as data rather than in the renderer.

```
assets/formats/
  format_index.json              media type -> folder
  transit/
    auto/            Auto.xlsx             format.json
    bus/             Bus.xlsx              format.json
    cab/             Cab.xlsx              format.json
    metro_train/     Metro.xlsx            format.json
    premium_train/   Premium Train.xlsx    format.json
                     Premium Train - Sampling.xlsx
    passenger_train/ Passenger Train.xlsx  format.json
    toy_train/       Toy Train.xlsx        format.json
    e_rickshaw/      E Rickshaw.xlsx       format.json
    tricycle/        Tricycle.xlsx         format.json
    mobile_van/      Mobile Van.xlsx       format.json
    decks/           Airport Plan.pptx, Transit Plan.pptx
  radio/
    fm_radio/        Radio.xlsx            format.json
  tv/
    television/      Television.xlsx       format.json
  cinema/
    cinema/          Cinema.xlsx           format.json
  outdoor/
    hoarding/        Outdoor.xlsx          format.json
    decks/           Execution PPT Outdoor.pptx, Outdoor OOH Deck 2.pptx
  print/
    newspaper/       Newspaper.xlsx        format.json
    magazine/        Magazine.xlsx         format.json
  digital/
    Digital Plan.xlsx                      one workbook, five client sheets
    Digital PR.xlsx                        one workbook, two client sheets
    meta_ads/ youtube/ google_business/ in_app/ digital_sampling/
    digital_pr/ pr/                        format.json only, template above
    influencer/      Influencer.xlsx       format.json
    press_conference/ Press Conference.xlsx format.json
  btl/
    balloon/ corporate_activity/ corporate_digital_screens/
    society_digital_screens/ dealer_board/ leaflet_d2d/ leaflet_insertion/
    no_parking/ traffic_barricade/ wall_painting/
```

Every media type the EP desk sells has a folder, so no brief can land on a
medium the renderer has no format for. Transit and radio are the two families
the master database covers; the rest are registered from the desk's own
workbooks and their plan lines are filled in by hand until a master exists.

Where one workbook holds several client sheets — the digital plan carries Meta,
YouTube, Google Store, in-app and sampling — the workbook sits at the family
root and each medium's spec points at it with `template_sheet`.

`decks/` holds the pptx formats: airport, transit and the two outdoor decks.
They carry no column spec, so they are listed under `decks` in the index rather
than as media types, and the desk fills them by hand.

## The two files in each folder

**`format.json`** is what the service reads. The columns, in the order the
client sees them, each one naming the plan field that fills it:

```json
{ "header": "Rate per Auto", "field": "rate", "type": "money", "width": 14 }
```

`type` is `text`, `int`, `money`, `money2` (two decimals, radio rates) or `sr`
(the serial number). A column can carry a `note` saying where the value comes
from when the master does not hold it.

Fields the plan line does not carry — a train number, the name a train is known
by — resolve to an empty cell on purpose. The column stays on the sheet and the
desk fills it before the plan goes out.

These fields are worked out rather than read off the line:

| Field | What it is |
|---|---|
| `sr` | the row number |
| `addon_per_unit` | printing, mounting or union charges, divided down to per unit, because the engine costs them as one lump per line |
| `rate_all_in` | the rate plus `addon_per_unit`: the *Charges Per Bus Per Month* column, and the cab *Offer Rate (Including Printing & Mounting)* |
| `metro_line` | the line, off the price option, so "Delhi Metro - Line 3&4 Exterior Wrap" fills the Line column with *Line 3&4*. Blank where the master does not name one |
| `package` | the same price option with the city and the line taken off, leaving *Exterior Wrap* for the Media Package column |
| `duration` | 7, 15 or 30 days, for the media the master prices by duration rather than by month |

`rate` is not quite a straight read either. Where a minimum billing or a
quantity floor lifted a line, the master rate no longer multiplies out to the
cost on the same row, and a client sheet that does not add up gets queried, so
the sheet shows what the cost divides down to. Every other line shows the master
rate untouched, and the note column still says the minimum billing was applied.

**`<Label>.xlsx`** is the desk's own workbook for that medium, in EP house
style: maroon header band, the logo, the T&C sheet and a case study sheet, and
usually a sample quotation still in the rows. This is what the desk sends when a
plan is put together by hand, and it is the sheet `format.json` was cut from.

## Changing a client sheet

Edit `format.json` — rename a column, reorder, drop one — and the next plan
comes out that way. Nothing in `src/render/` needs touching; a field the plan
line does not carry renders as an empty cell rather than an error.

The templates are the desk's workbooks, not generated artefacts. Re-cut a spec
from its template when the desk sends a new version of the sheet; never
overwrite the template from the spec, or the T&C, case study and sample rows go
with it.

## Where the columns came from

Every `format.json` is cut from the header row of the workbook in its folder,
and names that workbook and sheet in its `source` field. Widths come off the
same sheet, so a generated plan and a hand-made one line up column for column.

Where a header is not reproduced verbatim the column carries a `note` saying
what the source sheet calls it. That happens where the desk's sheet carries a
working note in the header (auto's *Approx impressions - give formula (type)*),
a plain misspelling (*Teir*, *Estd. Frequecy*, *Impressioms/ order*), or the
same header twice on one sheet (in-app's second *Ad Type*, now *Ad Format*;
the D2D leaflet's second *Cost*, now *Cost per Leaflet*).

Cab and metro do not quote the same way, and the sheets show it. Cab is quoted
all in — one *Offer Rate (Including Printing & Mounting) for per Cab for 1
month* and a duration beside it — so there is no separate printing column.
Metro splits *Display Cost - 30 Days* from *Printing & Mounting*, because on
metro the mounting is a large enough number that the client is shown it.

## Terms and case studies

The T&C sheet is not written here. It is generated from the rules tree against
the `terms_key` in the spec, so the same wording reaches the template, the
generated plan and the PDF. Only lines under `approved` ever reach a client;
`pending` lines show on the internal sheet until someone at EP signs them off.

Terms do not inherit down the tree — each medium's list is complete in its own
rules file, because concatenating a parent's would put mobile van clauses on an
auto sheet. A clause that fixes a validity date sits under `pending`, holding
the desk's own wording, until someone re-dates it.

Case study sheets carry the brand, objective, solution and result. Campaign
photographs go in by hand before a plan goes out.
