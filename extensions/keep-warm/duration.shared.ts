export const duration = (ms: number) => {
  const minutes = Math.round(ms / 30_000) / 2
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
}
