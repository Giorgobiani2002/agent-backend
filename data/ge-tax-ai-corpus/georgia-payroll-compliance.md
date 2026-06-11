# Georgian Payroll Compliance for Declario

This control note grounds payroll calculation and rs.ge filing behavior. It is
not a substitute for the current consolidated legislation. Legal conclusions
must prefer the live Matsne text when a conflict exists.

## Authoritative Sources

1. Tax Code of Georgia, especially Articles 81, 101, 153 and 154:
   https://matsne.gov.ge/en/document/view/1043717
2. Law of Georgia on Funded Pensions, especially Article 3 and Article 6:
   https://matsne.gov.ge/en/document/view/4280127
3. Revenue Service portal and published electronic services:
   https://www.rs.ge/
   https://services.rs.ge/WayBillService/WayBillService.asmx

## Ordinary Salary Calculation

For an ordinary Georgian-resident employee without a specific statutory
exemption:

- Income tax is 20% of taxable salary.
- An employee participating in the funded pension scheme contributes 2% of
  taxable salary.
- The employer contributes another 2% of taxable salary.
- The State contribution is governed by the funded-pension law and is not an
  employer payroll liability in Declario's salary journal.

The employee's mandatory 2% funded-pension contribution does not reduce the
salary income-tax base. For gross salary of GEL 1,000:

- Income tax: GEL 200.
- Employee pension: GEL 20.
- Net salary: GEL 780.
- Employer pension: GEL 20.
- Employer cost: GEL 1,020.

## Exceptions and Review Rules

Do not apply the ordinary formula blindly when any of these are present:

- A Tax Code exemption or reduced-tax regime.
- Non-resident employment facts.
- Benefits in kind or employer-paid personal expenses.
- More than one employer where a personal allowance or exemption may depend on
  annual totals.
- Missing personal number, gross amount, payment period, or pension status.
- Corrections to an already submitted payroll declaration.

When such facts exist, lower confidence and require accountant review.

## Filing Deadline and Workflow

Under the Tax Code, a person withholding tax at source generally files the
monthly return by the 15th day of the month following the reporting month.
Declario should calculate the concrete due date in the tax calendar and account
for statutory deadline shifts where applicable.

Declario's published rs.ge SOAP integrations cover waybills, invoices and
taxpayer data. No payroll-declaration operation appears in those published
service surfaces, so payroll filing currently uses the recorded rs.ge browser
playbook. This is an inference from the published service catalog, not a claim
that Revenue Service can never expose another interface.

Chat filing must be two-phase:

1. Prepare the payroll run and show the exact period, employee count, totals and
   warnings.
2. After explicit user approval, dispatch `rs.ge.payroll-declaration` in
   `halt-on-dangerous` mode so the form is filled but the final irreversible
   submit remains under human control.

Never claim that payroll is filed merely because the browser run was queued or
dispatched. Report the actual runtime status and receipt when available.
