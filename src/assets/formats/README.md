# Client sheet formats

What the client sees, one folder per media type.

A bus sheet says *Display Charges Per Bus*; an auto sheet says *Rate per Auto*
and carries a *Union Charges* column no other medium has. That difference is
the format, and it lives here as data rather than in the renderer.

```
assets/formats/
  format_index.json              media type on the master -> folder
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
  radio/
    fm_radio/        Radio.xlsx            format.json
  _reference/                              older sheets, kept for comparison
```

Every media type on `assets/masters/transitmaster.xlsx` has a folder, so no
brief can land on a medium the renderer has no format for.

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

**`<Label>.xlsx`** is the blank sheet in EP house style, cut from the same spec:
maroon header band, the logo, the T&C sheet for that medium and a case study
sheet. This is what the desk sends when a plan is put together by hand.

## Changing a client sheet

Edit `format.json` — rename a column, reorder, drop one — and the next plan
comes out that way. Nothing in `app/` needs touching. Then run

```
py -3 scripts/build_formats.py
```

to cut the blank templates again from the edited specs. Add `--force` and the
script overwrites the specs too, from the definitions inside it.

## Where the columns came from

Auto, bus, cab, metro and the premium train sampling sheet are the sheets the EP
desk actually sends. Cab and metro came off the Imprexive Marketing proposal in
`_reference`, which also carries a second bus sample. The rest were built from
the pricing shape the master carries for that medium: what is priced per unit,
whether months are billed, and which attributes the desk has to state. Each
`format.json` records which of the two it is in its `source` field.

Cab and metro do not quote the same way, and the sheets show it. Cab is quoted
all in — one *Offer Rate (Including Printing & Mounting) for per Cab for 1
month* and a duration beside it — so there is no separate printing column.
Metro splits *Display Cost - 1 Month* from *Printing & Mounting*, because on
metro the mounting is a large enough number that the client is shown it.

## Terms and case studies

The T&C sheet is not written here. It is generated from `data/terms.json`
against the `terms_key` in the spec, so the same wording reaches the template,
the generated plan and the PDF. Only lines under `approved` ever reach a client;
`pending` lines show on the internal sheet until someone at EP signs them off.

Case study sheets carry the brand, objective, solution and result. Campaign
photographs go in by hand before a plan goes out.
