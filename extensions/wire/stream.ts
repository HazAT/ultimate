type Event = { name: string; data: string }

export function events(stream: string): Event[] {
  return stream
    .split(/\r?\n\r?\n/u)
    .map((chunk) => {
      const lines = chunk.split(/\r?\n/u)
      const name =
        lines
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim() ?? 'message'
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      return { name, data }
    })
    .filter((event) => event.data || event.name !== 'message')
}

export function runs(list: Event[]) {
  const out: { name: string; events: Event[] }[] = []
  for (const event of list) {
    const last = out.at(-1)
    if (last?.name === event.name) last.events.push(event)
    else out.push({ name: event.name, events: [event] })
  }
  return out
}

export type { Event }
