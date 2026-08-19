/**
 * Generates a CSV for manual and end-to-end testing.
 *
 *   npm run gen:csv -- 200 fixtures/employees-200.csv
 *
 * Every tenth row is deliberately broken so a run exercises the failure paths:
 * a bad date, a duplicate email, a missing field, a rejected email,
 * and emails that trigger the mock's flaky behaviour.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const count = Number(process.argv[2] ?? 100)
const target = process.argv[3] ?? `fixtures/employees-${count}.csv`

const lines = ['name,email,start_date,country']

for (let i = 0; i < count; i++) {
  const n = i + 1
  switch (i % 10) {
    case 3:
      lines.push(`Bad Date ${n},baddate${n}@x.com,31/02/2026,SG`)
      break
    case 5:
      lines.push(`Dupe ${n},duplicate@x.com,01/03/2026,SG`)
      break
    case 7:
      lines.push(`No Country ${n},nocountry${n}@x.com,01/03/2026,`)
      break
    case 8:
      lines.push(`Rejected ${n},reject${n}@x.com,01/03/2026,France`)
      break
    case 9:
      lines.push(`Flaky ${n},flaky${n}@x.com,01/03/2026,VN`)
      break
    default:
      lines.push(`Person ${n},person${n}@x.com,0${(i % 9) + 1}/03/2026,SG`)
  }
}

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
console.log(`wrote ${count} rows to ${target}`)
