# @permitzip/bim-pack-development

MutinyBIM's Development add-on (round 11). What the owner plans and assumes before anything
is drawn:

- **Program area** (`development.program_area`): a use and its gross area, and the share of
  it that earns rent.
- **Deal assumption** (`development.deal_assumption`): vacancy, cap rate and soft cost as
  shares stored on the record; rent, operating cost and cost per m² as rates in the reader's
  own price list. No record holds money.
- **Pro forma** (`development.pro_forma` calc): net operating income, value at the cap rate,
  hard and total cost, margin and yield on cost, worked in the reader's process from the
  records, the model's quantities and the reader's price list. Nothing is stored.

Each input's confidence is the kernel's one basis (`readBasis`); the pro forma lists every
record it read so a screen can show it. Built only through the add-on contract. Apache-2.0.
