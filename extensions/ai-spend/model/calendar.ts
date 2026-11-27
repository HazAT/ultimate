export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

const pad = (value: number) => String(value).padStart(2, '0')

export const dayKey = (at: number) => {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export const hourKey = (at: number) => pad(new Date(at).getHours())

export const startOfDay = (at: number) => {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export const addDays = (at: number, days: number) => {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime()
}

export const shiftDays = (at: number, days: number) => {
  const date = new Date(at)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

export const startOfWeek = (at: number) => {
  const day = startOfDay(at)
  return addDays(day, -((new Date(day).getDay() + 6) % 7))
}

export const startOfHour = (at: number) => {
  const local = at - new Date(at).getTimezoneOffset() * 60_000
  return at - (((local % HOUR_MS) + HOUR_MS) % HOUR_MS)
}
